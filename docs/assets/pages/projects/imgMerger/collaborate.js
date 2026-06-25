// Pure PeerJS collaboration — no y-webrtc, no external signaling server.
//
// Topology: star (hub-and-spoke).
//   Host claims a deterministic PeerJS ID derived from the room code.
//   Guests connect to that ID.
//   Host rebroadcasts every message to all other peers.
//
// Protocol messages (JSON strings over reliable data channel):
//   { type: 'cursor',                id, x, y, name, color }
//   { type: 'cursor-leave',          id }
//   { type: 'settings',              settings }
//   { type: 'rank-order',            order }
//   { type: 'positions',             positions }
//   { type: 'drag',                  imgIdx, x, y, angle, scale? }
//   { type: 'grab',                  imgIdx, color }
//   { type: 'release',               imgIdx }
//   { type: 'image-binary',          id, name, w, h, polygons, simPos, simAngle } + binary ArrayBuffer (next message)
//   { type: 'image',                 ...imagePacketFields }   (legacy string add; superseded by image-binary)
//   { type: 'image-removed',         imgIdx }
//   { type: 'encoding',              imgName, encoding }
//   { type: 'polygon',               imgIdx, polygons }
//   { type: 'viewport',              scale, offsetX, offsetY }   (presenter -> followers)
//   --- streaming join protocol ---
//   { type: 'session-meta',          imageCount, outW, outH, ..., images[] }
//   { type: 'image-thumb',           imgIdx, thumb }
//   { type: 'session-thumbs-done',  total }
//   { type: 'image-full-binary',      imgIdx, name, w, h, polygons, ... } + binary ArrayBuffer (next message)
//   { type: 'image-full',            imgIdx, name, w, h, jpegBase64, polygons, ... }  (legacy / rebroadcast)
//   { type: 'session-host-progress', sent, total }
//   { type: 'session-done' }
//   (encodings skipped on join — guest encodes locally; new ones arrive via live 'encoding' messages)
//   --- heartbeat ---
//   { type: 'ping' }                    (host -> guest, every PING_INTERVAL ms)
//   { type: 'pong' }                    (guest -> host, in response to ping)
//   --- legacy ZIP join (kept for backward compat, no longer sent) ---
//   { type: 'session-start', totalBytes }
//   [ArrayBuffer chunks...]
//   { type: 'session-end' }
//   --- shared metadata (Yjs CRDT) ---
//   { type: 'ydoc-update',           update }   base64 Yjs update; host relays; idempotent

import * as Y from "./vendor/yjs.mjs";

// ── Shared metadata document (CRDT) ───────────────────────────────────────────
// Metadata that multiple peers edit concurrently lives in a Yjs document so it
// converges to one consistent state without a central authority -- no last-writer
// races. Large binary (image bytes) stays OUT of the doc and rides the content-
// addressed asset pull; thumbnails + encodings are derived/sync separately. Updates
// ride the existing PeerJS data channels (this is the transport "provider").
const ydoc = new Y.Doc();
window.ydoc = ydoc; // exposed for the app's observers + tests
const ySettings = ydoc.getMap("settings"); // outW/outH/slides/fillColor/blendMode/seed/ditherExp/simX1..Y2
const yRank = ydoc.getArray("rankOrder"); // image stacking order (array of ids)
const yPoly = ydoc.getMap("polygons"); // id -> polygon list (mask)
const yScales = ydoc.getMap("scales"); // id -> scale (null = auto)
const yImages = ydoc.getMap("images"); // id -> per-image membership meta (name,w,h,assetHash,...); BYTES are NOT here -- pulled by assetHash

function _encU(u) {
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
function _decU(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// Local doc changes -> peers. Remote-applied changes carry origin "remote" and are
// relayed (in handleMsg), not re-broadcast here, so there is no echo loop.
ydoc.on("update", (update, origin) => {
  if (origin === "remote") return;
  if (!localPeerId) return;
  broadcast({ type: "ydoc-update", update: _encU(update) });
});

// Send our whole doc state to a connection (join / reconnect convergence).
function _sendDocState(conn) {
  if (conn && conn.open) {
    const str = JSON.stringify({ type: "ydoc-update", update: _encU(Y.encodeStateAsUpdate(ydoc)) });
    _dbg("tx", "ydoc-state", str.length);
    conn.send(str);
  }
}

// Remote settings changes -> apply to local UI. Local writes (origin "local") are
// skipped; applyRemoteSettings self-guards against re-broadcasting.
ySettings.observe((event, transaction) => {
  if (transaction.origin !== "remote") return;
  if (window.applyRemoteSettings) window.applyRemoteSettings(ySettings.toJSON());
});

yRank.observe((event, transaction) => {
  if (transaction.origin !== "remote") return;
  if (window.applyRemoteRankOrder) window.applyRemoteRankOrder(yRank.toArray());
});

yPoly.observe((event, transaction) => {
  if (transaction.origin !== "remote") return;
  for (const id of event.keysChanged) {
    window.dispatchEvent(new CustomEvent("collab:remote-polygon", { detail: { imgIdx: id, polygons: yPoly.get(id) } }));
  }
});

yScales.observe((event, transaction) => {
  if (transaction.origin !== "remote") return;
  window.dispatchEvent(new CustomEvent("collab:remote-scales", { detail: { scales: yScales.toJSON() } }));
});

// Membership: the image list lives in the doc. A remote add/remove reconciles local
// state to the doc (building skeletons / dropping images), applying each new image's
// polygons + scale from the doc at build time -- so a mask that arrived before its
// image is no longer lost (the old drop-on-missing bug). Bytes are pulled by assetHash
// via the content-addressed asset layer, never streamed through the doc.
function _membershipSnapshot() {
  return { images: yImages.toJSON(), order: yRank.toArray(), polygons: yPoly.toJSON(), scales: yScales.toJSON() };
}
yImages.observe((event, transaction) => {
  if (transaction.origin !== "remote") return;
  if (window.applyRemoteMembership) window.applyRemoteMembership(_membershipSnapshot());
});

// ── Constants ─────────────────────────────────────────────────────────────────

const PING_INTERVAL = 3000; // ms between host pings to each guest
const PING_TIMEOUT = 20000; // ms without a pong before host drops the guest. Generous so a
// momentarily pegged phone (decoding a 12MP photo, GC pause) isn't dropped, which would
// trigger a costly reconnect + session re-sync

const COLORS = ["#e05252", "#4a9eed", "#52c97a", "#e0a033", "#9b6be0", "#30b5be", "#e0709a", "#8fbe4a"];
const STORAGE_NAME_KEY = "collab-name";
const CHUNK_SIZE = 64 * 1024;
const SIM_UNDO_MAX = 50;
const HOST_PREFIX = "im-mrg-"; // prefix for deterministic host peer IDs

// ── Sync debug ────────────────────────────────────────────────────────────────
// Opt-in (?syncdbg=1 or localStorage syncdbg=1) on-screen tally of what crosses the
// data channels, by message type and direction, so live traffic can be diagnosed by
// just using the app. Off by default and zero-cost (the counters short-circuit).
const _sync = { on: false, tx: { bytes: 0, msgs: {} }, rx: { bytes: 0, msgs: {} } };
window._sync = _sync;
function _dbg(dir, type, bytes) {
  if (!_sync.on) return;
  const side = _sync[dir];
  side.bytes += bytes;
  const m = side.msgs[type] || (side.msgs[type] = { count: 0, bytes: 0 });
  m.count++;
  m.bytes += bytes;
}

function _fmtBytes(b) {
  if (b >= 1048576) return (b / 1048576).toFixed(2) + "MB";
  if (b >= 1024) return (b / 1024).toFixed(1) + "KB";
  return Math.round(b) + "B";
}

// Fixed overlay listing live per-type send/recv rates so the user can see exactly what
// crosses the wire while using the app. Enable with ?syncdbg=1 or localStorage syncdbg=1.
function _initSyncDebug() {
  const params = new URLSearchParams(location.search);
  if (!params.has("syncdbg") && localStorage.getItem("syncdbg") !== "1") return;
  _sync.on = true;
  const el = document.createElement("div");
  el.id = "sync-dbg";
  el.style.cssText =
    "position:fixed;left:6px;top:6px;z-index:99999;max-width:64vw;font:11px/1.3 monospace;" +
    "background:rgba(0,0,0,.82);color:#3f8;padding:6px 8px;border-radius:6px;white-space:pre;" +
    "pointer-events:none;max-height:62vh;overflow:hidden";
  document.body.appendChild(el);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const deltas = (cur, old) =>
    Object.keys(cur)
      .map((t) => ({ t, dc: cur[t].count - (old[t] ? old[t].count : 0), db: cur[t].bytes - (old[t] ? old[t].bytes : 0) }))
      .filter((x) => x.dc > 0)
      .sort((a, b) => b.db - a.db);
  let prev = { t: performance.now(), tx: 0, rx: 0, txM: {}, rxM: {} };
  setInterval(() => {
    const now = performance.now();
    const dt = (now - prev.t) / 1000 || 1;
    const rate = (b) => _fmtBytes(b / dt) + "/s";
    const lines = ["SYNC " + (isHost ? "host" : localPeerId ? "guest" : "off") + "  up " + rate(_sync.tx.bytes - prev.tx) + "  dn " + rate(_sync.rx.bytes - prev.rx)];
    for (const d of deltas(_sync.tx.msgs, prev.txM).slice(0, 6)) lines.push(" ^ " + d.t + "  x" + d.dc + "  " + _fmtBytes(d.db));
    for (const d of deltas(_sync.rx.msgs, prev.rxM).slice(0, 6)) lines.push(" v " + d.t + "  x" + d.dc + "  " + _fmtBytes(d.db));
    lines.push("tot up " + _fmtBytes(_sync.tx.bytes) + "  dn " + _fmtBytes(_sync.rx.bytes));
    el.textContent = lines.join("\n");
    prev = { t: now, tx: _sync.tx.bytes, rx: _sync.rx.bytes, txM: clone(_sync.tx.msgs), rxM: clone(_sync.rx.msgs) };
  }, 800);
}
_initSyncDebug();

// ── DOM ───────────────────────────────────────────────────────────────────────

const modal = document.getElementById("collab-modal");
const qrContainer = document.getElementById("collab-qr");
const btnCollab = document.getElementById("btn-collab");
const btnClose = document.getElementById("btn-collab-close");
const btnJoin = document.getElementById("btn-collab-join");
const btnLeave = document.getElementById("btn-collab-leave");
const btnPresent = document.getElementById("btn-collab-present");
const btnCopy = document.getElementById("btn-collab-copy");
const btnUndo = document.getElementById("btn-sim-undo");
const btnRedo = document.getElementById("btn-sim-redo");
const simUndoBadge = document.getElementById("sim-undo-badge");
const simRedoBadge = document.getElementById("sim-redo-badge");
const nameInp = document.getElementById("collab-name-inp");
const roomInp = document.getElementById("collab-room-inp");
const passInp = document.getElementById("collab-pass-inp");
const roleEl = document.getElementById("collab-role");
const statusEl = document.getElementById("collab-status");
const cursorLayer = document.getElementById("collab-cursor-layer");
const guestPrompt = document.getElementById("collab-guest-prompt");
const guestMsg = document.getElementById("collab-guest-msg");
const progressBar = document.getElementById("collab-progress-bar");
const simCanvasEl = document.getElementById("sim-canvas");
const sendProgressEl = document.getElementById("collab-send-progress");
const sendMsgEl = document.getElementById("collab-send-msg");
const sendBarEl = document.getElementById("collab-send-bar");
const recvProgressEl = document.getElementById("collab-recv-progress");
const recvMsgEl = document.getElementById("collab-recv-msg");
const recvBarEl = document.getElementById("collab-recv-bar");

// ── Runtime state ─────────────────────────────────────────────────────────────

let peer = null;
let localPeerId = null;
let isHost = false;
let currentRoom = null;
let hostConn = null; // guest's single connection to host
let remotePeerCount = 0; // count broadcast by host; used on guest side
const guestConns = new Map(); // host's connections: peerId -> conn

// ── Cursor state ──────────────────────────────────────────────────────────────

let rafId = null;
const peerEls = new Map(); // peerId -> { el, label }
const remoteCursors = new Map(); // peerId -> { x, y, name, color }

// ── Sim undo + grab tracking ──────────────────────────────────────────────────

const simUndoStack = [];
const simRedoStack = [];
const grabbedByPeer = new Map(); // imgIdx -> peerId (for cleanup on disconnect)

// ── Heartbeat state ───────────────────────────────────────────────────────────

const _guestLastPong = new Map(); // host: peerId -> timestamp of last pong received
let _hostPingTimer = null;
let _reconnectTimer = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLocalColor() {
  if (!getLocalColor._c) getLocalColor._c = COLORS[Math.floor(Math.random() * COLORS.length)];
  return getLocalColor._c;
}

function randomRoomCode() {
  return Math.random().toString(36).slice(2, 9);
}

function getRoomParam() {
  return new URLSearchParams(window.location.search).get("room");
}

function setRoomParam(code) {
  const u = new URL(window.location.href);
  u.searchParams.set("room", code);
  window.history.replaceState(null, "", u.toString());
}

function hostIdFor(roomCode) {
  return HOST_PREFIX + roomCode;
}

function worldToClient(physX, physY) {
  return window.imViewport.worldToClient(physX, physY);
}

function _updateQR() {
  if (typeof QRCode === "undefined") return;
  qrContainer.innerHTML = "";
  // Only show the QR once we've actually joined (become host/guest). Showing it earlier
  // means a scan could claim this room's host id before the local user does.
  if (!localPeerId) return;
  const code = roomInp.value.trim();
  if (!code) return;
  const u = new URL(window.location.href);
  u.searchParams.set("room", code);
  new QRCode(qrContainer, {
    text: u.toString(),
    width: 160,
    height: 160,
    colorDark: "#1a1b1c",
    colorLight: "#f0f0f0",
    correctLevel: QRCode.CorrectLevel.M,
  });
}

function setStatus(text, connected) {
  statusEl.textContent = text;
  statusEl.classList.toggle("im-collab-connected", !!connected);
}

// Show the local user's role (Host / Guest) clearly in the modal header.
function _setRole() {
  if (!roleEl) return;
  if (!localPeerId) {
    roleEl.classList.add("im-hidden");
    return;
  }
  roleEl.textContent = isHost ? "Host" : "Guest";
  roleEl.classList.toggle("im-collab-role-host", isHost);
  roleEl.classList.toggle("im-collab-role-guest", !isHost);
  roleEl.classList.remove("im-hidden");
}

const collabPeerBadge = document.getElementById("collab-peer-badge");

function _broadcastPeerCount() {
  if (!isHost) return;
  const msg = JSON.stringify({ type: "peer-count", count: guestConns.size });
  for (const conn of guestConns.values()) {
    if (conn.open) conn.send(msg);
  }
}

function updatePeerCount() {
  const count = isHost ? guestConns.size : hostConn ? remotePeerCount : 0;
  let text;
  if (isHost) {
    text = count === 0 ? "Hosting - waiting for guests" : `Hosting - ${count} guest${count > 1 ? "s" : ""} connected`;
  } else {
    text = count === 0 ? "Connected as guest" : `Connected as guest - ${count} other${count > 1 ? "s" : ""}`;
  }
  setStatus(text, true);
  if (count > 0) {
    collabPeerBadge.textContent = count > 9 ? "9+" : count;
    collabPeerBadge.classList.remove("im-hidden");
  } else {
    collabPeerBadge.classList.add("im-hidden");
  }
  window.dispatchEvent(new CustomEvent("collab:peer-count", { detail: { count } }));
}

// ── Guest prompt ──────────────────────────────────────────────────────────────

function showGuestPrompt(msg) {
  guestPrompt.classList.remove("im-hidden");
  guestMsg.textContent = msg;
}

function hideGuestPrompt() {
  guestPrompt.classList.add("im-hidden");
  progressBar.style.width = "0%";
}

function updateProgress(pct) {
  progressBar.style.width = Math.round(pct) + "%";
}

function showSendProgress(msg, pct) {
  sendProgressEl.classList.remove("im-hidden");
  sendMsgEl.textContent = msg;
  sendBarEl.style.width = Math.round(pct) + "%";
}
function hideSendProgress() {
  sendProgressEl.classList.add("im-hidden");
  sendBarEl.style.width = "0%";
}

function showRecvProgress(msg, pct) {
  recvProgressEl.classList.remove("im-hidden");
  recvMsgEl.textContent = msg;
  recvBarEl.style.width = Math.round(pct) + "%";
}
function hideRecvProgress() {
  recvProgressEl.classList.add("im-hidden");
  recvBarEl.style.width = "0%";
}

// Drive the editor's sim-status pill (owned by imageMerge.js) for collab progress that
// must stay visible while the modal is closed -- e.g. live image-upload sync.
function _setSyncStatus(text) {
  window.dispatchEvent(new CustomEvent("collab:sync-status", { detail: { text } }));
}

// ── Cursor DOM ────────────────────────────────────────────────────────────────

function makeCursorSVG(color) {
  return `<svg width="18" height="22" viewBox="0 0 18 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 2L14 10L8 11L11 19L8.5 20L5.5 12L2 16V2Z" fill="${color}" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>
  </svg>`;
}

function upsertCursorEl(peerId, cursorState) {
  let entry = peerEls.get(peerId);
  if (!entry) {
    const el = document.createElement("div");
    el.className = "collab-cursor";
    el.innerHTML = makeCursorSVG(cursorState.color);
    const label = document.createElement("div");
    label.className = "collab-cursor-label";
    el.appendChild(label);
    cursorLayer.appendChild(el);
    entry = { el, label, path: el.querySelector("svg path") };
    peerEls.set(peerId, entry);
  }
  const name = cursorState.name || "Anonymous";
  if (entry.label.textContent !== name) entry.label.textContent = name;
  if (entry.label.style.background !== cursorState.color) entry.label.style.background = cursorState.color;
  if (entry.path.getAttribute("fill") !== cursorState.color) entry.path.setAttribute("fill", cursorState.color);
  return entry.el;
}

function removeCursorEl(peerId) {
  const entry = peerEls.get(peerId);
  if (entry) {
    entry.el.remove();
    peerEls.delete(peerId);
  }
  remoteCursors.delete(peerId);
}

// ── RAF loop ──────────────────────────────────────────────────────────────────

function rafLoop() {
  if (remoteCursors.size === 0) {
    rafId = null;
    return;
  }
  for (const [peerId, cursor] of remoteCursors) {
    const el = upsertCursorEl(peerId, cursor);
    const pos = worldToClient(cursor.x, cursor.y);
    el.style.transform = `translate(${pos.x}px,${pos.y}px)`;
  }
  rafId = requestAnimationFrame(rafLoop);
}

// ── Cursor broadcast ──────────────────────────────────────────────────────────

function onMouseMove(e) {
  if (!localPeerId || !window.imViewport) return;
  const phys = window.imViewport.canvasToWorld(e.clientX, e.clientY);
  broadcast({
    type: "cursor",
    id: localPeerId,
    x: phys.x,
    y: phys.y,
    name: nameInp.value.trim() || "Anonymous",
    color: getLocalColor(),
  });
}

// ── Broadcast ─────────────────────────────────────────────────────────────────

// Send a JSON message to all connected peers.
// On host: send to all guests.
// On guest: send to host (who will rebroadcast).
function broadcast(msg, excludePeerId) {
  const str = JSON.stringify(msg);
  _dbg("tx", msg.type, str.length);
  if (isHost) {
    for (const [pid, conn] of guestConns) {
      if (pid !== excludePeerId && conn.open) conn.send(str);
    }
  } else if (hostConn && hostConn.open) {
    hostConn.send(str);
  }
}

// ── Message handler (shared by host and guest) ────────────────────────────────

function handleMsg(msg, fromPeerId) {
  switch (msg.type) {
    case "cursor":
      remoteCursors.set(msg.id, { x: msg.x, y: msg.y, name: msg.name, color: msg.color });
      if (!rafId) rafId = requestAnimationFrame(rafLoop);
      if (isHost) broadcast(msg, fromPeerId); // rebroadcast
      break;

    case "cursor-leave":
      removeCursorEl(msg.id);
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "settings":
      if (window.applyRemoteSettings) window.applyRemoteSettings(msg.settings);
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "ydoc-update":
      Y.applyUpdate(ydoc, _decU(msg.update), "remote");
      if (isHost) broadcast(msg, fromPeerId); // relay to the other guests (idempotent)
      break;

    case "rank-order":
      if (window.applyRemoteRankOrder) window.applyRemoteRankOrder(msg.order);
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "positions":
      window.dispatchEvent(
        new CustomEvent("collab:remote-positions", {
          detail: { positions: msg.positions, simX1: msg.simX1, simY1: msg.simY1, simX2: msg.simX2, simY2: msg.simY2 },
        }),
      );
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "drag":
      window.dispatchEvent(
        new CustomEvent("collab:remote-drag", {
          detail: { imgIdx: msg.imgIdx, x: msg.x, y: msg.y, angle: msg.angle, scale: msg.scale },
        }),
      );
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "grab":
      grabbedByPeer.set(msg.imgIdx, fromPeerId);
      window.dispatchEvent(
        new CustomEvent("collab:remote-grab", {
          detail: { imgIdx: msg.imgIdx, color: msg.color },
        }),
      );
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "release":
      grabbedByPeer.delete(msg.imgIdx);
      window.dispatchEvent(new CustomEvent("collab:remote-release", { detail: { imgIdx: msg.imgIdx } }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "image":
      window.dispatchEvent(new CustomEvent("collab:remote-image", { detail: msg }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "image-removed":
      window.dispatchEvent(new CustomEvent("collab:remote-image-removed", { detail: { imgIdx: msg.imgIdx } }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "polygon":
      window.dispatchEvent(
        new CustomEvent("collab:remote-polygon", {
          detail: { imgIdx: msg.imgIdx, polygons: msg.polygons },
        }),
      );
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "viewport":
      window.dispatchEvent(
        new CustomEvent("collab:remote-viewport", {
          detail: { scale: msg.scale, centerX: msg.centerX, centerY: msg.centerY },
        }),
      );
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "scales":
      window.dispatchEvent(new CustomEvent("collab:remote-scales", { detail: { scales: msg.scales } }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "asset-request":
      _serveAsset(msg.hash, fromPeerId, msg.offset || 0);
      break;

    case "session-meta":
      window.dispatchEvent(new CustomEvent("collab:remote-session-meta", { detail: msg }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "image-thumb":
      window.dispatchEvent(
        new CustomEvent("collab:remote-image-thumb", {
          detail: { imgIdx: msg.imgIdx, thumb: msg.thumb },
        }),
      );
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "image-full":
      window.dispatchEvent(new CustomEvent("collab:remote-image-full", { detail: msg }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "session-thumbs-done":
      if (!isHost) {
        hideGuestPrompt();
        showRecvProgress("Receiving images... 0/" + msg.total, 0);
      }
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case "session-host-progress":
      if (!isHost) showRecvProgress("Receiving images... " + msg.sent + "/" + msg.total, (msg.sent / msg.total) * 100);
      break;

    case "session-done":
      if (!isHost) hideRecvProgress();
      break;

    case "peer-count":
      if (!isHost) {
        remotePeerCount = msg.count;
        updatePeerCount();
      }
      break;

    case "ping":
      if (!isHost && hostConn && hostConn.open) {
        const pong = JSON.stringify({ type: "pong" });
        _dbg("tx", "pong", pong.length);
        hostConn.send(pong);
      }
      break;

    case "pong":
      if (isHost) _guestLastPong.set(fromPeerId, Date.now());
      break;

    case "join":
      // Guest -> host handshake. Validate against the room password, read live so
      // the host can set or change it any time; a wrong-password guest is dropped.
      if (isHost) {
        const conn = guestConns.get(fromPeerId);
        const pw = passInp ? passInp.value.trim() : "";
        if (pw && msg.password !== pw) {
          if (conn && conn.open) conn.send(JSON.stringify({ type: "auth-failed" }));
          _dropGuest(fromPeerId);
        } else if (conn) {
          const cs = window.getCollabState ? window.getCollabState() : null;
          // Only blast the session (meta + every thumbnail) to a guest that has nothing.
          // A reconnecting guest that already holds images skips it: the doc state below
          // conveys membership, and any genuinely-missing image is pulled by hash (its
          // thumbnail is rebuilt from the pulled bytes). This stops a reconnect storm from
          // re-sending all thumbnails on every reconnect -- the background-traffic bug.
          if (cs && cs.imageCount > 0 && !msg.have) sendSessionTo(conn);
          _sendDocState(conn); // converge shared metadata (settings, ...) with the joiner
        }
      }
      break;

    case "auth-failed":
      if (!isHost) {
        leaveRoom();
        setStatus("Wrong room password - try again");
      }
      break;
  }
}

// ── Data connection setup ─────────────────────────────────────────────────────

function setupConn(conn, isGuestSide) {
  let receiving = null; // legacy ZIP receive state
  let pendingImageMeta = null; // header for an incoming chunked binary; collects its slices

  // A chunked binary is fully received; reassemble its slices and hand off. `kind`
  // distinguishes pulled content-addressed bytes ('asset'), a live add that appends a new
  // image ('add'), and a join re-stream that fills an existing skeleton ('full').
  function finalizeBinary(meta) {
    const buf = _concatParts(meta.parts);
    const blobUrl = URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
    if (meta.kind === "asset") {
      // The app stores the bytes by hash and fills any image waiting on them. No relay:
      // a still-missing peer re-requests on its retry timer.
      window.dispatchEvent(new CustomEvent("collab:remote-asset", { detail: { hash: meta.hash, jpegBase64: blobUrl } }));
    } else if (meta.kind === "add") {
      const { kind, parts, got, bytes, ...m } = meta;
      window.dispatchEvent(new CustomEvent("collab:remote-image-binary", { detail: { imgIdx: m.id, jpegBase64: blobUrl, ...m } }));
      if (isHost) _forwardImageBinary(m, buf, conn.peer); // relay to the other guests
    } else {
      const { kind, parts, got, bytes, imgIdx, ...imgMeta } = meta;
      handleMsg({ type: "image-full", imgIdx, jpegBase64: blobUrl, ...imgMeta }, conn.peer);
    }
  }

  conn.on("data", (data) => {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const buf = ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
      _lastAssetRxAt = Date.now(); // bulk is actively arriving -> gate asset re-requests
      _dbg("rx", "bin:" + (pendingImageMeta ? pendingImageMeta.kind : receiving ? "session" : "?"), buf.byteLength);
      if (pendingImageMeta !== null) {
        if (pendingImageMeta.kind === "skip") {
          // Dropping a misaligned / duplicate transfer's bytes until its declared end.
          pendingImageMeta.remaining -= buf.byteLength;
          if (pendingImageMeta.remaining <= 0) pendingImageMeta = null;
          return;
        }
        // Asset slices accumulate in the persistent partial (`ref`); add/full use the
        // per-connection meta itself. Legacy single-shot headers omit `bytes`.
        const store = pendingImageMeta.ref || pendingImageMeta;
        store.parts.push(buf);
        store.got += buf.byteLength;
        if (pendingImageMeta.bytes != null && store.got < pendingImageMeta.bytes) return;
        const meta = pendingImageMeta;
        pendingImageMeta = null;
        if (meta.kind === "asset") {
          _assetPartials.delete(meta.hash);
          finalizeBinary({ kind: "asset", hash: meta.hash, parts: meta.ref.parts });
        } else {
          finalizeBinary(meta);
        }
      } else if (receiving) {
        receiving.chunks.push(buf);
        const got = receiving.chunks.reduce((s, c) => s + c.byteLength, 0);
        updateProgress(Math.round((got / receiving.totalBytes) * 100));
      }
      return;
    }
    if (typeof data !== "string") return;
    const msg = JSON.parse(data);
    _dbg("rx", msg.type, data.length);

    if (msg.type === "image-full-binary") {
      // Header for the join re-stream binary that follows (populates a skeleton)
      pendingImageMeta = {
        kind: "full",
        parts: [],
        got: 0,
        bytes: msg.bytes,
        imgIdx: msg.imgIdx,
        name: msg.name,
        w: msg.w,
        h: msg.h,
        polygons: msg.polygons,
        currentPoly: msg.currentPoly,
        scale: msg.scale,
        scaleFixed: msg.scaleFixed,
        simHidden: msg.simHidden,
        simPos: msg.simPos,
        simAngle: msg.simAngle,
      };
    } else if (msg.type === "image-binary") {
      // Header for a live-add binary that follows (appends a new image). Show the
      // skeleton now -- the bytes land in the next message and fill it; if they stall,
      // the assetHash on the skeleton lets the asset reconcile pull them later.
      const meta = { id: msg.id, assetHash: msg.assetHash, name: msg.name, w: msg.w, h: msg.h, polygons: msg.polygons, simPos: msg.simPos, simAngle: msg.simAngle };
      pendingImageMeta = { kind: "add", parts: [], got: 0, bytes: msg.bytes, ...meta };
      window.dispatchEvent(new CustomEvent("collab:remote-image-skeleton", { detail: meta }));
    } else if (msg.type === "asset-binary") {
      // Header for content-addressed asset bytes that follow (pull response). Slices land
      // in a persistent partial so a dropped transfer resumes from `got` on the re-request.
      const off = msg.offset || 0;
      let p = _assetPartials.get(msg.hash);
      if (p && p.owner && p.owner !== conn) {
        // Another connection is already filling this hash (relay duplicate) -> drop this one.
        pendingImageMeta = { kind: "skip", remaining: msg.bytes - off };
      } else if (p && off === p.got) {
        p.owner = conn; // resume where we left off
        p.bytes = msg.bytes;
        pendingImageMeta = { kind: "asset", hash: msg.hash, ref: p, bytes: msg.bytes };
      } else if (off === 0) {
        p = { parts: [], got: 0, bytes: msg.bytes, owner: conn }; // fresh transfer
        _assetPartials.set(msg.hash, p);
        pendingImageMeta = { kind: "asset", hash: msg.hash, ref: p, bytes: msg.bytes };
      } else {
        // Offset we can't splice onto what we hold -> drop it and restart clean next pull.
        if (p) { p.parts = []; p.got = 0; p.owner = null; }
        pendingImageMeta = { kind: "skip", remaining: msg.bytes - off };
      }
    } else if (msg.type === "session-start") {
      receiving = { chunks: [], totalBytes: msg.totalBytes };
      showGuestPrompt("Receiving session...");
    } else if (msg.type === "session-end") {
      if (receiving) {
        const blob = new Blob(receiving.chunks, { type: "application/zip" });
        receiving = null;
        hideGuestPrompt();
        window.dispatchEvent(new CustomEvent("collab:remote-session", { detail: { blob } }));
      }
    } else {
      handleMsg(msg, conn.peer);
    }
  });

  conn.on("close", () => {
    // Release any resumable transfers this connection owned so a re-pull (from any peer)
    // can continue them; the received bytes so far are kept for the resume.
    for (const p of _assetPartials.values()) if (p.owner === conn) p.owner = null;
    if (isGuestSide) {
      _dropGuest(conn.peer);
    } else {
      hostConn = null;
      remotePeerCount = 0;
      setStatus("Disconnected from host");
      _scheduleReconnect();
    }
  });

  conn.on("error", (err) => console.warn("[collab] conn error:", err));
}

// ── Heartbeat helpers ─────────────────────────────────────────────────────────

function _dropGuest(peerId) {
  const conn = guestConns.get(peerId);
  if (conn) {
    try {
      conn.close();
    } catch (_) {}
  }
  guestConns.delete(peerId);
  _guestLastPong.delete(peerId);
  removeCursorEl(peerId);
  for (const [imgIdx, pid] of grabbedByPeer) {
    if (pid === peerId) {
      grabbedByPeer.delete(imgIdx);
      window.dispatchEvent(new CustomEvent("collab:remote-release", { detail: { imgIdx } }));
    }
  }
  updatePeerCount();
  _broadcastPeerCount();
}

function _startHostPing() {
  clearInterval(_hostPingTimer);
  _hostPingTimer = setInterval(() => {
    if (!isHost) return;
    const now = Date.now();
    const ping = JSON.stringify({ type: "ping" });
    const toDrop = [];
    for (const [peerId, conn] of guestConns) {
      const last = _guestLastPong.get(peerId) || 0;
      if (now - last > PING_TIMEOUT) {
        toDrop.push(peerId);
        continue;
      }
      if (conn.open) {
        conn.send(ping);
        _dbg("tx", "ping", ping.length);
      }
    }
    for (const peerId of toDrop) _dropGuest(peerId);
  }, PING_INTERVAL);
}

function _scheduleReconnect() {
  clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(() => {
    if (!currentRoom || isHost) return;
    if (peer && !peer.destroyed) {
      try {
        peer.destroy();
      } catch (_) {}
    }
    peer = null;
    localPeerId = null;
    hostConn = null;
    remotePeerCount = 0;
    joinAsGuest(currentRoom);
  }, 2000);
}

// ── Streaming session send ────────────────────────────────────────────────────

const DRAIN_HIGH = 256 * 1024; // bytes buffered before we throttle; also bounds how much
// bulk sits ahead of a heartbeat pong queued mid-transfer
const DRAIN_TIMEOUT = 20000; // ms; a channel stuck this long is treated as dead, not slow
// (binary sends are sliced into CHUNK_SIZE pieces -- declared up top -- so a ping/pong
// interleaves between slices instead of waiting behind a whole multi-MB image)

// Wait for the send buffer to drain. Returns false if the connection closed or stayed
// backed up past the timeout (a stalled mobile uplink). Callers MUST stop on false --
// the old unconditional loop spun forever on a dead channel and froze the whole upload
// at "Sending 1/N" with nothing delivered.
async function _waitDrain(conn) {
  const dc = conn.dataChannel;
  if (!dc) return conn.open;
  const start = Date.now();
  while (dc.bufferedAmount > DRAIN_HIGH) {
    if (!conn.open) return false;
    if (Date.now() - start > DRAIN_TIMEOUT) return false;
    await new Promise((r) => setTimeout(r, 30));
  }
  return conn.open;
}

// Per-connection serialized send queue. A binary transfer is a header followed by its
// byte slices; two transfers MUST NOT interleave on one connection or the receiver
// (which accumulates slices against the current header) would mix one image's bytes into
// another -- cross-wiring images. Serializing per connection keeps each header->slices
// transfer atomic on the wire. (This is why uploading many images at once scrambled
// thumbnails: many asset sends raced on one channel.) Heartbeat ping/pong are sent
// outside this queue, so they still interleave between slices -- that is the point.
const _sendChains = new WeakMap(); // conn -> Promise (tail of its serialized chain)

// Resume support: received asset slices accumulate here keyed by content hash, persisting
// across connection drops. A re-request carries the current `got` as its offset, so the
// sender resumes from there instead of restarting at byte 0. `owner` is the connection
// currently filling a partial, so a duplicate serve from another peer (relay) is dropped
// rather than corrupting the buffer; it is cleared when that connection closes.
const _assetPartials = new Map(); // hash -> { parts: [], got, bytes, owner }

// When the last bulk binary slice arrived. The app's asset reconcile uses this (via
// collabAssetFlowing) to avoid re-requesting hashes while a transfer is actively coming
// in -- otherwise queued serves on a slow uplink get re-requested and pile up duplicates.
let _lastAssetRxAt = 0;
window.collabAssetFlowing = () => _lastAssetRxAt > 0 && Date.now() - _lastAssetRxAt < 6000;

function _enqueueSend(conn, task) {
  const prev = _sendChains.get(conn) || Promise.resolve();
  const next = prev.then(task).catch((e) => console.warn("[collab] queued send failed:", e));
  _sendChains.set(conn, next);
  return next;
}

function _concatParts(parts) {
  if (parts.length === 1) return parts[0];
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), off);
    off += p.byteLength;
  }
  return out.buffer;
}

// Send a header then the buffer as CHUNK_SIZE slices, draining between each. The drain
// wait yields to the event loop so an incoming ping is answered -- its pong rides out
// between slices -- and it bounds the bytes queued ahead of that pong. So a large
// transfer no longer head-of-line-blocks the heartbeat and trips the host's drop timer.
// The header carries the total byte length so the receiver knows when reassembly is
// complete. Returns false if the connection died mid-send (the receiver re-requests on
// its retry timer; no partial state is kept -- this is not resume).
async function _sendChunked(conn, header, buffer, offset = 0) {
  const view = ArrayBuffer.isView(buffer) ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer;
  if (!conn.open || !(await _waitDrain(conn)) || !conn.open) return false;
  // `bytes` is the total length (the receiver's completion target); slices start at
  // `offset` so an interrupted transfer resumes instead of restarting.
  conn.send(JSON.stringify({ ...header, bytes: view.byteLength, offset }));
  for (let off = offset; off < view.byteLength; off += CHUNK_SIZE) {
    if (!conn.open || !(await _waitDrain(conn)) || !conn.open) return false;
    const slice = view.slice(off, Math.min(off + CHUNK_SIZE, view.byteLength));
    conn.send(slice);
    _dbg("tx", "bin:" + header.type, slice.byteLength);
  }
  return true;
}

function _dataUrlToBuffer(dataUrl) {
  const b64 = dataUrl.split(",")[1];
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

// `replace` true only for an explicit host-side import re-stream: it tells the guest
// to adopt this session wholesale. The default (join handshake / reconnect) is false,
// so a guest that already has images merges instead of being wiped -- otherwise a
// reconnecting guest with more/newer images gets clobbered by the host's snapshot.
async function sendSessionTo(conn, { replace = false } = {}) {
  try {
    const meta = window.getSessionMeta?.();
    if (!meta || meta.imageCount === 0) return;

    // Phase 1: instant skeleton — synchronous, no pixel reads
    const metaStr = JSON.stringify({ type: "session-meta", replace, ...meta });
    _dbg("tx", "session-meta", metaStr.length);
    conn.send(metaStr);

    // Phase 2: thumbnails — precomputed small JPEGs, sent synchronously (keyed by id)
    // for an instant preview while the full bytes pull in.
    for (let i = 0; i < meta.imageCount; i++) {
      const id = meta.images[i].id;
      const thumb = window.getImageThumb?.(id);
      if (thumb) {
        const ts = JSON.stringify({ type: "image-thumb", imgIdx: id, thumb });
        _dbg("tx", "image-thumb", ts.length);
        conn.send(ts);
      }
    }
    conn.send(JSON.stringify({ type: "session-thumbs-done", total: meta.imageCount }));

    // Full-res bytes are NOT streamed here anymore: each image's assetHash (in the
    // session-meta + the shared doc) lets the guest pull bytes on demand, deduped and
    // cached by content hash. That removes the re-stream-on-every-reconnect loop that
    // saturated the channel (starving heartbeat pongs -> drop -> reconnect -> re-stream).
    conn.send(JSON.stringify({ type: "session-done" }));
  } catch (err) {
    console.warn("[collab] session send failed:", err);
  }
}

// Send one live-added image over a connection as a header + chunked binary, with
// backpressure -- the same robust path the join stream uses. A base64 JSON string of a
// 4K photo overflows the DataChannel's max message size and silently fails, which is
// why the old string-based live-add path never delivered large images.
function sendImageBinary(conn, packet) {
  if (!packet || !conn || !conn.open) return Promise.resolve(false);
  const { buffer, id, assetHash, name, w, h, polygons, simPos, simAngle } = packet;
  // Queued so header+slices stay atomic per connection (no cross-wiring); chunked so the
  // heartbeat keeps flowing during the transfer.
  return _enqueueSend(conn, () => _sendChunked(conn, { type: "image-binary", id, assetHash, name, w, h, polygons, simPos, simAngle }, buffer));
}

// Host relays a guest-originated image to the other guests (star topology), reusing
// the already-reassembled bytes so it stays binary + chunked rather than a string.
async function _forwardImageBinary(meta, buffer, excludePeerId) {
  for (const [pid, conn] of guestConns) {
    if (pid === excludePeerId) continue;
    await sendImageBinary(conn, { buffer, ...meta });
  }
}

// ── Content-addressed asset pull ──────────────────────────────────────────────
// Bytes are fetched on demand by content hash with retry, so a stalled/lost payload
// self-heals: the requester re-asks until some peer serves it. Metadata (which carries
// the assetHash) syncs reliably on its own; the large bytes ride this pull path.

function sendAssetBinary(conn, hash, buffer, offset = 0) {
  if (!conn || !conn.open || !buffer) return;
  // Queued: serialize per connection so concurrent serves can't interleave; chunked so
  // the heartbeat keeps flowing while the bytes go out; from `offset` to resume.
  return _enqueueSend(conn, () => _sendChunked(conn, { type: "asset-binary", hash }, buffer, offset));
}

// Serve an asset to a requester if we hold it; otherwise the host relays the request
// onward (and will cache the response), and the requester re-asks on its retry timer.
// `offset` is how many bytes the requester already has (resume from there).
async function _serveAsset(hash, fromPeerId, offset = 0) {
  if (window.hasAsset?.(hash)) {
    const buf = await window.getAssetBuffer?.(hash);
    const conn = isHost ? guestConns.get(fromPeerId) : hostConn;
    if (buf && conn && offset <= buf.byteLength) sendAssetBinary(conn, hash, buf, offset);
  } else if (isHost) {
    broadcast({ type: "asset-request", hash, offset }, fromPeerId);
  }
}

// App asks for bytes it's missing -> request them from peers (host serves or relays),
// carrying how much we already have so the serve resumes rather than restarts.
window.addEventListener("collab:asset-needed", ({ detail: { hash } }) => {
  if (!localPeerId) return;
  const p = _assetPartials.get(hash);
  broadcast({ type: "asset-request", hash, offset: p ? p.got : 0 });
});

// ── Join as host ──────────────────────────────────────────────────────────────

function joinAsHost(roomCode) {
  const hid = hostIdFor(roomCode);
  peer = new Peer(hid, { debug: 0 });

  peer.on("open", (id) => {
    if (isHost) return; // signaling reconnect — data channels intact, skip reinit
    localPeerId = id;
    isHost = true;
    _setRole();
    setStatus("Hosting - waiting for guests", true);
    _updateQR(); // now joined -> safe to surface the shareable QR
    rafId = requestAnimationFrame(rafLoop);
    simCanvasEl.addEventListener("mousemove", onMouseMove);
    _startHostPing();
  });

  peer.on("connection", (conn) => {
    _guestLastPong.set(conn.peer, Date.now());
    guestConns.set(conn.peer, conn);
    setupConn(conn, true);
    updatePeerCount();
    _broadcastPeerCount();
    conn.on("open", () => {
      _broadcastPeerCount();
      // Session is sent only after the guest's 'join' handshake is validated
      // (see handleMsg 'join'), so a wrong-password guest never receives it.
    });
  });

  peer.on("disconnected", () => {
    if (peer && !peer.destroyed) peer.reconnect();
  });

  peer.on("error", (err) => {
    if (err.type === "unavailable-id") {
      peer.destroy();
      peer = null;
      joinAsGuest(roomCode);
    } else {
      setStatus("Connection error: " + err.type);
      console.warn("[collab] host peer error:", err);
    }
  });
}

// ── Join as guest ─────────────────────────────────────────────────────────────

function joinAsGuest(roomCode, retries = 0) {
  peer = new Peer({ debug: 0 });

  peer.on("open", (id) => {
    localPeerId = id;
    isHost = false;
    rafId = requestAnimationFrame(rafLoop);
    simCanvasEl.addEventListener("mousemove", onMouseMove);

    const hid = hostIdFor(roomCode);
    hostConn = peer.connect(hid, { reliable: true });

    hostConn.on("open", () => {
      _setRole();
      setStatus("Connected as guest", true);
      _updateQR(); // joined -> the QR points at this same room, safe to show
      updatePeerCount();
      // Authenticate: send our name + password attempt. The host replies with the
      // session if it matches, or 'auth-failed' if not.
      hostConn.send(
        JSON.stringify({
          type: "join",
          name: nameInp.value.trim() || "Anonymous",
          password: passInp ? passInp.value.trim() : "",
          // Tell the host whether we already hold images so it can skip re-blasting the
          // whole session (meta + thumbnails) on a reconnect -- avoids a reconnect storm
          // continuously re-sending thumbnails.
          have: window.getCollabState ? window.getCollabState().imageCount || 0 : 0,
        }),
      );
      // Send our doc state up so the host merges anything we hold (images added while
      // disconnected, edits made offline). Yjs merges are commutative + idempotent, so
      // exchanging full state both ways converges -- this replaces the old fragile
      // "resend missing images" reconnect hack. Bytes then flow via asset pull.
      _sendDocState(hostConn);
      // No blocking overlay: the host pushes its session automatically, and the
      // guest can always import a session file manually from the normal UI.
    });

    setupConn(hostConn, false);

    peer.on("error", (err) => {
      if (err.type === "peer-unavailable" && retries < 4) {
        peer.destroy();
        peer = null;
        localPeerId = null;
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        simCanvasEl.removeEventListener("mousemove", onMouseMove);
        setStatus("Waiting for host...");
        setTimeout(() => joinAsGuest(roomCode, retries + 1), 1500);
      } else {
        setStatus("Could not reach host");
        console.warn("[collab] guest peer error:", err);
      }
    });
  });
}

// ── Join / leave ──────────────────────────────────────────────────────────────

function joinRoom(code) {
  if (peer) leaveRoom();
  currentRoom = code.trim();
  if (!currentRoom) return;

  setStatus("Connecting...");
  setRoomParam(currentRoom);

  joinAsHost(currentRoom);

  btnJoin.classList.add("im-hidden");
  btnLeave.classList.remove("im-hidden");
  btnPresent.classList.remove("im-hidden");
  btnCollab.classList.add("im-collab-live");
}

function _setPresentBtn(on) {
  btnPresent.textContent = on ? "Stop presenting" : "Present";
  btnPresent.classList.toggle("im-collab-live", on);
}

btnPresent.addEventListener("click", () => {
  if (!localPeerId || !window.imViewport) return;
  const on = !window.imViewport.presenting;
  window.imViewport.setPresenting(on);
  _setPresentBtn(on);
});

function leaveRoom() {
  if (!peer) return;

  broadcast({ type: "cursor-leave", id: localPeerId });

  clearInterval(_hostPingTimer);
  _hostPingTimer = null;
  clearTimeout(_reconnectTimer);
  _reconnectTimer = null;
  _guestLastPong.clear();

  guestConns.forEach((conn) => {
    try {
      conn.close();
    } catch (_) {}
  });
  guestConns.clear();
  if (hostConn) {
    try {
      hostConn.close();
    } catch (_) {}
    hostConn = null;
  }

  peer.destroy();
  peer = null;
  localPeerId = null;
  isHost = false;
  remotePeerCount = 0;
  currentRoom = null;

  simCanvasEl.removeEventListener("mousemove", onMouseMove);
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  peerEls.forEach((_, id) => removeCursorEl(id));
  peerEls.clear();
  remoteCursors.clear();
  for (const imgIdx of grabbedByPeer.keys()) {
    window.dispatchEvent(new CustomEvent("collab:remote-release", { detail: { imgIdx } }));
  }
  grabbedByPeer.clear();
  hideGuestPrompt();

  if (window.imViewport) window.imViewport.setPresenting(false);
  _setPresentBtn(false);
  btnPresent.classList.add("im-hidden");
  btnJoin.classList.remove("im-hidden");
  btnLeave.classList.add("im-hidden");
  btnCollab.classList.remove("im-collab-live");
  collabPeerBadge.classList.add("im-hidden");
  _setRole();
  _updateQR(); // left the room -> hide the QR again
  setStatus("Not connected");

  const u = new URL(window.location.href);
  u.searchParams.delete("room");
  window.history.replaceState(null, "", u.toString());
}

// ── App event hooks ───────────────────────────────────────────────────────────

// Settings now sync through the CRDT (converges, no last-writer race) rather than a
// raw broadcast. Write even when solo so the doc holds current settings for joiners.
window.addEventListener("collab:settings-changed", ({ detail }) => {
  ydoc.transact(() => {
    for (const k in detail) if (detail[k] !== undefined) ySettings.set(k, detail[k]);
  }, "local");
});

// Rank order syncs through the CRDT (replace-in-place; the array is small).
window.addEventListener("collab:rank-order-changed", ({ detail: { order } }) => {
  ydoc.transact(() => {
    if (yRank.length) yRank.delete(0, yRank.length);
    yRank.insert(0, order);
  }, "local");
});

// Adding images announces membership in the doc (converges, no last-writer race); the
// bytes are NOT pushed -- peers pull them by assetHash via the asset layer. Written even
// when solo so a later joiner converges. Await the hashes first (getImageMembership
// registers the bytes), then write membership + rank in one transaction.
window.addEventListener("collab:images-added", async ({ detail: { ids } }) => {
  const metas = [];
  for (const id of ids) {
    const m = await window.getImageMembership?.(id);
    if (m) metas.push(m);
  }
  if (!metas.length) return;
  ydoc.transact(() => {
    const have = yRank.toArray();
    for (const m of metas) {
      yImages.set(m.id, m);
      if (!have.includes(m.id)) yRank.push([m.id]);
    }
  }, "local");
});

// A local session import: the host re-streams the whole session to every guest
// (so they refresh as if newly joined); on a guest it just dismisses any prompt.
window.addEventListener("collab:session-loaded", () => {
  hideGuestPrompt();
  if (isHost)
    for (const conn of guestConns.values()) {
      if (conn.open) sendSessionTo(conn, { replace: true });
    }
});

// Removal deletes the image from the doc (membership) plus its per-image metadata;
// peers reconcile via the yImages observer. Written even when solo.
window.addEventListener("collab:image-removed", ({ detail: { imgIdx } }) => {
  ydoc.transact(() => {
    yImages.delete(imgIdx);
    const i = yRank.toArray().indexOf(imgIdx);
    if (i !== -1) yRank.delete(i, 1);
    yPoly.delete(imgIdx);
    yScales.delete(imgIdx);
  }, "local");
});

window.addEventListener("collab:canvas-resized", () => {
  if (!localPeerId) return;
  const positions = window.getSimPositions ? window.getSimPositions() : {};
  const bounds = window.getSimBounds ? window.getSimBounds() : {};
  broadcast({ type: "positions", positions, ...bounds });
});

// Scales sync through the CRDT (per-image map of id -> scale).
window.addEventListener("collab:scales-changed", ({ detail: { scales } }) => {
  ydoc.transact(() => {
    for (const id in scales) yScales.set(id, scales[id]);
  }, "local");
});

window.addEventListener("collab:body-dragging", ({ detail }) => {
  if (!localPeerId) return;
  broadcast({ type: "drag", imgIdx: detail.imgIdx, x: detail.x, y: detail.y, angle: detail.angle, scale: detail.scale });
});

// Group move (multi-select): live + final positions both go via the {id:pos}
// message that peers already apply (collab:remote-positions).
for (const ev of ["collab:bodies-dragging", "collab:bodies-moved"]) {
  window.addEventListener(ev, ({ detail }) => {
    if (!localPeerId) return;
    broadcast({ type: "positions", positions: detail.positions });
  });
}

window.addEventListener("collab:body-grabbing", ({ detail: { imgIdx } }) => {
  if (!localPeerId) return;
  broadcast({ type: "grab", imgIdx, color: getLocalColor() });
});

window.addEventListener("collab:body-releasing", ({ detail: { imgIdx } }) => {
  if (!localPeerId) return;
  broadcast({ type: "release", imgIdx });
});

// Polygon masks sync through the CRDT (per-image map of id -> polygon list).
window.addEventListener("collab:polygon-changed", ({ detail: { imgIdx, polygons } }) => {
  ydoc.transact(() => yPoly.set(imgIdx, polygons), "local");
});

// Presenter mode: stream the local viewport to followers, throttled (leading + trailing).
const VP_THROTTLE_MS = 50;
let _vpLastSent = 0,
  _vpTrailing = null,
  _vpTimer = null;
function _sendViewport(d) {
  broadcast({ type: "viewport", scale: d.scale, centerX: d.centerX, centerY: d.centerY });
}
window.addEventListener("collab:viewport-changed", ({ detail }) => {
  if (!localPeerId) return;
  const now = Date.now();
  const since = now - _vpLastSent;
  if (since >= VP_THROTTLE_MS) {
    _vpLastSent = now;
    _vpTrailing = null;
    _sendViewport(detail);
  } else {
    _vpTrailing = detail;
    if (!_vpTimer) {
      _vpTimer = setTimeout(() => {
        _vpTimer = null;
        if (_vpTrailing) {
          _vpLastSent = Date.now();
          _sendViewport(_vpTrailing);
          _vpTrailing = null;
        }
      }, VP_THROTTLE_MS - since);
    }
  }
});

// ── Sim undo ──────────────────────────────────────────────────────────────────
// imageMerge.js fires collab:undo-record with a scoped snapshot on commit and
// exposes capture/applySimSnapshot(); the undo/redo stacks live here.

const _fmtCount = (n) => (n > 999 ? "999+" : String(n));
function updateUndoBtn() {
  btnUndo.disabled = simUndoStack.length === 0;
  simUndoBadge.textContent = _fmtCount(simUndoStack.length);
}
function updateRedoBtn() {
  btnRedo.disabled = simRedoStack.length === 0;
  simRedoBadge.textContent = _fmtCount(simRedoStack.length);
}
updateUndoBtn();
updateRedoBtn();

// Read-only snapshot of the sim undo state (for diagnostics / tests).
window.getUndoState = () => ({ undo: simUndoStack.length, redo: simRedoStack.length });

// Final drag position -> peers (live sync). Undo recording is separate (below).
window.addEventListener("collab:body-moved", ({ detail }) => {
  if (localPeerId) {
    broadcast({ type: "positions", positions: { [detail.imgIdx]: { x: detail.x, y: detail.y, angle: detail.angle } } });
  }
});

// Record a committed action's pre-state.
window.addEventListener("collab:undo-record", ({ detail }) => {
  simUndoStack.push(detail);
  if (simUndoStack.length > SIM_UNDO_MAX) simUndoStack.shift();
  simRedoStack.length = 0;
  updateUndoBtn();
  updateRedoBtn();
});

// Apply a snapshot locally, then sync only the affected scope to peers.
function _applySimSnapshot(entry) {
  if (!window.applySimSnapshot) return;
  window.applySimSnapshot(entry);
  if (!localPeerId) return;
  if (entry.bounds) {
    // Bounds go through the settings CRDT so peers re-derive auto-scale.
    const b = window.getSimBounds ? window.getSimBounds() : {};
    const cs = window.getCollabState ? window.getCollabState() : {};
    ydoc.transact(() => {
      ySettings.set("outW", cs.outW);
      ySettings.set("outH", cs.outH);
      ySettings.set("simX1", b.simX1);
      ySettings.set("simY1", b.simY1);
      ySettings.set("simX2", b.simX2);
      ySettings.set("simY2", b.simY2);
    }, "local");
  }
  if (entry.groups && entry.groups.length) {
    const all = window.getSimPositions ? window.getSimPositions() : {};
    const positions = {};
    for (const g of entry.groups) if (all[g.imgIdx]) positions[g.imgIdx] = all[g.imgIdx];
    broadcast({ type: "positions", positions });
    if (window.getScales) broadcast({ type: "scales", scales: window.getScales() });
  }
}

// Current state, scoped exactly like a given entry (the inverse for the other stack).
function _captureLike(entry) {
  return window.captureSimSnapshot(
    entry.groups.map((g) => g.imgIdx),
    !!entry.bounds,
  );
}

btnUndo.addEventListener("click", () => {
  const entry = simUndoStack.pop();
  if (!entry) return;
  simRedoStack.push(_captureLike(entry));
  if (simRedoStack.length > SIM_UNDO_MAX) simRedoStack.shift();
  _applySimSnapshot(entry);
  updateUndoBtn();
  updateRedoBtn();
});

btnRedo.addEventListener("click", () => {
  const entry = simRedoStack.pop();
  if (!entry) return;
  simUndoStack.push(_captureLike(entry));
  if (simUndoStack.length > SIM_UNDO_MAX) simUndoStack.shift();
  _applySimSnapshot(entry);
  updateUndoBtn();
  updateRedoBtn();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!modal.classList.contains("im-hidden")) modal.classList.add("im-hidden");
    return;
  }
  if (!e.ctrlKey || e.key.toLowerCase() !== "z") return;
  e.preventDefault();
  if (e.shiftKey) btnRedo.click();
  else btnUndo.click();
});

// ── UI wiring ─────────────────────────────────────────────────────────────────

btnCollab.addEventListener("click", () => {
  modal.classList.remove("im-hidden");
  _updateQR();
});
btnClose.addEventListener("click", () => modal.classList.add("im-hidden"));
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.add("im-hidden");
});

roomInp.addEventListener("input", _updateQR);

btnJoin.addEventListener("click", () => {
  const code = roomInp.value.trim() || randomRoomCode();
  roomInp.value = code;
  localStorage.setItem(STORAGE_NAME_KEY, nameInp.value.trim());
  joinRoom(code);
  _updateQR();
});

btnLeave.addEventListener("click", leaveRoom);

const _copyIconHtml = btnCopy.innerHTML;
const _checkIconHtml = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
btnCopy.addEventListener("click", () => {
  const code = roomInp.value.trim() || randomRoomCode();
  setRoomParam(code);
  const u = new URL(window.location.href);
  navigator.clipboard.writeText(u.toString()).then(() => {
    btnCopy.innerHTML = _checkIconHtml;
    btnCopy.title = "Copied!";
    setTimeout(() => {
      btnCopy.innerHTML = _copyIconHtml;
      btnCopy.title = "Copy link";
    }, 1800);
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────

const savedName = localStorage.getItem(STORAGE_NAME_KEY);
if (savedName) nameInp.value = savedName;

const urlRoom = getRoomParam();
if (urlRoom) {
  roomInp.value = urlRoom;
  // Arriving via a shared link / QR scan: surface the session modal so the room
  // is visible and a password can be supplied if the join is rejected.
  modal.classList.remove("im-hidden");
  _updateQR();
  setTimeout(() => joinRoom(urlRoom), 600);
} else {
  roomInp.value = randomRoomCode();
}

// Reconnect guest when returning from background (mobile browsers suspend WebRTC)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (isHost || !currentRoom) return;
  if (!hostConn || !hostConn.open) _scheduleReconnect();
});

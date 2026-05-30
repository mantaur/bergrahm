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
//   { type: 'drag',                  imgIdx, x, y, angle }
//   { type: 'grab',                  imgIdx, color }
//   { type: 'release',               imgIdx }
//   { type: 'image',                 ...imagePacketFields }
//   { type: 'image-removed',         imgIdx }
//   { type: 'encoding',              imgName, encoding }
//   { type: 'polygon',               imgIdx, polygons }
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

// ── Constants ─────────────────────────────────────────────────────────────────

const PING_INTERVAL = 3000;   // ms between host pings to each guest
const PING_TIMEOUT  = 10000;  // ms without a pong before host drops the guest

const COLORS = [
  '#e05252', '#4a9eed', '#52c97a', '#e0a033',
  '#9b6be0', '#30b5be', '#e0709a', '#8fbe4a',
];
const STORAGE_NAME_KEY = 'collab-name';
const CHUNK_SIZE        = 64 * 1024;
const SIM_UNDO_MAX      = 50;
const HOST_PREFIX       = 'im-mrg-'; // prefix for deterministic host peer IDs

// ── DOM ───────────────────────────────────────────────────────────────────────

const modal          = document.getElementById('collab-modal');
const qrContainer    = document.getElementById('collab-qr');
const btnCollab      = document.getElementById('btn-collab');
const btnClose       = document.getElementById('btn-collab-close');
const btnJoin        = document.getElementById('btn-collab-join');
const btnLeave       = document.getElementById('btn-collab-leave');
const btnCopy        = document.getElementById('btn-collab-copy');
const btnUndo        = document.getElementById('btn-sim-undo');
const btnRedo        = document.getElementById('btn-sim-redo');
const nameInp        = document.getElementById('collab-name-inp');
const roomInp        = document.getElementById('collab-room-inp');
const statusEl       = document.getElementById('collab-status');
const cursorLayer    = document.getElementById('collab-cursor-layer');
const guestPrompt    = document.getElementById('collab-guest-prompt');
const guestMsg       = document.getElementById('collab-guest-msg');
const progressBar    = document.getElementById('collab-progress-bar');
const simCanvasEl    = document.getElementById('sim-canvas');
const sendProgressEl = document.getElementById('collab-send-progress');
const sendMsgEl      = document.getElementById('collab-send-msg');
const sendBarEl      = document.getElementById('collab-send-bar');
const recvProgressEl = document.getElementById('collab-recv-progress');
const recvMsgEl      = document.getElementById('collab-recv-msg');
const recvBarEl      = document.getElementById('collab-recv-bar');

// ── Runtime state ─────────────────────────────────────────────────────────────

let peer           = null;
let localPeerId    = null;
let isHost         = false;
let currentRoom    = null;
let hostConn       = null;              // guest's single connection to host
let remotePeerCount = 0;               // count broadcast by host; used on guest side
const guestConns = new Map();           // host's connections: peerId -> conn

// ── Cursor state ──────────────────────────────────────────────────────────────

let rafId = null;
const peerEls       = new Map(); // peerId -> { el, label }
const remoteCursors = new Map(); // peerId -> { x, y, name, color }

// ── Sim undo + grab tracking ──────────────────────────────────────────────────

const simUndoStack  = [];
const simRedoStack  = [];
const preLiftState  = new Map();
const grabbedByPeer  = new Map(); // imgIdx -> peerId (for cleanup on disconnect)

// ── Heartbeat state ───────────────────────────────────────────────────────────

const _guestLastPong = new Map(); // host: peerId -> timestamp of last pong received
let _hostPingTimer   = null;
let _reconnectTimer  = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLocalColor() {
  if (!getLocalColor._c) getLocalColor._c = COLORS[Math.floor(Math.random() * COLORS.length)];
  return getLocalColor._c;
}

function randomRoomCode() { return Math.random().toString(36).slice(2, 9); }

function getRoomParam() { return new URLSearchParams(window.location.search).get('room'); }

function setRoomParam(code) {
  const u = new URL(window.location.href);
  u.searchParams.set('room', code);
  window.history.replaceState(null, '', u.toString());
}

function hostIdFor(roomCode) { return HOST_PREFIX + roomCode; }

function physicsToClient(physX, physY) {
  const rect = simCanvasEl.getBoundingClientRect();
  const { dispScale, viewScale, viewOffset } = window.getSimState();
  const ts = dispScale * viewScale;
  const cx = (physX - viewOffset.x) * ts;
  const cy = (physY - viewOffset.y) * ts;
  return {
    x: cx * rect.width  / simCanvasEl.width  + rect.left,
    y: cy * rect.height / simCanvasEl.height + rect.top,
  };
}

function _updateQR() {
  if (typeof QRCode === 'undefined') return;
  const code = roomInp.value.trim();
  qrContainer.innerHTML = '';
  if (!code) return;
  const u = new URL(window.location.href);
  u.searchParams.set('room', code);
  new QRCode(qrContainer, {
    text: u.toString(), width: 160, height: 160,
    colorDark: '#1a1b1c', colorLight: '#f0f0f0',
    correctLevel: QRCode.CorrectLevel.M,
  });
}

function setStatus(text, connected) {
  statusEl.textContent = text;
  statusEl.classList.toggle('im-collab-connected', !!connected);
}

const collabPeerBadge = document.getElementById('collab-peer-badge');

function _broadcastPeerCount() {
  if (!isHost) return;
  const msg = JSON.stringify({ type: 'peer-count', count: guestConns.size });
  for (const conn of guestConns.values()) {
    if (conn.open) conn.send(msg);
  }
}

function updatePeerCount() {
  const count = isHost ? guestConns.size : (hostConn ? remotePeerCount : 0);
  setStatus(
    count === 0 ? 'Connected - waiting for others'
                : `Connected (${count} peer${count > 1 ? 's' : ''})`,
    true
  );
  if (count > 0) {
    collabPeerBadge.textContent = count > 9 ? '9+' : count;
    collabPeerBadge.classList.remove('im-hidden');
  } else {
    collabPeerBadge.classList.add('im-hidden');
  }
  window.dispatchEvent(new CustomEvent('collab:peer-count', { detail: { count } }));
}

// ── Guest prompt ──────────────────────────────────────────────────────────────

function showGuestPrompt(msg) {
  guestPrompt.classList.remove('im-hidden');
  guestMsg.textContent = msg;
}

function hideGuestPrompt() {
  guestPrompt.classList.add('im-hidden');
  progressBar.style.width = '0%';
}

function updateProgress(pct) { progressBar.style.width = Math.round(pct) + '%'; }

function showSendProgress(msg, pct) {
  sendProgressEl.classList.remove('im-hidden');
  sendMsgEl.textContent = msg;
  sendBarEl.style.width = Math.round(pct) + '%';
}
function hideSendProgress() {
  sendProgressEl.classList.add('im-hidden');
  sendBarEl.style.width = '0%';
}

function showRecvProgress(msg, pct) {
  recvProgressEl.classList.remove('im-hidden');
  recvMsgEl.textContent = msg;
  recvBarEl.style.width = Math.round(pct) + '%';
}
function hideRecvProgress() {
  recvProgressEl.classList.add('im-hidden');
  recvBarEl.style.width = '0%';
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
    const el    = document.createElement('div');
    el.className = 'collab-cursor';
    el.innerHTML = makeCursorSVG(cursorState.color);
    const label = document.createElement('div');
    label.className = 'collab-cursor-label';
    el.appendChild(label);
    cursorLayer.appendChild(el);
    entry = { el, label, path: el.querySelector('svg path') };
    peerEls.set(peerId, entry);
  }
  const name = cursorState.name || 'Anonymous';
  if (entry.label.textContent !== name)  entry.label.textContent      = name;
  if (entry.label.style.background !== cursorState.color) entry.label.style.background = cursorState.color;
  if (entry.path.getAttribute('fill')  !== cursorState.color) entry.path.setAttribute('fill', cursorState.color);
  return entry.el;
}

function removeCursorEl(peerId) {
  const entry = peerEls.get(peerId);
  if (entry) { entry.el.remove(); peerEls.delete(peerId); }
  remoteCursors.delete(peerId);
}

// ── RAF loop ──────────────────────────────────────────────────────────────────

function rafLoop() {
  if (remoteCursors.size === 0) { rafId = null; return; }
  for (const [peerId, cursor] of remoteCursors) {
    const el  = upsertCursorEl(peerId, cursor);
    const pos = physicsToClient(cursor.x, cursor.y);
    el.style.transform = `translate(${pos.x}px,${pos.y}px)`;
  }
  rafId = requestAnimationFrame(rafLoop);
}

// ── Cursor broadcast ──────────────────────────────────────────────────────────

function onMouseMove(e) {
  if (!localPeerId || typeof canvasToPhysics === 'undefined') return;
  const phys = canvasToPhysics(e.clientX, e.clientY);
  broadcast({
    type: 'cursor', id: localPeerId,
    x: phys.x, y: phys.y,
    name:  nameInp.value.trim() || 'Anonymous',
    color: getLocalColor(),
  });
}

// ── Broadcast ─────────────────────────────────────────────────────────────────

// Send a JSON message to all connected peers.
// On host: send to all guests.
// On guest: send to host (who will rebroadcast).
function broadcast(msg, excludePeerId) {
  const str = JSON.stringify(msg);
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
    case 'cursor':
      remoteCursors.set(msg.id, { x: msg.x, y: msg.y, name: msg.name, color: msg.color });
      if (!rafId) rafId = requestAnimationFrame(rafLoop);
      if (isHost) broadcast(msg, fromPeerId); // rebroadcast
      break;

    case 'cursor-leave':
      removeCursorEl(msg.id);
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'settings':
      if (window.applyRemoteSettings) window.applyRemoteSettings(msg.settings);
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'rank-order':
      if (window.applyRemoteRankOrder) window.applyRemoteRankOrder(msg.order);
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'positions':
      window.dispatchEvent(new CustomEvent('collab:remote-positions', {
        detail: { positions: msg.positions, simX1: msg.simX1, simY1: msg.simY1, simX2: msg.simX2, simY2: msg.simY2 },
      }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'drag':
      window.dispatchEvent(new CustomEvent('collab:remote-drag', {
        detail: { imgIdx: msg.imgIdx, x: msg.x, y: msg.y, angle: msg.angle },
      }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'grab':
      grabbedByPeer.set(msg.imgIdx, fromPeerId);
      window.dispatchEvent(new CustomEvent('collab:remote-grab', {
        detail: { imgIdx: msg.imgIdx, color: msg.color },
      }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'release':
      grabbedByPeer.delete(msg.imgIdx);
      window.dispatchEvent(new CustomEvent('collab:remote-release', { detail: { imgIdx: msg.imgIdx } }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'image':
      window.dispatchEvent(new CustomEvent('collab:remote-image', { detail: msg }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'image-removed':
      window.dispatchEvent(new CustomEvent('collab:remote-image-removed', { detail: { imgIdx: msg.imgIdx } }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'encoding':
      window.dispatchEvent(new CustomEvent('collab:remote-encoding', { detail: msg }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'polygon':
      window.dispatchEvent(new CustomEvent('collab:remote-polygon', {
        detail: { imgIdx: msg.imgIdx, polygons: msg.polygons },
      }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'scales':
      window.dispatchEvent(new CustomEvent('collab:remote-scales', { detail: { scales: msg.scales } }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'session-meta':
      window.dispatchEvent(new CustomEvent('collab:remote-session-meta', { detail: msg }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'image-thumb':
      window.dispatchEvent(new CustomEvent('collab:remote-image-thumb', {
        detail: { imgIdx: msg.imgIdx, thumb: msg.thumb },
      }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'image-full':
      window.dispatchEvent(new CustomEvent('collab:remote-image-full', { detail: msg }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'session-thumbs-done':
      if (!isHost) { hideGuestPrompt(); showRecvProgress('Receiving images... 0/' + msg.total, 0); }
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'session-host-progress':
      if (!isHost) showRecvProgress('Receiving images... ' + msg.sent + '/' + msg.total, msg.sent / msg.total * 100);
      break;

    case 'session-done':
      if (!isHost) hideRecvProgress();
      break;

    case 'peer-count':
      if (!isHost) { remotePeerCount = msg.count; updatePeerCount(); }
      break;

    case 'ping':
      if (!isHost && hostConn && hostConn.open)
        hostConn.send(JSON.stringify({ type: 'pong' }));
      break;

    case 'pong':
      if (isHost) _guestLastPong.set(fromPeerId, Date.now());
      break;
  }
}

// ── Data connection setup ─────────────────────────────────────────────────────

function setupConn(conn, isGuestSide) {
  let receiving        = null; // legacy ZIP receive state
  let pendingImageMeta = null; // set by image-full-binary header; cleared when binary arrives

  conn.on('data', data => {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const buf = ArrayBuffer.isView(data)
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
      if (pendingImageMeta !== null) {
        // Full-res image binary sent by host; reassembled by PeerJS chunking
        const { imgIdx, ...imgMeta } = pendingImageMeta;
        pendingImageMeta = null;
        const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        handleMsg({ type: 'image-full', imgIdx, jpegBase64: blobUrl, ...imgMeta }, conn.peer);
      } else if (receiving) {
        receiving.chunks.push(buf);
        const got = receiving.chunks.reduce((s, c) => s + c.byteLength, 0);
        updateProgress(Math.round(got / receiving.totalBytes * 100));
      }
      return;
    }
    if (typeof data !== 'string') return;
    const msg = JSON.parse(data);

    if (msg.type === 'image-full-binary') {
      // Metadata header for the binary image that follows
      pendingImageMeta = {
        imgIdx: msg.imgIdx, name: msg.name, w: msg.w, h: msg.h,
        polygons: msg.polygons, currentPoly: msg.currentPoly,
        scale: msg.scale, scaleFixed: msg.scaleFixed, simHidden: msg.simHidden,
        simPos: msg.simPos, simAngle: msg.simAngle,
      };
    } else if (msg.type === 'session-start') {
      receiving = { chunks: [], totalBytes: msg.totalBytes };
      showGuestPrompt('Receiving session...');
    } else if (msg.type === 'session-end') {
      if (receiving) {
        const blob = new Blob(receiving.chunks, { type: 'application/zip' });
        receiving = null;
        hideGuestPrompt();
        window.dispatchEvent(new CustomEvent('collab:remote-session', { detail: { blob } }));
      }
    } else {
      handleMsg(msg, conn.peer);
    }
  });

  conn.on('close', () => {
    if (isGuestSide) {
      _dropGuest(conn.peer);
    } else {
      hostConn        = null;
      remotePeerCount = 0;
      setStatus('Disconnected from host');
      _scheduleReconnect();
    }
  });

  conn.on('error', err => console.warn('[collab] conn error:', err));
}

// ── Heartbeat helpers ─────────────────────────────────────────────────────────

function _dropGuest(peerId) {
  const conn = guestConns.get(peerId);
  if (conn) { try { conn.close(); } catch (_) {} }
  guestConns.delete(peerId);
  _guestLastPong.delete(peerId);
  removeCursorEl(peerId);
  for (const [imgIdx, pid] of grabbedByPeer) {
    if (pid === peerId) {
      grabbedByPeer.delete(imgIdx);
      window.dispatchEvent(new CustomEvent('collab:remote-release', { detail: { imgIdx } }));
    }
  }
  updatePeerCount();
  _broadcastPeerCount();
}

function _startHostPing() {
  clearInterval(_hostPingTimer);
  _hostPingTimer = setInterval(() => {
    if (!isHost) return;
    const now  = Date.now();
    const ping = JSON.stringify({ type: 'ping' });
    const toDrop = [];
    for (const [peerId, conn] of guestConns) {
      const last = _guestLastPong.get(peerId) || 0;
      if (now - last > PING_TIMEOUT) { toDrop.push(peerId); continue; }
      if (conn.open) conn.send(ping);
    }
    for (const peerId of toDrop) _dropGuest(peerId);
  }, PING_INTERVAL);
}

function _scheduleReconnect() {
  clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(() => {
    if (!currentRoom || isHost) return;
    if (peer && !peer.destroyed) { try { peer.destroy(); } catch (_) {} }
    peer            = null;
    localPeerId     = null;
    hostConn        = null;
    remotePeerCount = 0;
    joinAsGuest(currentRoom);
  }, 2000);
}

// ── Streaming session send ────────────────────────────────────────────────────

async function _waitDrain(conn) {
  const dc = conn.dataChannel;
  if (!dc) return;
  while (dc.bufferedAmount > 512 * 1024) {
    await new Promise(r => setTimeout(r, 30));
  }
}

function _dataUrlToBuffer(dataUrl) {
  const b64    = dataUrl.split(',')[1];
  const binary = atob(b64);
  const buf    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

async function sendSessionTo(conn) {
  try {
    const meta = window.getSessionMeta?.();
    if (!meta || meta.imageCount === 0) return;

    // Phase 1: instant skeleton — synchronous, no pixel reads
    conn.send(JSON.stringify({ type: 'session-meta', ...meta }));

    // Phase 2: thumbnails — precomputed small JPEGs, sent synchronously
    for (let i = 0; i < meta.imageCount; i++) {
      const thumb = window.getImageThumb?.(i);
      if (thumb) conn.send(JSON.stringify({ type: 'image-thumb', imgIdx: i, thumb }));
    }
    conn.send(JSON.stringify({ type: 'session-thumbs-done', total: meta.imageCount }));

    // Phase 3: full-res images as binary.
    // PeerJS chunks ArrayBuffers automatically (never chunks JSON strings), so large images
    // that would overflow the WebRTC send buffer are safely fragmented.
    showSendProgress('Sending 1/' + meta.imageCount + '...', 0);
    for (let i = 0; i < meta.imageCount; i++) {
      showSendProgress('Sending ' + (i + 1) + '/' + meta.imageCount + '...', i / meta.imageCount * 100);
      const packet = await window.getImageBuffer?.(i); // async JPEG encode, non-blocking
      await _waitDrain(conn);
      if (packet) {
        const { buffer, ...imgMeta } = packet;
        try {
          conn.send(JSON.stringify({ type: 'image-full-binary', imgIdx: i, ...imgMeta }));
          await new Promise(r => setTimeout(r, 0)); // yield before blocking chunk loop
          conn.send(buffer);
        } catch (e) { console.warn('[collab] image-full send failed for index', i, e); }
      }
      showSendProgress('Sending ' + (i + 1) + '/' + meta.imageCount + '...', (i + 1) / meta.imageCount * 100);
      try { conn.send(JSON.stringify({ type: 'session-host-progress', sent: i + 1, total: meta.imageCount })); }
      catch (_) {}
    }

    conn.send(JSON.stringify({ type: 'session-done' }));
    hideSendProgress();
  } catch (err) {
    hideSendProgress();
    console.warn('[collab] session send failed:', err);
  }
}

// ── Join as host ──────────────────────────────────────────────────────────────

function joinAsHost(roomCode) {
  const hid = hostIdFor(roomCode);
  peer = new Peer(hid, { debug: 0 });

  peer.on('open', id => {
    if (isHost) return; // signaling reconnect — data channels intact, skip reinit
    localPeerId = id;
    isHost      = true;
    setStatus('Connected - waiting for others', true);
    rafId = requestAnimationFrame(rafLoop);
    simCanvasEl.addEventListener('mousemove', onMouseMove);
    _startHostPing();
  });

  peer.on('connection', conn => {
    _guestLastPong.set(conn.peer, Date.now());
    guestConns.set(conn.peer, conn);
    setupConn(conn, true);
    updatePeerCount();
    _broadcastPeerCount();
    conn.on('open', () => {
      _broadcastPeerCount();
      const cs = window.getCollabState ? window.getCollabState() : null;
      if (cs && cs.imageCount > 0) sendSessionTo(conn);
    });
  });

  peer.on('disconnected', () => {
    if (peer && !peer.destroyed) peer.reconnect();
  });

  peer.on('error', err => {
    if (err.type === 'unavailable-id') {
      peer.destroy();
      peer = null;
      joinAsGuest(roomCode);
    } else {
      setStatus('Connection error: ' + err.type);
      console.warn('[collab] host peer error:', err);
    }
  });
}

// ── Join as guest ─────────────────────────────────────────────────────────────

function joinAsGuest(roomCode, retries = 0) {
  peer = new Peer({ debug: 0 });

  peer.on('open', id => {
    localPeerId = id;
    isHost      = false;
    rafId       = requestAnimationFrame(rafLoop);
    simCanvasEl.addEventListener('mousemove', onMouseMove);

    const hid = hostIdFor(roomCode);
    hostConn  = peer.connect(hid, { reliable: true });

    hostConn.on('open', () => {
      setStatus('Connected', true);
      updatePeerCount();
      const cs = window.getCollabState ? window.getCollabState() : null;
      if (!cs || cs.imageCount === 0) showGuestPrompt('Waiting for session from host...');
    });

    setupConn(hostConn, false);

    peer.on('error', err => {
      if (err.type === 'peer-unavailable' && retries < 4) {
        peer.destroy();
        peer        = null;
        localPeerId = null;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        simCanvasEl.removeEventListener('mousemove', onMouseMove);
        setStatus('Waiting for host...');
        setTimeout(() => joinAsGuest(roomCode, retries + 1), 1500);
      } else {
        setStatus('Could not reach host');
        console.warn('[collab] guest peer error:', err);
      }
    });
  });
}

// ── Join / leave ──────────────────────────────────────────────────────────────

function joinRoom(code) {
  if (peer) leaveRoom();
  currentRoom = code.trim();
  if (!currentRoom) return;

  setStatus('Connecting...');
  setRoomParam(currentRoom);

  joinAsHost(currentRoom);

  btnJoin.classList.add('im-hidden');
  btnLeave.classList.remove('im-hidden');
  btnCollab.classList.add('im-collab-live');
}

function leaveRoom() {
  if (!peer) return;

  broadcast({ type: 'cursor-leave', id: localPeerId });

  clearInterval(_hostPingTimer); _hostPingTimer = null;
  clearTimeout(_reconnectTimer); _reconnectTimer = null;
  _guestLastPong.clear();

  guestConns.forEach(conn => { try { conn.close(); } catch (_) {} });
  guestConns.clear();
  if (hostConn) { try { hostConn.close(); } catch (_) {} hostConn = null; }

  peer.destroy();
  peer        = null;
  localPeerId = null;
  isHost          = false;
  remotePeerCount = 0;
  currentRoom     = null;

  simCanvasEl.removeEventListener('mousemove', onMouseMove);
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  peerEls.forEach((_, id) => removeCursorEl(id));
  peerEls.clear();
  remoteCursors.clear();
  for (const imgIdx of grabbedByPeer.keys()) {
    window.dispatchEvent(new CustomEvent('collab:remote-release', { detail: { imgIdx } }));
  }
  grabbedByPeer.clear();
  hideGuestPrompt();

  btnJoin.classList.remove('im-hidden');
  btnLeave.classList.add('im-hidden');
  btnCollab.classList.remove('im-collab-live');
  collabPeerBadge.classList.add('im-hidden');
  setStatus('Not connected');

  const u = new URL(window.location.href);
  u.searchParams.delete('room');
  window.history.replaceState(null, '', u.toString());
}

// ── App event hooks ───────────────────────────────────────────────────────────


window.addEventListener('collab:settings-changed', ({ detail }) => {
  if (!localPeerId) return;
  broadcast({ type: 'settings', settings: detail });
});

window.addEventListener('collab:rank-order-changed', ({ detail: { order } }) => {
  if (!localPeerId) return;
  broadcast({ type: 'rank-order', order });
});

window.addEventListener('collab:images-added', async ({ detail: { indices } }) => {
  if (!localPeerId) return;
  const packets = await Promise.all(indices.map(idx => window.getImagePacket(idx)));
  for (const packet of packets) {
    if (packet) broadcast({ type: 'image', ...packet });
  }
});

window.addEventListener('collab:image-removed', ({ detail: { imgIdx } }) => {
  if (!localPeerId) return;
  broadcast({ type: 'image-removed', imgIdx });
});

window.addEventListener('collab:canvas-resized', () => {
  if (!localPeerId) return;
  const positions = window.getSimPositions ? window.getSimPositions() : {};
  const bounds    = window.getSimBounds    ? window.getSimBounds()    : {};
  broadcast({ type: 'positions', positions, ...bounds });
});

window.addEventListener('collab:scales-changed', ({ detail: { scales } }) => {
  if (!localPeerId) return;
  broadcast({ type: 'scales', scales });
});

window.addEventListener('collab:encoding-ready', ({ detail: { imgIdx } }) => {
  if (!localPeerId) return;
  const packet = window.getEncodingPacket ? window.getEncodingPacket(imgIdx) : null;
  if (!packet) return;
  broadcast({ type: 'encoding', ...packet });
});

window.addEventListener('collab:body-dragging', ({ detail }) => {
  if (!localPeerId) return;
  broadcast({ type: 'drag', imgIdx: detail.imgIdx, x: detail.x, y: detail.y, angle: detail.angle });
});

window.addEventListener('collab:body-grabbing', ({ detail: { imgIdx } }) => {
  if (!localPeerId) return;
  broadcast({ type: 'grab', imgIdx, color: getLocalColor() });
});

window.addEventListener('collab:body-releasing', ({ detail: { imgIdx } }) => {
  if (!localPeerId) return;
  broadcast({ type: 'release', imgIdx });
});

window.addEventListener('collab:polygon-changed', ({ detail: { imgIdx, polygons } }) => {
  if (!localPeerId) return;
  broadcast({ type: 'polygon', imgIdx, polygons });
});

// ── Sim undo ──────────────────────────────────────────────────────────────────

window.addEventListener('collab:body-lift', ({ detail }) => {
  preLiftState.set(detail.imgIdx, {
    prevX: detail.prevX, prevY: detail.prevY, prevAngle: detail.prevAngle,
  });
});

window.addEventListener('collab:body-moved', ({ detail }) => {
  const pre = preLiftState.get(detail.imgIdx);
  if (pre) {
    simUndoStack.push({ imgIdx: detail.imgIdx, x: pre.prevX, y: pre.prevY, angle: pre.prevAngle });
    if (simUndoStack.length > SIM_UNDO_MAX) simUndoStack.shift();
    preLiftState.delete(detail.imgIdx);
    simRedoStack.length = 0;
    updateRedoBtn();
  }
  if (localPeerId) {
    broadcast({ type: 'positions', positions: { [detail.imgIdx]: { x: detail.x, y: detail.y, angle: detail.angle } } });
  }
  updateUndoBtn();
});

function updateUndoBtn() { btnUndo.disabled = simUndoStack.length === 0; }
function updateRedoBtn() { btnRedo.disabled = simRedoStack.length === 0; }

function _dispatchUndoRedo(eventPrefix, entry) {
  if (!entry.type || entry.type === 'body-move') {
    window.dispatchEvent(new CustomEvent(eventPrefix + '-body-move', { detail: entry }));
  } else if (entry.type === 'reset') {
    window.dispatchEvent(new CustomEvent(eventPrefix + '-reset', { detail: entry }));
  } else if (entry.type === 'resize') {
    window.dispatchEvent(new CustomEvent(eventPrefix + '-resize', { detail: entry }));
  }
}

btnUndo.addEventListener('click', () => {
  const entry = simUndoStack.pop();
  if (!entry) return;
  _dispatchUndoRedo('collab:undo', entry);
  if (localPeerId && (!entry.type || entry.type === 'body-move'))
    broadcast({ type: 'positions', positions: { [entry.imgIdx]: { x: entry.x, y: entry.y, angle: entry.angle } } });
  updateUndoBtn();
});

btnRedo.addEventListener('click', () => {
  const entry = simRedoStack.pop();
  if (!entry) return;
  _dispatchUndoRedo('collab:redo', entry);
  if (localPeerId && (!entry.type || entry.type === 'body-move'))
    broadcast({ type: 'positions', positions: { [entry.imgIdx]: { x: entry.x, y: entry.y, angle: entry.angle } } });
  updateRedoBtn();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!modal.classList.contains('im-hidden')) modal.classList.add('im-hidden');
    return;
  }
  if (!e.ctrlKey || e.key.toLowerCase() !== 'z') return;
  e.preventDefault();
  if (e.shiftKey) btnRedo.click(); else btnUndo.click();
});

window.addEventListener('collab:redo-push', ({ detail }) => {
  simRedoStack.push(detail);
  if (simRedoStack.length > SIM_UNDO_MAX) simRedoStack.shift();
  updateRedoBtn();
});

window.addEventListener('collab:undo-push', ({ detail }) => {
  simUndoStack.push(detail);
  if (simUndoStack.length > SIM_UNDO_MAX) simUndoStack.shift();
  updateUndoBtn();
});

window.addEventListener('collab:pre-reset', ({ detail }) => {
  simUndoStack.push({ type: 'reset', groups: detail.groups });
  if (simUndoStack.length > SIM_UNDO_MAX) simUndoStack.shift();
  simRedoStack.length = 0;
  updateUndoBtn();
  updateRedoBtn();
});

window.addEventListener('collab:resize-done', ({ detail }) => {
  simUndoStack.push({
    type: 'resize',
    x1: detail.oldX1, y1: detail.oldY1,
    x2: detail.oldX2, y2: detail.oldY2,
  });
  if (simUndoStack.length > SIM_UNDO_MAX) simUndoStack.shift();
  simRedoStack.length = 0;
  updateUndoBtn();
  updateRedoBtn();
});

// ── UI wiring ─────────────────────────────────────────────────────────────────

btnCollab.addEventListener('click', () => { modal.classList.remove('im-hidden'); _updateQR(); });
btnClose.addEventListener('click',  () => modal.classList.add('im-hidden'));
modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('im-hidden'); });

roomInp.addEventListener('input', _updateQR);

btnJoin.addEventListener('click', () => {
  const code = roomInp.value.trim() || randomRoomCode();
  roomInp.value = code;
  localStorage.setItem(STORAGE_NAME_KEY, nameInp.value.trim());
  joinRoom(code);
  _updateQR();
});

btnLeave.addEventListener('click', leaveRoom);

btnCopy.addEventListener('click', () => {
  const code = roomInp.value.trim() || randomRoomCode();
  setRoomParam(code);
  const u = new URL(window.location.href);
  navigator.clipboard.writeText(u.toString()).then(() => {
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = 'Copy link'; }, 1800);
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────

const savedName = localStorage.getItem(STORAGE_NAME_KEY);
if (savedName) nameInp.value = savedName;

const urlRoom = getRoomParam();
if (urlRoom) {
  roomInp.value = urlRoom;
  setTimeout(() => joinRoom(urlRoom), 600);
} else {
  roomInp.value = randomRoomCode();
}

// Reconnect guest when returning from background (mobile browsers suspend WebRTC)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (isHost || !currentRoom) return;
  if (!hostConn || !hostConn.open) _scheduleReconnect();
});

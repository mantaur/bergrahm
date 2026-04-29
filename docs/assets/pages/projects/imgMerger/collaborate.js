// Pure PeerJS collaboration — no y-webrtc, no external signaling server.
//
// Topology: star (hub-and-spoke).
//   Host claims a deterministic PeerJS ID derived from the room code.
//   Guests connect to that ID.
//   Host rebroadcasts every message to all other peers.
//
// Protocol messages (JSON strings over reliable data channel):
//   { type: 'cursor',        id, x, y, name, color }
//   { type: 'cursor-leave',  id }
//   { type: 'settings',      settings }
//   { type: 'rank-order',    order }
//   { type: 'positions',     positions }
//   { type: 'image',         ...imagePacketFields }
//   { type: 'session-start', totalBytes }
//   [ArrayBuffer chunks...]
//   { type: 'session-end' }

// ── Constants ─────────────────────────────────────────────────────────────────

const COLORS = [
  '#e05252', '#4a9eed', '#52c97a', '#e0a033',
  '#9b6be0', '#30b5be', '#e0709a', '#8fbe4a',
];
const STORAGE_NAME_KEY = 'collab-name';
const CHUNK_SIZE        = 64 * 1024;
const SIM_UNDO_MAX      = 50;
const HOST_PREFIX       = 'im-mrg-'; // prefix for deterministic host peer IDs

// ── DOM ───────────────────────────────────────────────────────────────────────

const modal       = document.getElementById('collab-modal');
const btnCollab   = document.getElementById('btn-collab');
const btnClose    = document.getElementById('btn-collab-close');
const btnJoin     = document.getElementById('btn-collab-join');
const btnLeave    = document.getElementById('btn-collab-leave');
const btnCopy     = document.getElementById('btn-collab-copy');
const btnUndo     = document.getElementById('btn-sim-undo');
const nameInp     = document.getElementById('collab-name-inp');
const roomInp     = document.getElementById('collab-room-inp');
const statusEl    = document.getElementById('collab-status');
const cursorLayer = document.getElementById('collab-cursor-layer');
const guestPrompt = document.getElementById('collab-guest-prompt');
const guestMsg    = document.getElementById('collab-guest-msg');
const progressBar = document.getElementById('collab-progress-bar');
const simCanvasEl = document.getElementById('sim-canvas');

// ── Runtime state ─────────────────────────────────────────────────────────────

let peer        = null;
let localPeerId = null;
let isHost      = false;
let currentRoom = null;
let hostConn    = null;                 // guest's single connection to host
const guestConns = new Map();           // host's connections: peerId -> conn

// ── Cursor state ──────────────────────────────────────────────────────────────

let rafId = null;
const peerEls       = new Map(); // peerId -> { el, label }
const remoteCursors = new Map(); // peerId -> { x, y, name, color }

// ── Sim undo ──────────────────────────────────────────────────────────────────

const simUndoStack = [];
const preLiftState = new Map();

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

function setStatus(text, connected) {
  statusEl.textContent = text;
  statusEl.classList.toggle('im-collab-connected', !!connected);
}

function updatePeerCount() {
  const count = isHost ? guestConns.size : (hostConn ? 1 : 0);
  setStatus(
    count === 0 ? 'Connected - waiting for others'
                : `Connected (${count} peer${count > 1 ? 's' : ''})`,
    true
  );
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
    entry = { el, label };
    peerEls.set(peerId, entry);
  }
  entry.label.textContent       = cursorState.name  || 'Anonymous';
  entry.label.style.background  = cursorState.color;
  entry.el.querySelector('svg path').setAttribute('fill', cursorState.color);
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
      window.dispatchEvent(new CustomEvent('collab:remote-positions', { detail: { positions: msg.positions } }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'image':
      window.dispatchEvent(new CustomEvent('collab:remote-image', { detail: msg }));
      if (isHost) broadcast(msg, fromPeerId);
      break;

    case 'encoding':
      window.dispatchEvent(new CustomEvent('collab:remote-encoding', { detail: msg }));
      if (isHost) broadcast(msg, fromPeerId);
      break;
  }
}

// ── Data connection setup ─────────────────────────────────────────────────────

function setupConn(conn, role) {
  // role: 'guest-side' (host receiving from guest) | 'host-side' (guest's conn to host)
  let receiving = null;

  conn.on('data', data => {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      if (!receiving) return;
      const buf = ArrayBuffer.isView(data)
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
      receiving.chunks.push(buf);
      const got = receiving.chunks.reduce((s, c) => s + c.byteLength, 0);
      updateProgress(Math.round(got / receiving.totalBytes * 100));
      return;
    }
    if (typeof data !== 'string') return;
    const msg = JSON.parse(data);

    if (msg.type === 'session-start') {
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
    if (role === 'guest-side') {
      guestConns.delete(conn.peer);
      removeCursorEl(conn.peer);
      updatePeerCount();
    } else {
      hostConn = null;
      setStatus('Disconnected from host');
    }
  });

  conn.on('error', err => console.warn('[collab] conn error:', err));
}

// ── Session ZIP send ──────────────────────────────────────────────────────────

async function sendSessionTo(conn) {
  try {
    const blob = await window.buildSessionBlob(() => {});
    const buf  = await blob.arrayBuffer();
    conn.send(JSON.stringify({ type: 'session-start', totalBytes: buf.byteLength }));
    for (let i = 0; i < buf.byteLength; i += CHUNK_SIZE) {
      conn.send(buf.slice(i, i + CHUNK_SIZE));
    }
    conn.send(JSON.stringify({ type: 'session-end' }));
  } catch (err) {
    console.warn('[collab] session send failed:', err);
  }
}

// ── Join as host ──────────────────────────────────────────────────────────────

function joinAsHost(roomCode, retries = 0) {
  const hid = hostIdFor(roomCode);
  peer = new Peer(hid, { debug: 0 });

  peer.on('open', id => {
    localPeerId = id;
    isHost      = true;
    setStatus('Connected - waiting for others', true);
    rafId = requestAnimationFrame(rafLoop);
    simCanvasEl.addEventListener('mousemove', onMouseMove);
  });

  peer.on('connection', conn => {
    conn.on('open', () => {
      guestConns.set(conn.peer, conn);
      setupConn(conn, 'guest-side');

      // Send current session to the new guest if we have images
      const cs = window.getCollabState ? window.getCollabState() : null;
      if (cs && cs.imageCount > 0) sendSessionTo(conn);
      updatePeerCount();
    });
  });

  peer.on('error', err => {
    if (err.type === 'unavailable-id') {
      // Signaling server may still hold the old ID briefly after a refresh.
      // Retry a few times before falling back to guest.
      peer.destroy();
      peer = null;
      if (retries < 3) {
        setStatus('Waiting for room to free up...');
        setTimeout(() => joinAsHost(roomCode, retries + 1), 1500);
      } else {
        joinAsGuest(roomCode);
      }
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

    setupConn(hostConn, 'host-side');

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
  btnCollab.textContent = 'Live';
}

function leaveRoom() {
  if (!peer) return;

  broadcast({ type: 'cursor-leave', id: localPeerId });

  guestConns.forEach(conn => { try { conn.close(); } catch (_) {} });
  guestConns.clear();
  if (hostConn) { try { hostConn.close(); } catch (_) {} hostConn = null; }

  peer.destroy();
  peer        = null;
  localPeerId = null;
  isHost      = false;
  currentRoom = null;

  simCanvasEl.removeEventListener('mousemove', onMouseMove);
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  peerEls.forEach((_, id) => removeCursorEl(id));
  peerEls.clear();
  remoteCursors.clear();
  hideGuestPrompt();

  btnJoin.classList.remove('im-hidden');
  btnLeave.classList.add('im-hidden');
  btnCollab.textContent = 'Share';
  setStatus('Not connected');
}

// ── App event hooks ───────────────────────────────────────────────────────────

window.addEventListener('collab:freeze-changed', ({ detail }) => {
  if (!localPeerId || !detail.frozen) return;
  const positions = window.getSimPositions ? window.getSimPositions() : {};
  broadcast({ type: 'positions', positions });
});

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
  for (const idx of indices) {
    const packet = await window.getImagePacket(idx);
    if (!packet) continue;
    broadcast({ type: 'image', ...packet });
  }
});

window.addEventListener('collab:canvas-resized', () => {
  if (!localPeerId) return;
  const positions = window.getSimPositions ? window.getSimPositions() : {};
  broadcast({ type: 'positions', positions });
});

window.addEventListener('collab:encoding-ready', ({ detail: { imgIdx } }) => {
  if (!localPeerId) return;
  const packet = window.getEncodingPacket ? window.getEncodingPacket(imgIdx) : null;
  if (!packet) return;
  broadcast({ type: 'encoding', ...packet });
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
  }
  if (localPeerId) {
    broadcast({ type: 'positions', positions: { [detail.imgIdx]: { x: detail.x, y: detail.y, angle: detail.angle } } });
  }
  updateUndoBtn();
});

function updateUndoBtn() { btnUndo.disabled = simUndoStack.length === 0; }

btnUndo.addEventListener('click', () => {
  const entry = simUndoStack.pop();
  if (!entry) return;
  window.dispatchEvent(new CustomEvent('collab:undo-body-move', { detail: entry }));
  updateUndoBtn();
});

// ── UI wiring ─────────────────────────────────────────────────────────────────

btnCollab.addEventListener('click', () => modal.classList.remove('im-hidden'));
btnClose.addEventListener('click',  () => modal.classList.add('im-hidden'));
modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('im-hidden'); });

btnJoin.addEventListener('click', () => {
  const code = roomInp.value.trim() || randomRoomCode();
  roomInp.value = code;
  localStorage.setItem(STORAGE_NAME_KEY, nameInp.value.trim());
  joinRoom(code);
});

btnLeave.addEventListener('click', leaveRoom);

btnCopy.addEventListener('click', () => {
  const u = new URL(window.location.href);
  u.searchParams.set('room', roomInp.value.trim() || randomRoomCode());
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

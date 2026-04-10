// ── Image Merger ──────────────────────────────────────────────────────────────
// State
const state = {
  // config
  outW: 1080,
  outH: 1920,
  minScale: 0.5,
  maxScale: 2.0,
  fillColor: '#181a1b',
  useSam: false,
  samDecodeSize: 512,
  samWorkerCount: 4,

  // images[i] = { file, name, img, thumbUrl, w, h, polygons, currentPoly }
  images: [],

  // rank order: array of indices into state.images, index 0 = highest importance
  rankOrder: [],

  // painter state
  paintIdx: 0,   // which image is being painted (index into rankOrder)
  undoStack: [], // per-image undo stacks

};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const cfgUseSam     = document.getElementById('cfg-use-sam');
const cfgSamSize    = document.getElementById('cfg-sam-size');
const cfgSamWorkers = document.getElementById('cfg-sam-workers');
const cfgWidth      = document.getElementById('cfg-width');
const cfgHeight     = document.getElementById('cfg-height');
const cfgMinScale   = document.getElementById('cfg-min-scale');
const cfgMinScaleV  = document.getElementById('cfg-min-scale-val');
const cfgMaxScale   = document.getElementById('cfg-max-scale');
const cfgMaxScaleV  = document.getElementById('cfg-max-scale-val');
const cfgFill       = document.getElementById('cfg-fill');
const cfgImages     = document.getElementById('cfg-images');
const btnToPaint    = document.getElementById('btn-to-paint');

const secConfig     = document.getElementById('section-config');
const secPaint      = document.getElementById('section-paint');
const secMerge      = document.getElementById('section-merge');

const rankList      = document.getElementById('rank-list');
const paintName     = document.getElementById('paint-image-name');
const paintIndexLbl = document.getElementById('paint-index-label');
const btnUndo       = document.getElementById('btn-undo');
const btnClearMask  = document.getElementById('btn-clear-mask');
const btnPrev       = document.getElementById('btn-prev-img');
const btnNext       = document.getElementById('btn-next-img');
const btnToMerge    = document.getElementById('btn-to-merge');
const canvasWrap    = document.getElementById('canvas-wrap');
const paintCanvas   = document.getElementById('paint-canvas');
const maskCanvas    = document.getElementById('mask-canvas');

const samControls   = document.getElementById('sam-controls');
const btnSamToggle  = document.getElementById('btn-sam-toggle');
const samStatus     = document.getElementById('sam-status');

const painterScaleAuto    = document.getElementById('painter-scale-auto');
const painterScaleInp     = document.getElementById('painter-scale-inp');
const painterZoomVal      = document.getElementById('painter-zoom-val');
const scalePreviewCanvas  = document.getElementById('painter-scale-preview');

const btnMerge      = document.getElementById('btn-merge');
const mergeLog      = document.getElementById('merge-log');
const outputWrap    = document.getElementById('output-wrap');
const outputCanvas  = document.getElementById('output-canvas');
const btnDownload   = document.getElementById('btn-download');
const btnBackPaint  = document.getElementById('btn-back-to-paint');

const paintCtx      = paintCanvas.getContext('2d');
const maskCtx       = maskCanvas.getContext('2d');
const outCtx        = outputCanvas.getContext('2d');

// ── Config step ───────────────────────────────────────────────────────────────
cfgMinScale.addEventListener('input', () => {
  let v = parseFloat(cfgMinScale.value);
  if (v > parseFloat(cfgMaxScale.value)) {
    v = parseFloat(cfgMaxScale.value);
    cfgMinScale.value = v;
  }
  cfgMinScaleV.textContent = v.toFixed(2) + '×';
  state.minScale = v;
});

cfgMaxScale.addEventListener('input', () => {
  let v = parseFloat(cfgMaxScale.value);
  if (v < parseFloat(cfgMinScale.value)) {
    v = parseFloat(cfgMinScale.value);
    cfgMaxScale.value = v;
  }
  cfgMaxScaleV.textContent = v.toFixed(2) + '×';
  state.maxScale = v;
});

// ── Painter scale bar ─────────────────────────────────────────────────────────
painterScaleAuto.addEventListener('change', () => {
  const imgIdx = state.rankOrder[state.paintIdx];
  const entry  = state.images[imgIdx];
  painterScaleInp.disabled = painterScaleAuto.checked;
  entry.scale = painterScaleAuto.checked ? null : parseFloat(painterScaleInp.value);
  updatePainterZoom(imgIdx);
});

painterScaleInp.addEventListener('change', () => {
  const imgIdx = state.rankOrder[state.paintIdx];
  const entry  = state.images[imgIdx];
  let v = parseFloat(painterScaleInp.value);
  if (isNaN(v)) v = 1.0;
  v = Math.max(0.05, Math.min(20, v));
  painterScaleInp.value = v.toFixed(2);
  entry.scale = v;
  updatePainterZoom(imgIdx);
});

function updatePainterZoom(imgIdx) {
  const entry = state.images[imgIdx];
  if (entry.scale === null) {
    painterZoomVal.textContent = 'auto';
  } else {
    const displayW = Math.min(DISPLAY_MAX_W, entry.w);
    const outputW  = entry.w * entry.scale;
    painterZoomVal.textContent = Math.round((displayW / outputW) * 100) + '%';
  }
  updateScalePreview(imgIdx);
}

function updateScalePreview(imgIdx) {
  const entry = state.images[imgIdx];
  const outW  = state.outW;
  const outH  = state.outH;
  const ctx   = scalePreviewCanvas.getContext('2d');
  const CW    = scalePreviewCanvas.width;
  const CH    = scalePreviewCanvas.height;

  const resolvedScale = entry.scale === null ? computeAutoScales()[imgIdx].scale : entry.scale;
  const imgW = entry.w * resolvedScale;
  const imgH = entry.h * resolvedScale;

  // Fit whichever is larger (output or image) into the canvas with a 1px margin.
  const fit = Math.min((CW - 2) / Math.max(outW, imgW), (CH - 2) / Math.max(outH, imgH));

  ctx.clearRect(0, 0, CW, CH);

  // Output rect (gray)
  ctx.strokeStyle = '#666';
  ctx.lineWidth   = 1;
  ctx.strokeRect(1.5, 1.5, Math.round(outW * fit), Math.round(outH * fit));

  // Image rect at target scale (green = manual, gray = auto estimate)
  ctx.strokeStyle = entry.scale === null ? '#888' : 'springgreen';
  ctx.strokeRect(1.5, 1.5, Math.round(imgW * fit), Math.round(imgH * fit));
}

cfgImages.addEventListener('change', () => {
  const files = Array.from(cfgImages.files);
  if (!files.length) return;
  state.images = [];
  state.rankOrder = [];
  let loaded = 0;
  files.forEach((file, i) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      state.images[i] = {
        file,
        name: file.name,
        img,
        thumbUrl: url,
        w,
        h,
        polygons:    [],  // completed essential-region polygons [{x,y}...]
        currentPoly: [],  // polygon currently being drawn
        scale:       null, // null = auto, number = manual fixed scale
      };
      loaded++;
      if (loaded === files.length) {
        // init rank order 0..n-1
        state.rankOrder = state.images.map((_, idx) => idx);
        // init undo stacks per image
        state.undoStack = state.images.map(() => []);
        btnToPaint.disabled = false;
      }
    };
    img.src = url;
  });
});

btnToPaint.addEventListener('click', () => {
  state.outW      = parseInt(cfgWidth.value) || 1080;
  state.outH      = parseInt(cfgHeight.value) || 1920;
  state.fillColor     = cfgFill.value;
  state.useSam        = cfgUseSam.checked;
  state.samDecodeSize   = Math.max(64, parseInt(cfgSamSize.value)    || 512);
  state.samWorkerCount  = Math.max(1,  parseInt(cfgSamWorkers.value) || 4);
  showSection('paint');
  buildRankList();
  loadPainterImage(0);
  if (state.useSam) {
    samControls.classList.remove('im-hidden');
    initSamPool();
  } else {
    samControls.classList.add('im-hidden');
  }
});

// ── Section navigation ────────────────────────────────────────────────────────
function showSection(name) {
  secConfig.classList.add('im-hidden');
  secPaint.classList.add('im-hidden');
  secMerge.classList.add('im-hidden');
  if (name === 'config') secConfig.classList.remove('im-hidden');
  if (name === 'paint')  secPaint.classList.remove('im-hidden');
  if (name === 'merge')  secMerge.classList.remove('im-hidden');
}

btnToMerge.addEventListener('click', () => showSection('merge'));
btnBackPaint.addEventListener('click', () => showSection('paint'));

// ── Rank list (drag-to-reorder) ───────────────────────────────────────────────
function buildRankList() {
  rankList.innerHTML = '';
  samPool.dots.clear();
  state.rankOrder.forEach((imgIdx, rank) => {
    const item = createRankItem(imgIdx, rank);
    rankList.appendChild(item);
  });
}

function createRankItem(imgIdx, rank) {
  const entry = state.images[imgIdx];
  const li = document.createElement('li');
  li.className = 'im-rank-item';
  li.dataset.imgIdx = imgIdx;
  li.draggable = true;

  const badge = document.createElement('span');
  badge.className = 'im-rank-badge';
  badge.textContent = '#' + (rank + 1);

  li.appendChild(badge);

  // SAM encoding status dot — only visible when SAM is enabled
  if (state.useSam) {
    const encoded = samPool.embeddingCache.has(imgIdx);
    const dot = document.createElement('span');
    dot.className = 'im-sam-dot' + (encoded ? ' im-sam-encoded' : '');
    dot.title = encoded ? 'Encoded' : 'Pending encoding';
    samPool.dots.set(imgIdx, dot);
    li.appendChild(dot);
  }

  const thumb = document.createElement('img');
  thumb.className = 'im-rank-thumb';
  thumb.src = entry.thumbUrl;
  thumb.alt = entry.name;

  const nameLbl = document.createElement('span');
  nameLbl.textContent = entry.name;

  const editBtn = document.createElement('button');
  editBtn.className = 'im-rank-edit-btn' + (state.rankOrder[state.paintIdx] === imgIdx ? ' active' : '');
  editBtn.textContent = 'Edit mask';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const newPaintIdx = state.rankOrder.indexOf(imgIdx);
    loadPainterImage(newPaintIdx);
  });

  li.appendChild(thumb);
  li.appendChild(nameLbl);
  li.appendChild(editBtn);

  // Drag events
  li.addEventListener('dragstart', onDragStart);
  li.addEventListener('dragover',  onDragOver);
  li.addEventListener('dragleave', onDragLeave);
  li.addEventListener('drop',      onDrop);
  li.addEventListener('dragend',   onDragEnd);

  return li;
}

let dragSrcIdx = null; // index in rankOrder

function onDragStart(e) {
  dragSrcIdx = Array.from(rankList.children).indexOf(e.currentTarget);
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}

function onDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

function onDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const destIdx = Array.from(rankList.children).indexOf(e.currentTarget);
  if (dragSrcIdx === null || dragSrcIdx === destIdx) return;
  // reorder rankOrder
  const moved = state.rankOrder.splice(dragSrcIdx, 1)[0];
  state.rankOrder.splice(destIdx, 0, moved);
  // keep paintIdx tracking the same image
  const currentImgIdx = state.rankOrder[state.paintIdx];
  buildRankList();
  state.paintIdx = state.rankOrder.indexOf(currentImgIdx);
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  dragSrcIdx = null;
}

// ── Painter ───────────────────────────────────────────────────────────────────
const MAX_UNDO = 30;
const DISPLAY_MAX_W = 860; // max display width for painter canvas

function loadPainterImage(rankIdx) {
  state.paintIdx = rankIdx;
  const imgIdx  = state.rankOrder[rankIdx];
  const entry   = state.images[imgIdx];

  paintName.textContent = entry.name;
  paintIndexLbl.textContent = (rankIdx + 1) + ' / ' + state.images.length;

  // Size the canvases to a display-friendly scale
  const scale   = Math.min(1, DISPLAY_MAX_W / entry.w);
  const dispW   = Math.round(entry.w * scale);
  const dispH   = Math.round(entry.h * scale);

  paintCanvas.width  = entry.w;
  paintCanvas.height = entry.h;
  maskCanvas.width   = entry.w;
  maskCanvas.height  = entry.h;

  paintCanvas.style.width  = dispW + 'px';
  paintCanvas.style.height = dispH + 'px';
  maskCanvas.style.width   = dispW + 'px';
  maskCanvas.style.height  = dispH + 'px';

  paintCtx.drawImage(entry.img, 0, 0);
  currentPoly  = entry.currentPoly; // point at this image's in-progress polygon
  rubberBandPt = null;
  redrawPolyOverlay(imgIdx);

  // Sync painter scale bar to this image's scale setting
  const isAuto = entry.scale === null;
  painterScaleAuto.checked    = isAuto;
  painterScaleInp.disabled    = isAuto;
  painterScaleInp.value       = (isAuto ? 1.0 : entry.scale).toFixed(2);

  // Size the preview canvas to match the output aspect ratio (max 80px per side).
  const PREVIEW_MAX = 80;
  const ar = state.outW / state.outH;
  scalePreviewCanvas.width  = ar >= 1 ? PREVIEW_MAX : Math.round(PREVIEW_MAX * ar);
  scalePreviewCanvas.height = ar >= 1 ? Math.round(PREVIEW_MAX / ar) : PREVIEW_MAX;

  updatePainterZoom(imgIdx);

  // Update edit buttons in rank list
  rankList.querySelectorAll('.im-rank-edit-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === rankIdx);
  });

  updateUndoBtn(imgIdx);
  btnPrev.disabled = rankIdx === 0;
  btnNext.disabled = rankIdx === state.images.length - 1;

  // On navigation, discard any stale pending decode and update the status text.
  // The encode queue is left untouched — it runs in filename order regardless.
  if (state.useSam && samPool.readyCount > 0) {
    samPool.pendingDecode = null;
    updateSamStatus(samPool.embeddingCache.has(imgIdx)
      ? (samPool.samMode ? 'Click a subject to segment' : 'SAM ready')
      : 'Encoding\u2026');
  }
}

// ── Lasso / polygon overlay ───────────────────────────────────────────────────
const SNAP_RADIUS_PX = 15; // snap-to-close distance in display pixels

// currentPoly is reassigned to entry.currentPoly on each image load so mutations
// persist automatically when navigating between images.
let currentPoly  = [];
let rubberBandPt = null;

function getCanvasPos(e) {
  const rect   = paintCanvas.getBoundingClientRect();
  const scaleX = paintCanvas.width  / rect.width;
  const scaleY = paintCanvas.height / rect.height;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top)  * scaleY,
  };
}

/** Snap radius in canvas-native pixels (accounts for display scaling). */
function snapRadius() {
  return SNAP_RADIUS_PX * (paintCanvas.width / paintCanvas.getBoundingClientRect().width);
}

function redrawPolyOverlay(imgIdx) {
  const entry = state.images[imgIdx];
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);

  // Completed polygons
  for (const poly of entry.polygons) {
    drawPoly(poly, 'rgba(255,51,102,0.22)', '#ff3366', true);
  }

  // In-progress polygon + rubber band
  if (currentPoly.length > 0) {
    maskCtx.beginPath();
    maskCtx.moveTo(currentPoly[0].x, currentPoly[0].y);
    for (let i = 1; i < currentPoly.length; i++) {
      maskCtx.lineTo(currentPoly[i].x, currentPoly[i].y);
    }
    if (rubberBandPt) maskCtx.lineTo(rubberBandPt.x, rubberBandPt.y);
    maskCtx.setLineDash([6, 4]);
    maskCtx.strokeStyle = 'rgba(255,220,0,0.9)';
    maskCtx.lineWidth   = 1.5;
    maskCtx.stroke();
    maskCtx.setLineDash([]);

    // Snap ring on first vertex once closeable
    if (currentPoly.length >= 3) {
      maskCtx.beginPath();
      maskCtx.arc(currentPoly[0].x, currentPoly[0].y, snapRadius(), 0, Math.PI * 2);
      maskCtx.strokeStyle = 'rgba(255,255,80,0.45)';
      maskCtx.lineWidth   = 1;
      maskCtx.stroke();
    }

    // Vertex dots for in-progress poly
    currentPoly.forEach((v, i) => {
      maskCtx.beginPath();
      maskCtx.arc(v.x, v.y, i === 0 ? 6 : 3, 0, Math.PI * 2);
      maskCtx.fillStyle = i === 0 ? '#ffee44' : '#ff3366';
      maskCtx.fill();
    });
  }
}

function drawPoly(poly, fillStyle, strokeStyle, closed) {
  if (poly.length < 2) return;
  maskCtx.beginPath();
  maskCtx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) maskCtx.lineTo(poly[i].x, poly[i].y);
  if (closed) maskCtx.closePath();
  maskCtx.fillStyle   = fillStyle;
  maskCtx.fill();
  maskCtx.strokeStyle = strokeStyle;
  maskCtx.lineWidth   = 1.5;
  maskCtx.stroke();
  poly.forEach(v => {
    maskCtx.beginPath();
    maskCtx.arc(v.x, v.y, 3, 0, Math.PI * 2);
    maskCtx.fillStyle = strokeStyle;
    maskCtx.fill();
  });
}

// ── Lasso interaction ─────────────────────────────────────────────────────────
canvasWrap.addEventListener('click', (e) => {
  const imgIdx = state.rankOrder[state.paintIdx];
  const entry  = state.images[imgIdx];
  const pos    = getCanvasPos(e);

  // SAM mode: use click as a segment prompt
  if (samPool.samMode) {
    if (samPool.readyCount === 0) return;
    requestDecode(pos.x, pos.y);
    return;
  }

  const snap   = snapRadius();

  // Close polygon when clicking near first vertex (need ≥3 vertices)
  if (currentPoly.length >= 3) {
    const dx = pos.x - currentPoly[0].x;
    const dy = pos.y - currentPoly[0].y;
    if (dx * dx + dy * dy <= snap * snap) {
      pushPolyUndo(imgIdx);
      entry.polygons.push(currentPoly.slice());
      currentPoly.length = 0; // clear in-place; entry.currentPoly clears too
      rubberBandPt = null;
      redrawPolyOverlay(imgIdx);
      updateUndoBtn(imgIdx);
      return;
    }
  }

  // Otherwise add a vertex
  pushPolyUndo(imgIdx);
  currentPoly.push({ x: pos.x, y: pos.y });
  redrawPolyOverlay(imgIdx);
  updateUndoBtn(imgIdx);
});

canvasWrap.addEventListener('mousemove', (e) => {
  if (currentPoly.length === 0) return;
  rubberBandPt = getCanvasPos(e);
  redrawPolyOverlay(state.rankOrder[state.paintIdx]);
});

canvasWrap.addEventListener('mouseleave', () => {
  if (currentPoly.length === 0) return;
  rubberBandPt = null;
  redrawPolyOverlay(state.rankOrder[state.paintIdx]);
});

// ── Polygon undo ──────────────────────────────────────────────────────────────
function pushPolyUndo(imgIdx) {
  const entry = state.images[imgIdx];
  state.undoStack[imgIdx].push({
    polygons:    entry.polygons.map(p => p.map(v => ({ x: v.x, y: v.y }))),
    currentPoly: currentPoly.map(v => ({ x: v.x, y: v.y })),
  });
  if (state.undoStack[imgIdx].length > MAX_UNDO) state.undoStack[imgIdx].shift();
}

function updateUndoBtn(imgIdx) {
  btnUndo.disabled = state.undoStack[imgIdx].length === 0;
}

btnUndo.addEventListener('click', () => {
  const imgIdx = state.rankOrder[state.paintIdx];
  const entry  = state.images[imgIdx];
  if (!state.undoStack[imgIdx].length) return;
  const snap = state.undoStack[imgIdx].pop();
  entry.polygons = snap.polygons;
  // Restore currentPoly in-place so the entry.currentPoly reference stays valid
  currentPoly.length = 0;
  snap.currentPoly.forEach(v => currentPoly.push(v));
  rubberBandPt = currentPoly.length > 0 ? rubberBandPt : null;
  redrawPolyOverlay(imgIdx);
  updateUndoBtn(imgIdx);
});

btnClearMask.addEventListener('click', () => {
  const imgIdx = state.rankOrder[state.paintIdx];
  const entry  = state.images[imgIdx];
  if (entry.polygons.length === 0 && currentPoly.length === 0) return;
  pushPolyUndo(imgIdx);
  entry.polygons = [];
  currentPoly.length = 0;
  rubberBandPt = null;
  redrawPolyOverlay(imgIdx);
  updateUndoBtn(imgIdx);
});

btnPrev.addEventListener('click', () => {
  if (state.paintIdx > 0) loadPainterImage(state.paintIdx - 1);
});

btnNext.addEventListener('click', () => {
  if (state.paintIdx < state.images.length - 1) loadPainterImage(state.paintIdx + 1);
});

// ── SAM (Segment Anything) — worker pool ──────────────────────────────────────
// Each worker runs @xenova/transformers in its own thread. Worker 0 downloads
// the model on first use; subsequent workers load from the browser cache.
// Workers are stateless: after encoding they serialize embeddings back to the
// main-thread cache and forget them. Any free worker can decode any cached image.
// Worker count is set from state.samWorkerCount at init time; use this alias.
let SAM_WORKER_COUNT = 4;

// Per-worker arrays (indexed 0..SAM_WORKER_COUNT-1)
const samPool = {
  workers:   [],   // Worker instances
  ready:     [],   // bool — model loaded
  busy:      [],   // bool — currently processing a job
  readyCount: 0,

  // Shared coordination
  samMode:        false,
  embeddingCache: new Map(), // imgIdx → { embeddings, originalSizes, reshapedSizes }
  dots:           new Map(), // imgIdx → dot span element (cached to avoid DOM queries)
  encodeQueue:    [],        // imgIdx[] awaiting dispatch
  pendingDecode:  null,      // {imgIdx, x, y} | null — only one slot; last click wins
};

function updateSamStatus(text, warn) {
  samStatus.textContent = text;
  samStatus.className   = 'im-sam-status' + (warn ? ' im-log-warn' : '');
}

function initSamPool() {
  SAM_WORKER_COUNT = state.samWorkerCount;
  if (location.protocol === 'file:') {
    updateSamStatus(
      'SAM requires HTTP \u2014 open a terminal in docs/ and run: python3 -m http.server 8080, ' +
      'then visit http://localhost:8080/assets/pages/projects/imageMerge.html',
      true
    );
    return;
  }
  for (let i = 0; i < SAM_WORKER_COUNT; i++) {
    const w = new Worker('samWorker.js');
    w.onmessage = (e) => onWorkerMsg(i, e.data);
    samPool.workers.push(w);
    samPool.ready.push(false);
    samPool.busy.push(false);
  }
  updateSamStatus('Downloading SAM model\u2026');
  // Only start worker 0 now; the rest start after it reports ready so they
  // benefit from the browser cache the first worker populates.
  samPool.workers[0].postMessage({ type: 'init' });
}

function onWorkerMsg(wIdx, msg) {
  switch (msg.type) {
    case 'ready':
      onWorkerReady(wIdx);
      break;
    case 'encoded':
      onEncoded(wIdx, msg);
      break;
    case 'mask':
      onMask(wIdx, msg);
      break;
    case 'progress':
      if (samPool.readyCount === 0) updateSamStatus(msg.text);
      break;
    case 'error':
      samPool.busy[wIdx] = false;
      updateSamStatus('SAM error: ' + msg.message, true);
      drainEncodeQueue();
      break;
  }
}

function onWorkerReady(wIdx) {
  samPool.ready[wIdx] = true;
  samPool.busy[wIdx]  = false;
  samPool.readyCount++;

  if (samPool.readyCount === 1) {
    // Model now in browser cache — start the remaining workers.
    for (let i = 1; i < SAM_WORKER_COUNT; i++) samPool.workers[i].postMessage({ type: 'init' });
    btnSamToggle.disabled = false;
    buildEncodeQueue(); // build once; navigation will never disrupt this queue
  }

  const all = samPool.readyCount === SAM_WORKER_COUNT;
  updateSamStatus(all
    ? (samPool.samMode ? 'Click a subject to segment' : 'SAM ready \u2014 toggle on then click a subject')
    : ('SAM loading (' + samPool.readyCount + '/' + SAM_WORKER_COUNT + ')\u2026')
  );
  drainEncodeQueue();
}

function onEncoded(wIdx, { imgIdx, embeddings, originalSizes, reshapedSizes }) {
  samPool.busy[wIdx] = false;
  // Store serialized embeddings in main-thread cache — permanent, no eviction.
  samPool.embeddingCache.set(imgIdx, { embeddings, originalSizes, reshapedSizes });

  // Flip the rank-list dot to green.
  const dot = samPool.dots.get(imgIdx);
  if (dot) { dot.classList.add('im-sam-encoded'); dot.title = 'Encoded'; }

  if (imgIdx === state.rankOrder[state.paintIdx]) {
    updateSamStatus(samPool.samMode ? 'Click a subject to segment' : 'SAM ready');
  }
  drainEncodeQueue();
}

function onMask(wIdx, { imgIdx, mask, width, height }) {
  samPool.busy[wIdx] = false;
  applyMaskAsPolygon(new Uint8Array(mask), width, height, imgIdx);
  // Fire any decode that arrived while all workers were busy.
  if (samPool.pendingDecode) {
    const pd = samPool.pendingDecode;
    samPool.pendingDecode = null;
    sendDecode(wIdx, pd);
  } else {
    drainEncodeQueue();
  }
}

// ── Worker coordination ───────────────────────────────────────────────────────

function freeWorkerIdx() {
  for (let i = 0; i < SAM_WORKER_COUNT; i++) {
    if (samPool.ready[i] && !samPool.busy[i]) return i;
  }
  return -1;
}

function drainEncodeQueue() {
  while (samPool.encodeQueue.length > 0) {
    const wIdx = freeWorkerIdx();
    if (wIdx === -1) break;
    const imgIdx = samPool.encodeQueue.shift();
    if (samPool.embeddingCache.has(imgIdx)) continue; // already cached
    sendEncode(wIdx, imgIdx);
  }
  // Once the queue is empty and no worker is still encoding, release surplus
  // workers — only worker 0 is kept alive for decoding.
  if (SAM_WORKER_COUNT > 1 && samPool.encodeQueue.length === 0 && !samPool.busy.some(Boolean)) {
    for (let i = 1; i < SAM_WORKER_COUNT; i++) samPool.workers[i].terminate();
    samPool.workers.length = 1;
    samPool.ready.length   = 1;
    samPool.busy.length    = 1;
    SAM_WORKER_COUNT       = 1;
  }
}

function sendEncode(wIdx, imgIdx) {
  samPool.busy[wIdx] = true;
  const entry = state.images[imgIdx];
  const tmp   = document.createElement('canvas');
  tmp.width   = entry.w;
  tmp.height  = entry.h;
  tmp.getContext('2d').drawImage(entry.img, 0, 0);
  const id = tmp.getContext('2d').getImageData(0, 0, entry.w, entry.h);
  samPool.workers[wIdx].postMessage(
    { type: 'encode', imgIdx, pixels: id.data.buffer, width: entry.w, height: entry.h },
    [id.data.buffer]
  );
}

function sendDecode(wIdx, { imgIdx, x, y }) {
  samPool.busy[wIdx] = true;
  updateSamStatus('Segmenting\u2026');
  const { embeddings, originalSizes, reshapedSizes } = samPool.embeddingCache.get(imgIdx);
  // Structured-clone copies the ArrayBuffers — cache stays intact for future decodes.
  samPool.workers[wIdx].postMessage({
    type: 'decode', imgIdx, x, y,
    decodeSize: state.samDecodeSize,
    embeddings, originalSizes, reshapedSizes,
  });
}

// Build the encode queue once, in filename order. Called when the first worker
// is ready. Navigation never clears or rebuilds this queue — encoding proceeds
// steadily through all images regardless of where the user is painting.
function buildEncodeQueue() {
  const sorted = [...state.images.keys()].sort((a, b) =>
    state.images[a].name.localeCompare(state.images[b].name, undefined, { sensitivity: 'base' })
  );
  for (const imgIdx of sorted) {
    if (!samPool.embeddingCache.has(imgIdx))
      samPool.encodeQueue.push(imgIdx);
  }
  drainEncodeQueue();
}

// Handle a user click in SAM mode.
function requestDecode(x, y) {
  const imgIdx = state.rankOrder[state.paintIdx];
  if (!samPool.embeddingCache.has(imgIdx)) {
    updateSamStatus('Not encoded yet \u2014 wait for the dot to turn green', true);
    return;
  }
  const wIdx = freeWorkerIdx();
  if (wIdx !== -1) {
    sendDecode(wIdx, { imgIdx, x, y });
  } else {
    // All workers busy encoding — store and fire when one becomes free.
    samPool.pendingDecode = { imgIdx, x, y };
  }
}

function applyMaskAsPolygon(maskData, width, height, forImgIdx) {
  if (forImgIdx !== state.rankOrder[state.paintIdx]) return; // stale result
  const poly = maskToPolygon(maskData, width, height);
  if (!poly || poly.length < 3) {
    updateSamStatus('No region found \u2014 try clicking a different point.', true);
    return;
  }
  const entry = state.images[forImgIdx];

  // Scale polygon from mask space back to original image space.
  const scaleX = entry.w / width;
  const scaleY = entry.h / height;
  const scaledPoly = (scaleX === 1 && scaleY === 1)
    ? poly
    : poly.map(pt => ({ x: pt.x * scaleX, y: pt.y * scaleY }));

  pushPolyUndo(forImgIdx);
  entry.polygons.push(scaledPoly);
  redrawPolyOverlay(forImgIdx);
  updateUndoBtn(forImgIdx);
  updateSamStatus('Segment added. Click for another or switch to manual mode.');
}

// Convert a flat Uint8Array mask (0=bg, 1=fg) to an [{x,y}...] polygon
// via a scanline boundary walk + Ramer-Douglas-Peucker simplification.
function maskToPolygon(mask, W, H) {
  const leftPts  = [];
  const rightPts = [];

  for (let y = 0; y < H; y++) {
    let lo = -1, hi = -1;
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (mask[row + x]) {
        if (lo === -1) lo = x;
        hi = x;
      }
    }
    if (lo !== -1) {
      leftPts.push({ x: lo, y });
      if (hi !== lo) rightPts.push({ x: hi, y });
    }
  }

  if (leftPts.length === 0) return null;
  const raw = leftPts.concat(rightPts.slice().reverse());
  return rdpSimplify(raw, 2.5);
}

// Ramer-Douglas-Peucker polyline simplification.
function rdpSimplify(pts, eps) {
  if (pts.length <= 2) return pts.slice();
  const first = pts[0], last = pts[pts.length - 1];
  const dx = last.x - first.x, dy = last.y - first.y;
  const lenSq = dx * dx + dy * dy;
  let maxDist = 0, maxIdx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    let dist;
    if (lenSq === 0) {
      const ex = pts[i].x - first.x, ey = pts[i].y - first.y;
      dist = Math.sqrt(ex * ex + ey * ey);
    } else {
      const t = ((pts[i].x - first.x) * dx + (pts[i].y - first.y) * dy) / lenSq;
      const px = first.x + t * dx, py = first.y + t * dy;
      const ex = pts[i].x - px,    ey = pts[i].y - py;
      dist = Math.sqrt(ex * ex + ey * ey);
    }
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist > eps) {
    const L = rdpSimplify(pts.slice(0, maxIdx + 1), eps);
    const R = rdpSimplify(pts.slice(maxIdx), eps);
    return L.slice(0, -1).concat(R);
  }
  return [first, last];
}

btnSamToggle.addEventListener('click', () => {
  samPool.samMode = !samPool.samMode;
  btnSamToggle.classList.toggle('im-sam-active', samPool.samMode);
  btnSamToggle.textContent = samPool.samMode ? 'SAM: On' : 'SAM: Off';
  if (samPool.samMode) {
    const imgIdx = state.rankOrder[state.paintIdx];
    updateSamStatus(samPool.embeddingCache.has(imgIdx)
      ? 'Click a subject to segment'
      : 'Not encoded yet \u2014 wait for the dot to turn green');
  } else {
    updateSamStatus('SAM ready');
  }
});

// ── Per-image auto-scale computation ──────────────────────────────────────────
function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    a += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return Math.abs(a) / 2;
}

// Returns an array of { scale, wasClamped, rawScale } — one entry per image.
// Images with manual scale pass through unchanged.
// Auto-scale images are sized so their essential region area equals the median
// across all images, then clamped to [state.minScale, state.maxScale].
function computeAutoScales() {
  const areas = state.images.map(entry =>
    entry.polygons.reduce((sum, poly) => sum + polyArea(poly), 0)
  );

  const validAreas = areas.filter(a => a > 0);
  const fallback   = (state.minScale + state.maxScale) / 2;

  let K = null; // target essential-region area in source pixels²
  if (validAreas.length > 0) {
    const sorted = validAreas.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    K = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  return state.images.map((entry, i) => {
    if (entry.scale !== null) return { scale: entry.scale, wasClamped: false };
    if (K === null || areas[i] <= 0) return { scale: fallback, wasClamped: false };
    const raw     = Math.sqrt(K / areas[i]);
    const clamped = Math.max(state.minScale, Math.min(state.maxScale, raw));
    return { scale: clamped, wasClamped: Math.abs(raw - clamped) > 0.001, rawScale: raw };
  });
}

// ── Merge algorithm (delegated to Web Worker) ─────────────────────────────────
const btnCancel = document.getElementById('btn-cancel');
let activeWorker = null;

btnMerge.addEventListener('click', startMerge);
btnCancel.addEventListener('click', cancelMerge);

function log(text, cls) {
  const span = document.createElement('span');
  span.className = cls || '';
  span.textContent = text + '\n';
  mergeLog.appendChild(span);
  mergeLog.scrollTop = mergeLog.scrollHeight;
}

function startMerge() {
  mergeLog.innerHTML = '';
  btnMerge.disabled = true;
  btnCancel.classList.remove('im-hidden');
  outputWrap.classList.add('im-hidden');
  btnDownload.classList.add('im-hidden');

  // Compute per-image scales (auto or manual), clamped to global min/max
  const autoScales = computeAutoScales();
  autoScales.forEach((r, i) => {
    if (r.wasClamped) {
      log(
        '[' + state.images[i].name + '] auto scale clamped: ' +
        r.rawScale.toFixed(2) + '× → ' + r.scale.toFixed(2) + '×',
        'im-log-warn'
      );
    }
  });

  // Deep-copy polygons + resolved scale to send to worker.
  // scaleFixed=true means the user set this scale manually — don't search over alternatives.
  const workerImages = state.images.map((entry, i) => ({
    w:          entry.w,
    h:          entry.h,
    name:       entry.name,
    scale:      autoScales[i].scale,
    scaleFixed: entry.scale !== null,
    polygons:   entry.polygons.map(p => p.map(v => ({ x: v.x, y: v.y }))),
  }));

  // Create worker from a Blob so it works on file:// without a local server.
  const workerSrc  = document.getElementById('merge-worker-src').textContent;
  const workerBlob = URL.createObjectURL(new Blob([workerSrc], { type: 'application/javascript' }));
  activeWorker = new Worker(workerBlob);
  activeWorker._blobUrl = workerBlob;

  function cleanupWorker() {
    URL.revokeObjectURL(activeWorker._blobUrl);
    activeWorker.terminate();
    activeWorker = null;
  }

  activeWorker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'log') {
      log(msg.text, msg.cls);
    } else if (msg.type === 'done') {
      cleanupWorker();
      finishMerge(msg.placements, msg.ownershipMap);
    } else if (msg.type === 'error') {
      cleanupWorker();
      log('Worker error: ' + msg.text, 'im-log-warn');
      resetMergeUI();
    }
  };

  activeWorker.onerror = (err) => {
    cleanupWorker();
    log('Worker error: ' + err.message, 'im-log-warn');
    resetMergeUI();
  };

  activeWorker.postMessage({
    images:    workerImages,
    rankOrder: Array.from(state.rankOrder),
    outW:      state.outW,
    outH:      state.outH,
    minScale:  state.minScale,
    maxScale:  state.maxScale,
  });
}

function cancelMerge() {
  if (activeWorker) {
    URL.revokeObjectURL(activeWorker._blobUrl);
    activeWorker.terminate();
    activeWorker = null;
    log('Merge cancelled.', 'im-log-warn');
  }
  resetMergeUI();
}

function resetMergeUI() {
  btnMerge.disabled = false;
  btnCancel.classList.add('im-hidden');
}

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// Sample a pixel from a pre-captured image data record.
// Returns [r,g,b] or null if the point is outside or fully transparent.
function sampleImgData(id, ox, oy) {
  if (ox < id.x0 || ox >= id.x1 || oy < id.y0 || oy >= id.y1) return null;
  const base = ((oy - id.y0) * id.rw + (ox - id.x0)) * 4;
  if (id.data[base + 3] === 0) return null;
  return [id.data[base], id.data[base + 1], id.data[base + 2]];
}

function finishMerge(placements, ownershipMap) {
  resetMergeUI();

  const W = state.outW, H = state.outH;
  outputCanvas.width  = W;
  outputCanvas.height = H;

  // Pre-render each placed image into a clipped canvas and capture its pixels.
  // The temp canvas is only as large as the region that overlaps the output,
  // so large-scale images don't create huge off-screen surfaces.
  const imgData = []; // { imgIdx, x0, y0, x1, y1, rw, data }
  for (const p of placements) {
    const entry   = state.images[p.imgIdx];
    const scaledW = Math.round(entry.w * p.scale);
    const scaledH = Math.round(entry.h * p.scale);
    const x0 = Math.max(0, p.x),           y0 = Math.max(0, p.y);
    const x1 = Math.min(W, p.x + scaledW), y1 = Math.min(H, p.y + scaledH);
    if (x1 <= x0 || y1 <= y0) { imgData.push(null); continue; }

    const rw = x1 - x0, rh = y1 - y0;
    const tmp = document.createElement('canvas');
    tmp.width = rw; tmp.height = rh;
    const tmpCtx = tmp.getContext('2d');
    // Draw only the source sub-region that maps to [x0..x1] × [y0..y1]
    const srcX = (x0 - p.x) / p.scale, srcY = (y0 - p.y) / p.scale;
    const srcW = rw / p.scale,          srcH = rh / p.scale;
    tmpCtx.drawImage(entry.img, srcX, srcY, srcW, srcH, 0, 0, rw, rh);
    imgData.push({ imgIdx: p.imgIdx, x0, y0, x1, y1, rw, data: tmpCtx.getImageData(0, 0, rw, rh).data });
  }

  // Index by imgIdx for O(1) owner lookup
  const imgDataByIdx = new Map();
  for (const id of imgData) { if (id) imgDataByIdx.set(id.imgIdx, id); }

  // Build output image pixel-by-pixel using ownership map
  const [fr, fg, fb] = hexToRgb(state.fillColor);
  const outImgData = outCtx.createImageData(W, H);
  const out = outImgData.data;

  for (let oy = 0; oy < H; oy++) {
    for (let ox = 0; ox < W; ox++) {
      const oi  = oy * W + ox;
      const out4 = oi * 4;

      // 1. Try the Voronoi owner (nearest essential region)
      let pixel = null;
      const owner = ownershipMap ? ownershipMap[oi] : -1;
      if (owner >= 0) pixel = sampleImgData(imgDataByIdx.get(owner), ox, oy);

      // 2. Fall back to highest-priority image that covers this pixel
      if (!pixel) {
        for (const id of imgData) {
          if (!id) continue;
          pixel = sampleImgData(id, ox, oy);
          if (pixel) break;
        }
      }

      if (pixel) {
        out[out4]     = pixel[0];
        out[out4 + 1] = pixel[1];
        out[out4 + 2] = pixel[2];
        out[out4 + 3] = 255;
      } else {
        out[out4]     = fr;
        out[out4 + 1] = fg;
        out[out4 + 2] = fb;
        out[out4 + 3] = 255;
      }
    }
  }

  outCtx.putImageData(outImgData, 0, 0);

  log(`Done. ${placements.length} / ${state.images.length} images placed.`,
      placements.length === state.images.length ? 'im-log-ok' : 'im-log-warn');

  const dispScale = Math.min(1, DISPLAY_MAX_W / W);
  outputCanvas.style.width  = Math.round(W * dispScale) + 'px';
  outputCanvas.style.height = Math.round(H * dispScale) + 'px';

  outputWrap.classList.remove('im-hidden');
  btnDownload.classList.remove('im-hidden');
}

// ── Download ──────────────────────────────────────────────────────────────────
btnDownload.addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = 'merged.png';
  link.href = outputCanvas.toDataURL('image/png');
  link.click();
});

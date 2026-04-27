// ── Image Merger ──────────────────────────────────────────────────────────────
const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || window.matchMedia('(pointer: coarse)').matches;

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

// ── Icon SVGs ─────────────────────────────────────────────────────────────────
const EYE_OPEN   = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8c1.5-3.5 4-5 7-5s5.5 1.5 7 5c-1.5 3.5-4 5-7 5s-5.5-1.5-7-5z"/><circle cx="8" cy="8" r="2.2"/></svg>';
const EYE_CLOSED = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8c1.5-3.5 4-5 7-5s5.5 1.5 7 5c-1.5 3.5-4 5-7 5s-5.5-1.5-7-5z"/><circle cx="8" cy="8" r="2.2"/><line x1="2" y1="2" x2="14" y2="14"/></svg>';
const REMOVE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const cfgUseSam          = document.getElementById('cfg-use-sam');
const cfgSamWorkers      = document.getElementById('cfg-sam-workers');
const cfgBlendMode       = document.getElementById('cfg-blend-mode');
const cfgDitherFields    = document.getElementById('cfg-dither-fields');
const cfgDitherExpField  = document.getElementById('cfg-dither-exp-field');
const cfgSeed            = document.getElementById('cfg-seed');
const cfgDitherExp       = document.getElementById('cfg-dither-exp');
const cfgWidth      = document.getElementById('cfg-width');
const cfgHeight     = document.getElementById('cfg-height');
const cfgUseScaleRange = document.getElementById('cfg-use-scale-range');
const cfgMinScale      = document.getElementById('cfg-min-scale');
const cfgMinScaleV     = document.getElementById('cfg-min-scale-val');
const cfgMaxScale      = document.getElementById('cfg-max-scale');
const cfgMaxScaleV     = document.getElementById('cfg-max-scale-val');
const cfgFill       = document.getElementById('cfg-fill');
const cfgImages     = document.getElementById('cfg-images');

const secPaint      = document.getElementById('section-paint');
const paintArea     = document.getElementById('paint-area');

const rankList      = document.getElementById('rank-list');
const paintName     = document.getElementById('paint-image-name');
const paintIndexLbl = document.getElementById('paint-index-label');
const btnUndo       = document.getElementById('btn-undo');
const btnClearMask  = document.getElementById('btn-clear-mask');
const btnPrev       = document.getElementById('btn-prev-img');
const btnNext       = document.getElementById('btn-next-img');
const canvasWrap    = document.getElementById('canvas-wrap');
const paintCanvas   = document.getElementById('paint-canvas');
const maskCanvas    = document.getElementById('mask-canvas');

const samControls   = document.getElementById('sam-controls');
const btnSamToggle      = document.getElementById('btn-sam-toggle');
const samStatus         = document.getElementById('sam-status');
const samWorkerCountEl  = document.getElementById('sam-worker-count');

const painterScaleAuto    = document.getElementById('painter-scale-auto');
const painterScaleInp     = document.getElementById('painter-scale-inp');
const painterZoomVal      = document.getElementById('painter-zoom-val');
const scalePreviewCanvas  = document.getElementById('painter-scale-preview');

const simWrap     = document.getElementById('sim-wrap');
const simCanvas   = document.getElementById('sim-canvas');
const simCtx      = simCanvas.getContext('2d');
const btnSimReset = document.getElementById('btn-sim-reset');
const btnMerge    = document.getElementById('btn-merge');
const btnCancel   = document.getElementById('btn-cancel');
const btnDownload = document.getElementById('btn-download');
const simStatusEl = document.getElementById('sim-status');
const cfgRotation = document.getElementById('cfg-rotation');

const paintCtx = paintCanvas.getContext('2d');
const maskCtx  = maskCanvas.getContext('2d');

// ── Config step ───────────────────────────────────────────────────────────────

if (isMobile) {
  document.getElementById('cfg-use-sam-row').classList.remove('im-hidden');
} else {
  // Desktop: SAM always on, no need to expose the toggle.
  cfgUseSam.checked = true;
  state.useSam = true;
  samControls.classList.remove('im-hidden');
}

cfgBlendMode.addEventListener('change', () => {
  const isDither = cfgBlendMode.value === 'dither';
  cfgDitherFields.classList.toggle('im-hidden', !isDither);
  cfgDitherExpField.classList.toggle('im-hidden', !isDither);
});

cfgWidth.addEventListener('input', () => {
  state.outW = parseInt(cfgWidth.value) || 1080;
  if (state.images.length > 0) updatePainterZoom(state.rankOrder[state.paintIdx]);
  scheduleResizeSim();
});

cfgHeight.addEventListener('input', () => {
  state.outH = parseInt(cfgHeight.value) || 1920;
  if (state.images.length > 0) updatePainterZoom(state.rankOrder[state.paintIdx]);
  scheduleResizeSim();
});

cfgFill.addEventListener('input', () => {
  state.fillColor = cfgFill.value;
  if (state.images.length > 0) updateScalePreview(state.rankOrder[state.paintIdx]);
});

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

cfgUseScaleRange.addEventListener('change', () => {
  const on = cfgUseScaleRange.checked;
  cfgMinScale.disabled = !on;
  cfgMaxScale.disabled = !on;
});

cfgUseSam.addEventListener('change', () => {
  state.useSam = cfgUseSam.checked;
  samControls.classList.toggle('im-hidden', !state.useSam);
  if (state.useSam && state.images.length > 0) {
    state.samWorkerCount = Math.max(1, parseInt(cfgSamWorkers.value) || 4);
    if (samPool.workers.length === 0) {
      initSamPool();
    } else if (samPool.readyCount > 0) {
      buildEncodeQueue();
    }
  }
  // Rebuild rank list to add or remove SAM dots.
  if (state.images.length > 0) buildRankList();
});

// ── Painter scale bar ─────────────────────────────────────────────────────────
painterScaleAuto.addEventListener('change', () => {
  const imgIdx = state.rankOrder[state.paintIdx];
  const entry  = state.images[imgIdx];
  painterScaleInp.disabled = painterScaleAuto.checked;
  entry.scale = painterScaleAuto.checked ? null : parseFloat(painterScaleInp.value);
  if (painterScaleAuto.checked)
    painterScaleInp.value = computeAutoScales()[imgIdx].scale.toFixed(2);
  updatePainterZoom(imgIdx);
  simRefreshGroup(imgIdx);
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
  simRefreshGroup(imgIdx);
});

function updatePainterZoom(imgIdx) {
  const entry        = state.images[imgIdx];
  const resolvedScale = entry.scale === null ? computeAutoScales()[imgIdx].scale : entry.scale;
  const displayW     = Math.min(DISPLAY_MAX_W, entry.w);
  const outputW      = entry.w * resolvedScale;
  painterZoomVal.textContent = Math.round((displayW / outputW) * 100) + '%';
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
  const dispOutW = Math.round(outW * fit);
  const dispOutH = Math.round(outH * fit);

  // Checkered background (transparent-PNG convention)
  const TILE = 6;
  for (let y = 0; y < CH; y += TILE) {
    for (let x = 0; x < CW; x += TILE) {
      ctx.fillStyle = ((x / TILE + y / TILE) % 2 === 0) ? '#3c3c3c' : '#2a2a2a';
      ctx.fillRect(x, y, TILE, TILE);
    }
  }

  // Output rect filled with the configured fill color
  ctx.fillStyle = state.fillColor;
  ctx.fillRect(1.5, 1.5, dispOutW, dispOutH);

  // Output rect outline
  ctx.strokeStyle = '#777';
  ctx.lineWidth   = 1;
  ctx.strokeRect(1.5, 1.5, dispOutW, dispOutH);

  // Image rect at target scale (green = manual, gray = auto estimate)
  ctx.strokeStyle = entry.scale === null ? '#888' : 'springgreen';
  ctx.strokeRect(1.5, 1.5, Math.round(imgW * fit), Math.round(imgH * fit));
}

cfgImages.addEventListener('change', () => {
  const files = Array.from(cfgImages.files);
  if (!files.length) return;
  // Clear input so re-selecting same files triggers change again.
  cfgImages.value = '';

  const firstLoad = state.images.length === 0;
  const baseIdx   = state.images.length;
  let loaded = 0;

  files.forEach((file, i) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const idx = baseIdx + i;
      const w = img.naturalWidth, h = img.naturalHeight;

      const THUMB_MAX = 256;
      const ts  = Math.min(1, THUMB_MAX / Math.max(w, h));
      const tW  = Math.max(1, Math.round(w * ts));
      const tH  = Math.max(1, Math.round(h * ts));
      const tc  = document.createElement('canvas');
      tc.width  = tW; tc.height = tH;
      tc.getContext('2d').drawImage(img, 0, 0, tW, tH);
      const thumbUrl = tc.toDataURL('image/jpeg', 0.82);
      URL.revokeObjectURL(url);

      state.images[idx] = {
        file, name: file.name, img, thumbUrl, w, h,
        polygons:    [],
        currentPoly: [],
        scale:       null,
        simHidden:   false,
      };
      loaded++;
      if (loaded === files.length) {
        // Append new indices to rankOrder and undoStack.
        for (let j = baseIdx; j < baseIdx + files.length; j++) {
          state.rankOrder.push(j);
          state.undoStack[j] = [];
        }
        paintArea.classList.remove('im-hidden');
        buildRankList();
        loadPainterImage(firstLoad ? 0 : Math.min(state.paintIdx, state.images.length - 1));
        unlockStep('step-paint');
        const n = state.images.length;
        updateStepMeta('step-images', n + ' image' + (n === 1 ? '' : 's'), true);
        // Start encoding if SAM is already checked and pool is live.
        if (state.useSam) {
          state.samWorkerCount = Math.max(1, parseInt(cfgSamWorkers.value) || 4);
          if (samPool.workers.length === 0) {
            initSamPool(); // pool not started yet — it will call buildEncodeQueue when ready
          } else if (samPool.readyCount > 0) {
            if (firstLoad) {
              buildEncodeQueue(); // full sorted queue build
            } else {
              // Append only — don't re-queue images already being encoded.
              for (let j = baseIdx; j < baseIdx + files.length; j++) {
                if (!samPool.embeddingCache.has(j)) samPool.encodeQueue.push(j);
              }
              samPool.encodeQueueBuilt = true;
              drainEncodeQueue();
            }
          }
        }
      }
    };
    img.src = url;
  });
});

// ── Rank list (drag-to-reorder) ───────────────────────────────────────────────
function buildRankList() {
  rankList.innerHTML = '';
  samPool.dots.clear();
  state.rankOrder.forEach((imgIdx, rank) => {
    const item = createRankItem(imgIdx, rank);
    rankList.appendChild(item);
  });
}

function removeImage(imgIdx) {
  // Compact state arrays, remapping all indices.
  const remap = {};
  const newImages    = [];
  const newUndoStack = [];
  state.images.forEach((entry, i) => {
    if (i === imgIdx) return;
    remap[i] = newImages.length;
    newImages.push(entry);
    newUndoStack.push(state.undoStack[i] || []);
  });

  state.images    = newImages;
  state.undoStack = newUndoStack;
  state.rankOrder = state.rankOrder
    .filter(i => i !== imgIdx)
    .map(i => remap[i]);

  // Remap SAM embedding cache.
  const newCache = new Map();
  samPool.embeddingCache.forEach((val, key) => {
    if (remap[key] !== undefined) newCache.set(remap[key], val);
  });
  samPool.embeddingCache = newCache;
  samPool.encodeQueue    = samPool.encodeQueue
    .filter(i => i !== imgIdx)
    .map(i => remap[i] ?? i);
  samPool.encodeRetries.clear();

  // Workers mid-encode will return old indices — discard those results and
  // re-queue surviving images under their new indices so they get re-encoded.
  for (let wi = 0; wi < samPool.encoding.length; wi++) {
    const oldEnc = samPool.encoding[wi];
    if (oldEnc === null) continue;
    samPool.staleEncodeSet.add(oldEnc); // onEncoded will discard this result
    if (oldEnc !== imgIdx && remap[oldEnc] !== undefined) {
      const newEnc = remap[oldEnc];
      if (!samPool.embeddingCache.has(newEnc)) samPool.encodeQueue.push(newEnc);
    }
    samPool.encoding[wi] = null;
  }

  // Remap simGroups to match the new image indices
  if (simEngine) {
    const old = simGroups[imgIdx];
    if (old && old.inWorld) Matter.World.remove(simEngine.world, old.body);
    const newSG = [];
    simGroups.forEach((g, i) => {
      if (i === imgIdx || !g) return;
      const ni = remap[i];
      if (ni !== undefined) { g.imgIdx = ni; newSG[ni] = g; }
    });
    simGroups = newSG;
  }

  if (state.images.length === 0) {
    paintArea.classList.add('im-hidden');
    lockStep('step-paint');
    lockStep('step-sim-outer');
    updateStepMeta('step-images', 'Upload to start', false);
    return;
  }

  state.paintIdx = Math.min(state.paintIdx, state.rankOrder.length - 1);
  buildRankList();
  const n = state.images.length;
  updateStepMeta('step-images', n + ' image' + (n === 1 ? '' : 's'), true);
  loadPainterImage(state.paintIdx);
}

function createRankItem(imgIdx, rank) {
  const entry = state.images[imgIdx];
  const li = document.createElement('li');
  li.className = 'im-rank-item';
  if (state.rankOrder[state.paintIdx] === imgIdx) li.classList.add('active-paint');
  li.dataset.imgIdx = imgIdx;
  li.draggable = true;

  const thumb = document.createElement('img');
  thumb.className = 'im-rank-thumb';
  thumb.src = entry.thumbUrl;
  thumb.alt = entry.name;

  const badge = document.createElement('span');
  badge.className = 'im-rank-badge';
  badge.textContent = '#' + (rank + 1);

  // SAM encoding status dot — only visible when SAM is enabled
  if (state.useSam) {
    const encoded  = samPool.embeddingCache.has(imgIdx);
    const encoding = !encoded && samPool.encoding.includes(imgIdx);
    const dot = document.createElement('span');
    dot.className = 'im-sam-dot' + (encoded ? ' im-sam-encoded' : encoding ? ' im-sam-encoding' : '');
    dot.title = encoded ? 'Encoded' : encoding ? 'Encoding\u2026' : 'Pending encoding';
    samPool.dots.set(imgIdx, dot);
    li.appendChild(dot);
  }

  const nameLbl = document.createElement('span');
  nameLbl.className = 'im-rank-name';
  nameLbl.textContent = entry.name;

  const hideBtn = document.createElement('button');
  hideBtn.className = 'im-rank-edit-btn im-film-hide';
  hideBtn.innerHTML = entry.simHidden ? EYE_CLOSED : EYE_OPEN;
  hideBtn.title = entry.simHidden ? 'Show in sim' : 'Hide in sim';
  hideBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    entry.simHidden = !entry.simHidden;
    hideBtn.innerHTML = entry.simHidden ? EYE_CLOSED : EYE_OPEN;
    hideBtn.title = entry.simHidden ? 'Show in sim' : 'Hide in sim';
    const g = simGroups[imgIdx];
    if (!g || !simEngine) return;
    if (entry.simHidden) {
      if (g.inWorld) { Matter.World.remove(simEngine.world, g.body); g.inWorld = false; }
    } else {
      if (!g.inWorld) {
        Matter.World.add(simEngine.world, g.body);
        g.inWorld = true;
        simAlpha   = Math.max(simAlpha, 0.3);
        simSettled = false;
        updateSimStatus('Settling\u2026');
      }
    }
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'im-rank-edit-btn im-btn-danger im-film-rm';
  removeBtn.innerHTML = REMOVE_ICON;
  removeBtn.title = 'Remove image';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeImage(imgIdx);
  });

  const btnGroup = document.createElement('div');
  btnGroup.className = 'im-rank-btn-group';
  btnGroup.appendChild(hideBtn);
  btnGroup.appendChild(removeBtn);

  const editBtn = document.createElement('button');
  editBtn.className = 'im-rank-edit-btn im-rank-edit-overlay';
  editBtn.textContent = 'Edit mask';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const newPaintIdx = state.rankOrder.indexOf(imgIdx);
    loadPainterImage(newPaintIdx);
    openStep('step-paint');
  });

  li.appendChild(thumb);
  li.appendChild(badge);
  li.appendChild(nameLbl);
  li.appendChild(editBtn);
  li.appendChild(btnGroup);

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
  const availW = canvasWrap.parentElement.clientWidth
               - parseFloat(getComputedStyle(canvasWrap.parentElement).paddingLeft || '0')
               - parseFloat(getComputedStyle(canvasWrap.parentElement).paddingRight || '0');
  const effectiveMaxW = Math.min(DISPLAY_MAX_W, availW > 0 ? availW : DISPLAY_MAX_W);
  const scale   = Math.min(1, effectiveMaxW / entry.w);
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
  const isAuto        = entry.scale === null;
  const resolvedScale = isAuto ? computeAutoScales()[imgIdx].scale : entry.scale;
  painterScaleAuto.checked = isAuto;
  painterScaleInp.disabled = isAuto;
  painterScaleInp.value    = resolvedScale.toFixed(2);

  // Size the preview canvas to match the output aspect ratio (max 80px per side).
  const PREVIEW_MAX = 80;
  const ar = state.outW / state.outH;
  scalePreviewCanvas.width  = ar >= 1 ? PREVIEW_MAX : Math.round(PREVIEW_MAX * ar);
  scalePreviewCanvas.height = ar >= 1 ? Math.round(PREVIEW_MAX / ar) : PREVIEW_MAX;

  updatePainterZoom(imgIdx);

  // Update active-paint on rank list items
  Array.from(rankList.children).forEach((li, i) => {
    li.classList.toggle('active-paint', i === rankIdx);
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

// Scale a desired CSS-pixel size into native canvas pixels so lines/dots are
// always visible regardless of how much the image is scaled down for display.
function canvasPx(cssPx) {
  const cssW = paintCanvas.getBoundingClientRect().width;
  if (!cssW) return cssPx;
  return Math.max(cssPx, cssPx * paintCanvas.width / cssW);
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
    const lw = canvasPx(2);
    maskCtx.beginPath();
    maskCtx.moveTo(currentPoly[0].x, currentPoly[0].y);
    for (let i = 1; i < currentPoly.length; i++) {
      maskCtx.lineTo(currentPoly[i].x, currentPoly[i].y);
    }
    if (rubberBandPt) maskCtx.lineTo(rubberBandPt.x, rubberBandPt.y);
    maskCtx.setLineDash([canvasPx(6), canvasPx(4)]);
    maskCtx.strokeStyle = 'rgba(255,220,0,0.9)';
    maskCtx.lineWidth   = lw;
    maskCtx.stroke();
    maskCtx.setLineDash([]);

    // Snap ring on first vertex once closeable
    if (currentPoly.length >= 3) {
      maskCtx.beginPath();
      maskCtx.arc(currentPoly[0].x, currentPoly[0].y, snapRadius(), 0, Math.PI * 2);
      maskCtx.strokeStyle = 'rgba(255,255,80,0.45)';
      maskCtx.lineWidth   = lw;
      maskCtx.stroke();
    }

    // Vertex dots for in-progress poly
    currentPoly.forEach((v, i) => {
      maskCtx.beginPath();
      maskCtx.arc(v.x, v.y, i === 0 ? canvasPx(7) : canvasPx(4), 0, Math.PI * 2);
      maskCtx.fillStyle = i === 0 ? '#ffee44' : '#ff3366';
      maskCtx.fill();
    });
  }
}

function drawPoly(poly, fillStyle, strokeStyle, closed) {
  if (poly.length < 2) return;
  const lw = canvasPx(2);
  maskCtx.beginPath();
  maskCtx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) maskCtx.lineTo(poly[i].x, poly[i].y);
  if (closed) maskCtx.closePath();
  maskCtx.fillStyle   = fillStyle;
  maskCtx.fill();
  maskCtx.strokeStyle = strokeStyle;
  maskCtx.lineWidth   = lw;
  maskCtx.stroke();
  poly.forEach(v => {
    maskCtx.beginPath();
    maskCtx.arc(v.x, v.y, canvasPx(4), 0, Math.PI * 2);
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
      simRefreshGroup(imgIdx);
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

canvasWrap.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const t = e.changedTouches[0];
  canvasWrap.dispatchEvent(new MouseEvent('click', {
    clientX: t.clientX, clientY: t.clientY, bubbles: true
  }));
}, { passive: false });

canvasWrap.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const t = e.changedTouches[0];
  canvasWrap.dispatchEvent(new MouseEvent('mousemove', {
    clientX: t.clientX, clientY: t.clientY, bubbles: true
  }));
}, { passive: false });

canvasWrap.addEventListener('touchend', (e) => {
  e.preventDefault();
}, { passive: false });

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
  simRefreshGroup(imgIdx);
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
  simRefreshGroup(imgIdx);
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
  encoding:  [],   // imgIdx | null — which image this worker is currently encoding
  readyCount: 0,

  // Shared coordination
  samMode:        false,
  embeddingCache: new Map(), // imgIdx → { embeddings, scale, newW, newH, origW, origH }
  dots:           new Map(), // imgIdx → dot span element (cached to avoid DOM queries)
  encodeQueue:      [],        // imgIdx[] awaiting dispatch
  encodeQueueBuilt: false,    // true once buildEncodeQueue() has been called
  encodeRetries:    new Map(), // imgIdx → failure count (reset each session)
  staleEncodeSet:   new Set(), // old imgIdx values to discard in onEncoded after a remove
  pendingDecode:  null,      // {imgIdx, x, y} | null — only one slot; last click wins
};

function updateSamStatus(text, warn) {
  samStatus.textContent = text;
  samStatus.className   = 'im-sam-status' + (warn ? ' im-log-warn' : '');
}

function updateSamWorkerCount() {
  const live  = samPool.ready.filter(Boolean).length;
  const total = SAM_WORKER_COUNT;
  samWorkerCountEl.textContent = live + '/' + total + ' workers';
  samWorkerCountEl.className   = 'im-sam-worker-count' + (live < total ? ' im-log-warn' : '');
}

function initSamPool() {
  if (samPool.workers.length > 0) return; // already initialised
  SAM_WORKER_COUNT = state.samWorkerCount;
  samPool.encodeQueueBuilt = false;
  if (location.protocol === 'file:') {
    updateSamStatus(
      'SAM requires HTTP  -  open a terminal in docs/ and run: python3 -m http.server 8080, ' +
      'then visit http://localhost:8080/assets/pages/projects/imageMerge.html',
      true
    );
    return;
  }
  for (let i = 0; i < SAM_WORKER_COUNT; i++) {
    const w = new Worker('samWorker.js?v=3');
    w.onmessage = (e) => onWorkerMsg(i, e.data);
    samPool.workers.push(w);
    samPool.ready.push(false);
    samPool.busy.push(false);
    samPool.encoding.push(null);
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
      onEncodeError(wIdx, msg.message);
      break;
  }
}

function onWorkerReady(wIdx) {
  samPool.ready[wIdx] = true;
  samPool.busy[wIdx]  = false;
  samPool.readyCount++;
  updateSamWorkerCount();

  if (samPool.readyCount === 1) {
    // Model now in browser cache — start the remaining workers.
    for (let i = 1; i < SAM_WORKER_COUNT; i++) samPool.workers[i].postMessage({ type: 'init' });
    btnSamToggle.disabled = false;
    // Only build queue now if images are already loaded; otherwise cfgImages
    // listener will call buildEncodeQueue() once images arrive.
    if (state.images.length > 0) buildEncodeQueue();
  }

  const all = samPool.readyCount === SAM_WORKER_COUNT;
  updateSamStatus(all
    ? (samPool.samMode ? 'Click a subject to segment' : 'SAM ready  -  toggle on then click a subject')
    : ('SAM loading (' + samPool.readyCount + '/' + SAM_WORKER_COUNT + ')\u2026')
  );
  drainEncodeQueue();
}

function onEncoded(wIdx, { imgIdx, embeddings, scale, newW, newH, origW, origH }) {
  samPool.busy[wIdx]     = false;
  samPool.encoding[wIdx] = null;

  // Result from before a remove — index is stale, discard it.
  if (samPool.staleEncodeSet.has(imgIdx)) {
    samPool.staleEncodeSet.delete(imgIdx);
    drainEncodeQueue();
    return;
  }

  // Store serialized embeddings in main-thread cache — permanent, no eviction.
  samPool.embeddingCache.set(imgIdx, { embeddings, scale, newW, newH, origW, origH });

  // Flip the rank-list dot to green.
  const dot = samPool.dots.get(imgIdx);
  if (dot) { dot.classList.remove('im-sam-encoding'); dot.classList.add('im-sam-encoded'); dot.title = 'Encoded'; }

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
  // Once the queue is empty and no worker is busy, release surplus workers —
  // only one alive worker is kept for decoding. Guard against premature teardown
  // before any images have been queued (e.g. pool initialised before upload).
  if (samPool.encodeQueueBuilt && samPool.encodeQueue.length === 0 && !samPool.busy.some(Boolean)) {
    let keptOne = false;
    for (let i = 0; i < SAM_WORKER_COUNT; i++) {
      if (!samPool.ready[i]) continue; // already terminated
      if (!keptOne) { keptOne = true; continue; }
      samPool.workers[i].terminate();
      samPool.ready[i]    = false;
      samPool.encoding[i] = null;
      samPool.readyCount  = Math.max(0, samPool.readyCount - 1);
    }
    updateSamWorkerCount();
  }
}

function onEncodeError(wIdx, message) {
  const imgIdx = samPool.encoding[wIdx] ?? null;
  samPool.encoding[wIdx] = null;
  samPool.busy[wIdx]     = false;

  // Terminate the failed worker — frees its WASM heap (~3 GB).
  samPool.workers[wIdx].terminate();
  samPool.ready[wIdx] = false;
  samPool.readyCount  = Math.max(0, samPool.readyCount - 1);
  updateSamWorkerCount();

  if (imgIdx !== null) {
    const dot = samPool.dots.get(imgIdx);
    if (dot) { dot.classList.remove('im-sam-encoding'); dot.title = 'Pending encoding'; }
  }

  if (imgIdx !== null && !samPool.embeddingCache.has(imgIdx)) {
    const attempts = (samPool.encodeRetries.get(imgIdx) || 0) + 1;
    samPool.encodeRetries.set(imgIdx, attempts);
    if (attempts <= 2) {
      // Re-queue at the front so it's picked up by the next free worker.
      samPool.encodeQueue.unshift(imgIdx);
      updateSamStatus('SAM worker failed  -  retrying with fewer workers\u2026', true);
    } else {
      const failDot = samPool.dots.get(imgIdx);
      if (failDot) { failDot.classList.remove('im-sam-encoding'); failDot.classList.add('im-sam-failed'); failDot.title = 'Encoding failed'; }
      updateSamStatus('Could not encode [' + (state.images[imgIdx]?.name ?? imgIdx) + ']  -  skipping.', true);
    }
  } else {
    // Failure during decode or init (imgIdx null) — just report it.
    updateSamStatus('SAM error: ' + message, true);
  }

  drainEncodeQueue();
}

function sendEncode(wIdx, imgIdx) {
  samPool.busy[wIdx]     = true;
  samPool.encoding[wIdx] = imgIdx;
  const dot = samPool.dots.get(imgIdx);
  if (dot) { dot.classList.add('im-sam-encoding'); dot.title = 'Encoding\u2026'; }
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
  const { embeddings, scale, origW, origH } = samPool.embeddingCache.get(imgIdx);
  // Structured-clone copies the ArrayBuffers — cache stays intact for future decodes.
  samPool.workers[wIdx].postMessage({
    type: 'decode', imgIdx, x, y,
    decodeSize: state.samDecodeSize,
    embeddings, scale, origW, origH,
  });
}

// Build the encode queue once, in filename order. Called when the first worker
// is ready. Navigation never clears or rebuilds this queue — encoding proceeds
// steadily through all images regardless of where the user is painting.
function buildEncodeQueue() {
  samPool.encodeQueueBuilt = true;
  samPool.encodeRetries.clear();
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
    updateSamStatus('Not encoded yet  -  wait for the dot to turn green', true);
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
    updateSamStatus('No region found  -  try clicking a different point.', true);
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
  simRefreshGroup(forImgIdx);
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
      : 'Not encoded yet  -  wait for the dot to turn green');
  } else {
    updateSamStatus('SAM ready');
  }
});

// ── Per-image auto-scale computation ──────────────────────────────────────────
// Returns an array of { scale, wasClamped } — one entry per image.
// Images with manual scale pass through unchanged.
// Auto-scale: find the shortest output dimension (ties go to width), then check
// the image's corresponding dimension. If it exceeds the output's shortest dim,
// scale = outShortDim / imageDim ceiled to the nearest 0.05 multiple.
function computeAutoScales() {
  const useW    = state.outW <= state.outH; // width is shorter (or tied)
  const shortOut = useW ? state.outW : state.outH;

  return state.images.map(entry => {
    if (entry.scale !== null) return { scale: entry.scale, wasClamped: false };
    const imgDim = useW ? entry.w : entry.h;
    if (imgDim <= shortOut) return { scale: 1, wasClamped: false };
    const ratio = imgDim / shortOut;
    const scale = 1 / (Math.ceil(ratio / 0.01) * 0.01);
    return { scale, wasClamped: false };
  });
}

// ── Merge algorithm (delegated to Web Worker) ─────────────────────────────────
let activeWorker = null;

btnCancel.addEventListener('click', cancelMerge);

btnMerge.addEventListener('click', startMerge);

function startMerge() {
  updateSimStatus('Merging\u2026');
  btnMerge.classList.add('im-hidden');
  btnCancel.classList.remove('im-hidden');
  btnDownload.classList.add('im-hidden');

  const placements   = extractPlacements();
  const workerImages = state.images.map(entry => ({
    w:        entry.w,
    h:        entry.h,
    name:     entry.name,
    polygons: entry.polygons.map(p => p.map(v => ({ x: v.x, y: v.y }))),
  }));

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
    if (msg.type === 'done') {
      cleanupWorker();
      finishMerge(msg.placements, msg.ownershipMap);
    } else if (msg.type === 'error') {
      cleanupWorker();
      updateSimStatus('Worker error: ' + msg.text);
      resetMergeUI();
    }
  };

  activeWorker.onerror = (err) => {
    cleanupWorker();
    updateSimStatus('Worker error: ' + err.message);
    resetMergeUI();
  };

  activeWorker.postMessage({
    precomputedPlacements: placements,
    images:    workerImages,
    outW:      state.outW,
    outH:      state.outH,
    blendMode: cfgBlendMode.value,
    seed:      parseInt(cfgSeed.value, 10) || 0,
    ditherExp: parseInt(cfgDitherExp.value, 10) || 4,
  });
}

function cancelMerge() {
  if (activeWorker) {
    URL.revokeObjectURL(activeWorker._blobUrl);
    activeWorker.terminate();
    activeWorker = null;
    updateSimStatus('Merge cancelled.');
  }
  resetMergeUI();
}

function resetMergeUI() {
  btnCancel.classList.add('im-hidden');
  btnDownload.classList.add('im-hidden');
  if (simSettled) btnMerge.classList.remove('im-hidden');
  simMergedImageData = null;
}

// ── Force-directed placement sim ──────────────────────────────────────────────
let simEngine          = null;
let simGroups          = [];   // indexed by imgIdx; null entry = image has no polygons
let simAlpha           = 1.0;
let simRafId           = null;
let simSettled         = false;
let _lastSimTs         = null;
let simMergedImageData = null; // set when merge complete; cleared when sim re-activates
let simLastPlacements  = null; // placements from last finishMerge — used for mask overlay
let simCornerDrag      = null; // { dir, id, startPx, startW, startH, fixedCanvas, startViewOffset }
let simDragBodyOffset  = { x: 0, y: 0 }; // visual body offset while corner drag pans viewport
let pinchPreview       = null; // { imgIdx, scale } drawn live during pinch gesture
let simDispScale       = 1;    // display px per physics px (< 1 when output > screen)
let simPhysW           = 0;    // physics world width at last initSim
let simPhysH           = 0;    // physics world height at last initSim
let mergeCanvas        = null; // offscreen full-res canvas -- used for download
let simViewScale       = 1;          // viewport zoom (1 = no zoom)
let simViewOffset      = { x: 0, y: 0 }; // viewport pan offset in physics coords
let simMouse           = null;       // Matter.js Mouse object (for updateMouseViewport)

// RDP simplification (mirrored from merge worker for main-thread use)
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
      const t  = ((pts[i].x - first.x) * dx + (pts[i].y - first.y) * dy) / lenSq;
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

// Convex hull — Andrew's monotone chain (screen/y-down coords)
function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  const s = [...pts].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  function cr(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
  const lo = [], hi = [];
  for (const p of s) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop();
    hi.push(p);
  }
  hi.pop(); lo.pop();
  return lo.concat(hi);
}

function buildSimGroup(imgIdx) {
  const { Bodies, Body } = Matter;
  const entry = state.images[imgIdx];
  const scale = computeAutoScales()[imgIdx].scale;
  const N     = state.images.length;
  const eps   = Math.max(1, 2 * scale);

  const polys = [];
  for (const poly of entry.polygons) {
    const verts = poly.map(v => ({ x: v.x * scale, y: v.y * scale }));
    const simp  = rdpSimplify(verts, eps);
    if (simp.length < 3) continue;
    const hull = convexHull(simp);
    if (hull.length < 3) continue;
    polys.push({ shape: simp, hull });
  }
  if (polys.length === 0) return null;

  const parts = [];
  for (const { hull } of polys) {
    const cx = hull.reduce((s, v) => s + v.x, 0) / hull.length;
    const cy = hull.reduce((s, v) => s + v.y, 0) / hull.length;
    try {
      const part = Bodies.fromVertices(cx, cy, hull, { frictionAir: 0.15, restitution: 0.05, friction: 0.05 });
      if (part) parts.push(part);
    } catch (_) {}
  }
  if (parts.length === 0) return null;

  const body = parts.length === 1
    ? parts[0]
    : Body.create({ parts, frictionAir: 0.15, restitution: 0.05 });
  const originalInertia = body.inertia;
  if (cfgRotation.checked) Body.setInertia(body, Infinity);

  return {
    imgIdx,
    body,
    scale,
    originalInertia,
    imgCentroidSim: { x: body.position.x, y: body.position.y },
    polysInSim:     polys.map(p => p.shape),
    color:          `hsl(${Math.round(imgIdx * 360 / Math.max(N, 1))}, 70%, 55%)`,
  };
}

function getFixedCornerRel(dir) {
  // Relative [0,1] position of the OPPOSITE (anchored) corner
  return {
    rx: (dir === 'ne' || dir === 'se') ? 0 : 1,
    ry: (dir === 'sw' || dir === 'se') ? 0 : 1,
  };
}

function canvasToPhysics(clientX, clientY) {
  const rect = simCanvas.getBoundingClientRect();
  const px = (clientX - rect.left) / rect.width  * simCanvas.width;
  const py = (clientY - rect.top)  / rect.height * simCanvas.height;
  return {
    x: px / (simDispScale * simViewScale) + simViewOffset.x,
    y: py / (simDispScale * simViewScale) + simViewOffset.y,
  };
}

function updateMouseViewport() {
  if (!simMouse) return;
  const { Mouse } = Matter;
  Mouse.setScale(simMouse,  { x: simDispScale * simViewScale, y: simDispScale * simViewScale });
  Mouse.setOffset(simMouse, { x: simViewOffset.x, y: simViewOffset.y });
}

function clientToCanvasPx(clientX, clientY) {
  const rect = simCanvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) / rect.width  * simCanvas.width,
    y: (clientY - rect.top)  / rect.height * simCanvas.height,
  };
}

function getCornerHandlePositions() {
  const ts = simDispScale * simViewScale;
  return [
    { dir: 'nw', cx: (0        - simViewOffset.x) * ts, cy: (0        - simViewOffset.y) * ts },
    { dir: 'ne', cx: (simPhysW - simViewOffset.x) * ts, cy: (0        - simViewOffset.y) * ts },
    { dir: 'sw', cx: (0        - simViewOffset.x) * ts, cy: (simPhysH - simViewOffset.y) * ts },
    { dir: 'se', cx: (simPhysW - simViewOffset.x) * ts, cy: (simPhysH - simViewOffset.y) * ts },
  ];
}

function nearestCornerHandle(canvasPx) {
  if (!simEngine) return null;
  const rect  = simCanvas.getBoundingClientRect();
  const hitR  = (simCanvas.width / rect.width) * 36; // 36 css px in canvas px
  let best = null, bestD = Infinity;
  for (const h of getCornerHandlePositions()) {
    const d = Math.hypot(canvasPx.x - h.cx, canvasPx.y - h.cy);
    if (d < hitR && d < bestD) { bestD = d; best = h; }
  }
  return best;
}

function drawCornerHandles() {
  if (!simEngine) return;
  const ctx = simCtx;
  const ts  = simDispScale * simViewScale;
  const W   = simCornerDrag ? state.outW : simPhysW;
  const H   = simCornerDrag ? state.outH : simPhysH;
  const handles = [
    { dir: 'nw', cx: (0 - simViewOffset.x) * ts, cy: (0 - simViewOffset.y) * ts },
    { dir: 'ne', cx: (W - simViewOffset.x) * ts,  cy: (0 - simViewOffset.y) * ts },
    { dir: 'sw', cx: (0 - simViewOffset.x) * ts,  cy: (H - simViewOffset.y) * ts },
    { dir: 'se', cx: (W - simViewOffset.x) * ts,  cy: (H - simViewOffset.y) * ts },
  ];

  ctx.save();

  if (simCornerDrag) {
    // Dashed preview rect showing the new output boundary
    ctx.strokeStyle = 'rgba(0,255,127,0.5)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([6, 4]);
    const rx = handles[0].cx, ry = handles[0].cy;
    ctx.strokeRect(rx, ry, W * ts, H * ts);
    ctx.setLineDash([]);
    // Size label
    ctx.fillStyle  = 'springgreen';
    ctx.font       = 'bold 13px monospace';
    ctx.textAlign  = 'center';
    const lblY = handles[2].cy + 20 < simCanvas.height - 6 ? handles[2].cy + 20 : handles[0].cy - 8;
    ctx.fillText(state.outW + ' \xd7 ' + state.outH, simCanvas.width / 2, lblY);
  }

  const ARM = 14;
  ctx.strokeStyle = 'springgreen';
  ctx.lineWidth   = 2.5;
  ctx.lineCap     = 'round';
  ctx.globalAlpha = simCornerDrag ? 1.0 : 0.7;
  for (const h of handles) {
    const sx = (h.dir === 'ne' || h.dir === 'se') ? 1 : -1;
    const sy = (h.dir === 'sw' || h.dir === 'se') ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(h.cx + sx * ARM, h.cy);
    ctx.lineTo(h.cx, h.cy);
    ctx.lineTo(h.cx, h.cy + sy * ARM);
    ctx.stroke();
  }

  ctx.restore();
}

function updateCornerResize(canvasPx) {
  if (!simCornerDrag) return;
  const ts  = simDispScale * simViewScale;
  const dX  = (canvasPx.x - simCornerDrag.startPx.x) / ts;
  const dY  = (canvasPx.y - simCornerDrag.startPx.y) / ts;
  const dir = simCornerDrag.dir;
  const sx  = (dir === 'ne' || dir === 'se') ?  1 : -1;
  const sy  = (dir === 'sw' || dir === 'se') ?  1 : -1;
  const newW = Math.min(8000, Math.max(200, Math.round(simCornerDrag.startW + sx * dX)));
  const newH = Math.min(8000, Math.max(200, Math.round(simCornerDrag.startH + sy * dY)));
  state.outW = newW;
  state.outH = newH;
  cfgWidth.value  = newW;
  cfgHeight.value = newH;
  // Keep the opposite corner pinned at its original canvas position
  const fixed = simCornerDrag.fixedCanvas;
  const rel   = getFixedCornerRel(dir);
  simViewOffset.x = rel.rx * newW - fixed.cx / ts;
  simViewOffset.y = rel.ry * newH - fixed.cy / ts;
  // Track how much the viewport panned so drawSim can visually hold bodies still
  simDragBodyOffset.x = simViewOffset.x - simCornerDrag.startViewOffset.x;
  simDragBodyOffset.y = simViewOffset.y - simCornerDrag.startViewOffset.y;
  updateMouseViewport();
}

function finishCornerResize() {
  if (simEngine) resizeSim(); // reads simCornerDrag for anchor before nulling
  simCornerDrag     = null;
  simDragBodyOffset = { x: 0, y: 0 };
}

function initSim() {
  teardownSim();
  const { Engine, Bodies, Body, World, Events, Mouse, MouseConstraint } = Matter;

  const W = state.outW, H = state.outH;

  const maxSide  = Math.max(window.screen.width, window.screen.height) * (window.devicePixelRatio || 1);
  simDispScale   = Math.min(1, maxSide / Math.max(W, H));
  const dispW    = Math.max(1, Math.round(W * simDispScale));
  const dispH    = Math.max(1, Math.round(H * simDispScale));
  simCanvas.width  = dispW;
  simCanvas.height = dispH;
  simPhysW = W; simPhysH = H;
  simMergedImageData = null;
  mergeCanvas = null;
  simViewScale  = 1;
  simViewOffset = { x: 0, y: 0 };

  const engine = Engine.create({ gravity: { x: 0, y: 0 } });
  engine.enableSleeping = false;
  simEngine = engine;

  const T = 60; // wall thickness
  World.add(engine.world, [
    Bodies.rectangle(W / 2,    -T / 2,   W + T * 2, T,          { isStatic: true, friction: 0, restitution: 0.3 }),
    Bodies.rectangle(W / 2,    H + T / 2, W + T * 2, T,          { isStatic: true, friction: 0, restitution: 0.3 }),
    Bodies.rectangle(-T / 2,    H / 2,   T,          H + T * 2,  { isStatic: true, friction: 0, restitution: 0.3 }),
    Bodies.rectangle(W + T / 2, H / 2,   T,          H + T * 2,  { isStatic: true, friction: 0, restitution: 0.3 }),
  ]);

  simGroups = [];
  for (let i = 0; i < state.images.length; i++) {
    const g = buildSimGroup(i);
    if (g) g.inWorld = false;
    simGroups.push(g);
  }

  // Initial grid placement — only bodies not simHidden enter the world
  const active = simGroups.filter(g => g && !state.images[g.imgIdx].simHidden);
  active.forEach((g, rank) => {
    Body.setPosition(g.body, simGridPos(rank, active.length, W, H));
    Body.setVelocity(g.body, { x: 0, y: 0 });
    g.inWorld = true;
    World.add(engine.world, g.body);
  });

  simAlpha   = 1.0;
  simSettled = false;
  _lastSimTs = null;

  // Drag interaction
  const mouse = Mouse.create(simCanvas);
  simMouse    = mouse;
  updateMouseViewport();
  const mc    = MouseConstraint.create(engine, {
    mouse,
    constraint: { stiffness: 0.3, render: { visible: false } },
  });
  World.add(engine.world, mc);
  Events.on(mc, 'enddrag', () => {
    simMergedImageData = null;
    simLastPlacements  = null;
    simAlpha   = Math.max(simAlpha, 0.3);
    simSettled = false;
    btnMerge.classList.add('im-hidden');
    updateSimStatus('Settling\u2026');
  });

  simWrap.classList.remove('im-hidden');
  updateSimStatus('Settling\u2026');
  simRafId = requestAnimationFrame(simTick);
}

function teardownSim() {
  if (simRafId !== null) { cancelAnimationFrame(simRafId); simRafId = null; }
  simEngine  = null;
  simMouse   = null;
  simGroups  = [];
  simSettled = false;
  _lastSimTs = null;
  btnMerge.classList.add('im-hidden');
  simWrap.classList.add('im-hidden');
}

function simGridPos(rank, n, W, H) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * W / H)));
  const cw = W / cols, ch = H / Math.ceil(n / cols);
  return { x: (rank % cols + 0.5) * cw, y: (Math.floor(rank / cols) + 0.5) * ch };
}

function simActiveBodies() {
  return simGroups.filter(g => g && g.inWorld).map(g => g.body);
}

function simTick(ts) {
  simRafId = requestAnimationFrame(simTick);
  const dt = _lastSimTs ? Math.min(ts - _lastSimTs, 50) : 16.67;
  _lastSimTs = ts;

  // Always run physics so MouseConstraint processes drag events even when
  // the merged image is being displayed.
  applySimForces();
  Matter.Engine.update(simEngine, dt);

  if (simMergedImageData && simSettled) {
    if (mergeCanvas) {
      simCtx.save();
      simCtx.scale(simDispScale * simViewScale, simDispScale * simViewScale);
      simCtx.translate(-simViewOffset.x, -simViewOffset.y);
      simCtx.drawImage(mergeCanvas, 0, 0, simPhysW, simPhysH);
      simCtx.restore();
    }
    drawMergedMaskOverlay();
    drawCornerHandles();
    return;
  }

  simAlpha = Math.max(0, simAlpha * 0.995);
  drawSim();
  drawCornerHandles();

  if (!simSettled) {
    const bodies = simActiveBodies();
    const ke     = bodies.reduce((s, b) => s + b.speed * b.speed, 0);
    const n      = bodies.length || 1;
    if (simAlpha < 0.08 && ke < 0.04 * n) {
      simSettled = true;
      btnMerge.classList.remove('im-hidden');
      updateSimStatus('Settled done  -  drag to adjust, then click Merge');
    }
  }
}

function applySimForces() {
  const bodies = simActiveBodies();
  if (bodies.length === 0) return;
  const cx = simPhysW / 2;
  const cy = simPhysH / 2;
  const kc = 0.00002 * simAlpha;
  const kr = 80      * simAlpha;

  for (const b of bodies) {
    Matter.Body.applyForce(b, b.position, {
      x: (cx - b.position.x) * kc,
      y: (cy - b.position.y) * kc,
    });
    for (const o of bodies) {
      if (o === b) continue;
      const dx = b.position.x - o.position.x;
      const dy = b.position.y - o.position.y;
      const d2 = dx * dx + dy * dy || 1;
      const d  = Math.sqrt(d2);
      Matter.Body.applyForce(b, b.position, {
        x: (dx / d) * kr / d2,
        y: (dy / d) * kr / d2,
      });
    }
  }
}

function drawSim() {
  const ctx = simCtx;
  const DW = simCanvas.width, DH = simCanvas.height;
  ctx.clearRect(0, 0, DW, DH);
  ctx.fillStyle = '#1a1b1c';
  ctx.fillRect(0, 0, DW, DH);

  ctx.save();
  ctx.scale(simDispScale * simViewScale, simDispScale * simViewScale);
  ctx.translate(-simViewOffset.x, -simViewOffset.y);

  const W = simPhysW, H = simPhysH;
  const ds = Math.max(1, Math.round(W / 400)); // draw-scale relative to 400px base

  ctx.strokeStyle = '#555';
  ctx.lineWidth   = ds;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  const fontSize = Math.max(9, Math.round(11 * ds));
  ctx.font      = `${fontSize}px sans-serif`;
  ctx.textAlign = 'center';

  for (const g of simGroups) {
    if (!g || !g.inWorld) continue;
    const bx  = g.body.position.x + simDragBodyOffset.x;
    const by  = g.body.position.y + simDragBodyOffset.y;
    const ang = g.body.angle;
    const cos = Math.cos(ang), sin = Math.sin(ang);

    // Live scale factor during pinch gesture for this body
    const pp = pinchPreview && pinchPreview.imgIdx === g.imgIdx ? pinchPreview : null;
    const scaleFactor = pp ? pp.scale / g.scale : 1;

    for (const poly of g.polysInSim) {
      ctx.beginPath();
      for (let i = 0; i < poly.length; i++) {
        const lx = (poly[i].x - g.imgCentroidSim.x) * scaleFactor;
        const ly = (poly[i].y - g.imgCentroidSim.y) * scaleFactor;
        const rx = bx + lx * cos - ly * sin;
        const ry = by + lx * sin + ly * cos;
        if (i === 0) ctx.moveTo(rx, ry); else ctx.lineTo(rx, ry);
      }
      ctx.closePath();
      ctx.globalAlpha = pp ? 0.6 : 0.4;
      ctx.fillStyle   = g.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pp ? 'springgreen' : g.color;
      ctx.lineWidth   = (pp ? 2.5 : 1.5) * ds;
      ctx.stroke();
    }

    // Faint dashed rectangle showing full image bounds (rotation-aware)
    const entry = state.images[g.imgIdx];
    const drawScale = g.scale * scaleFactor;
    const imgCorners = [
      { x: 0, y: 0 }, { x: entry.w, y: 0 },
      { x: entry.w, y: entry.h }, { x: 0, y: entry.h },
    ].map(c => {
      const lx = c.x * drawScale - g.imgCentroidSim.x * scaleFactor;
      const ly = c.y * drawScale - g.imgCentroidSim.y * scaleFactor;
      return { x: bx + lx * cos - ly * sin, y: by + lx * sin + ly * cos };
    });
    ctx.beginPath();
    ctx.moveTo(imgCorners[0].x, imgCorners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(imgCorners[i].x, imgCorners[i].y);
    ctx.closePath();
    ctx.globalAlpha = pp ? 0.45 : 0.18;
    ctx.strokeStyle = pp ? 'springgreen' : g.color;
    ctx.lineWidth   = ds;
    ctx.setLineDash([4 * ds, 4 * ds]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    ctx.globalAlpha = 0.85;
    ctx.fillStyle   = pp ? 'springgreen' : g.color;
    const label = pp
      ? entry.name.replace(/\.[^.]+$/, '') + '  ' + pp.scale.toFixed(2) + '\xd7'
      : entry.name.replace(/\.[^.]+$/, '');
    ctx.fillText(label, bx, by + fontSize / 3);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}


function drawMergedMaskOverlay() {
  if (!simLastPlacements) return;
  const ctx = simCtx;
  const W   = simPhysW;
  const ds  = Math.max(1, Math.round(W / 400));
  const N   = state.images.length;

  ctx.save();
  ctx.scale(simDispScale * simViewScale, simDispScale * simViewScale);
  ctx.translate(-simViewOffset.x, -simViewOffset.y);

  for (const p of simLastPlacements) {
    const entry = state.images[p.imgIdx];
    if (!entry.polygons || entry.polygons.length === 0) continue;
    const color = `hsl(${Math.round(p.imgIdx * 360 / Math.max(N, 1))}, 70%, 55%)`;

    for (const poly of entry.polygons) {
      const out = poly.map(v => transformPolyVert(v, p));
      ctx.beginPath();
      ctx.moveTo(out[0].x, out[0].y);
      for (let i = 1; i < out.length; i++) ctx.lineTo(out[i].x, out[i].y);
      ctx.closePath();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle   = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1.5 * ds;
      ctx.stroke();
    }
  }
  ctx.restore();
}

function updateSimStatus(text) { simStatusEl.textContent = text; }

function extractPlacements() {
  const autoScales = computeAutoScales();
  return state.rankOrder.filter(imgIdx => !state.images[imgIdx].simHidden).map(imgIdx => {
    const entry = state.images[imgIdx];
    const scale = autoScales[imgIdx].scale;
    const g     = simGroups[imgIdx];
    if (!g) {
      return {
        imgIdx,
        x: Math.round((state.outW - entry.w * scale) / 2),
        y: Math.round((state.outH - entry.h * scale) / 2),
        scale,
        angle: 0,
        pivotX: state.outW / 2,
        pivotY: state.outH / 2,
        imgCentroidX: entry.w * scale / 2,
        imgCentroidY: entry.h * scale / 2,
      };
    }
    return {
      imgIdx,
      x:            Math.round(g.body.position.x - g.imgCentroidSim.x),
      y:            Math.round(g.body.position.y - g.imgCentroidSim.y),
      scale,
      angle:        g.body.angle,
      pivotX:       g.body.position.x,
      pivotY:       g.body.position.y,
      imgCentroidX: g.imgCentroidSim.x,
      imgCentroidY: g.imgCentroidSim.y,
    };
  });
}

btnSimReset.addEventListener('click', () => { if (simEngine) initSim(); });

let _resizeSimTimer = null;
function scheduleResizeSim() {
  if (!simEngine) return;
  if (_resizeSimTimer) clearTimeout(_resizeSimTimer);
  _resizeSimTimer = setTimeout(() => {
    _resizeSimTimer = null;
    resizeSim();
  }, 400);
}

function resizeSim() {
  if (!simEngine) return;
  const oldW = simPhysW, oldH = simPhysH;
  const newW = state.outW, newH = state.outH;
  if (oldW === newW && oldH === newH) return;

  // Save viewport and body positions before teardown.
  // For corner drag: save compensated (visual) positions so bodies don't jump on release.
  // For other resizes: save proportional positions.
  const savedViewScale  = simViewScale;
  const savedViewOffset = { x: simViewOffset.x, y: simViewOffset.y };
  const isDrag = !!simCornerDrag;
  const saved = simGroups.map(g => g ? {
    x:     isDrag ? g.body.position.x + simDragBodyOffset.x : g.body.position.x * newW / oldW,
    y:     isDrag ? g.body.position.y + simDragBodyOffset.y : g.body.position.y * newH / oldH,
    angle: g.body.angle,
  } : null);

  initSim(); // rebuilds shapes, walls, canvas; resets viewport to 1/{0,0}

  simViewScale = savedViewScale;
  if (isDrag) {
    // Keep the opposite corner at the same canvas position as during drag
    const ts  = simDispScale * simViewScale; // simDispScale updated by initSim
    const rel = getFixedCornerRel(simCornerDrag.dir);
    simViewOffset.x = rel.rx * newW - simCornerDrag.fixedCanvas.cx / ts;
    simViewOffset.y = rel.ry * newH - simCornerDrag.fixedCanvas.cy / ts;
  } else {
    simViewOffset.x = savedViewOffset.x * newW / oldW;
    simViewOffset.y = savedViewOffset.y * newH / oldH;
  }
  simDragBodyOffset = { x: 0, y: 0 };
  updateMouseViewport();

  // Place bodies at saved positions (absolute for drag, proportional for other)
  const { Body } = Matter;
  for (let i = 0; i < simGroups.length; i++) {
    const g = simGroups[i];
    const s = saved[i];
    if (!g || !s) continue;
    Body.setPosition(g.body, { x: s.x, y: s.y });
    Body.setAngle(g.body, s.angle);
    Body.setVelocity(g.body, { x: 0, y: 0 });
  }
}

function simRefreshGroup(imgIdx) {
  const entry = state.images[imgIdx];
  const hasPolys = entry && entry.polygons.length > 0;

  if (!simEngine) {
    if (hasPolys) initSim(); // first polygon ever — cold start builds all groups
    return;
  }

  // Remove existing body from world
  const old = simGroups[imgIdx];
  if (old) {
    if (old.inWorld) Matter.World.remove(simEngine.world, old.body);
    simGroups[imgIdx] = null;
  }

  if (!hasPolys) return;

  simMergedImageData = null;
  const g = buildSimGroup(imgIdx);
  if (!g) return;

  if (old) {
    Matter.Body.setPosition(g.body, old.body.position);
    Matter.Body.setVelocity(g.body, { x: 0, y: 0 });
    Matter.Body.setAngle(g.body, old.body.angle);
  } else {
    const rank = state.rankOrder.indexOf(imgIdx);
    const n    = simGroups.filter(Boolean).length + 1;
    Matter.Body.setPosition(g.body, simGridPos(rank, n, state.outW, state.outH));
    Matter.Body.setVelocity(g.body, { x: 0, y: 0 });
  }

  g.inWorld = !entry.simHidden;
  if (g.inWorld) Matter.World.add(simEngine.world, g.body);
  simGroups[imgIdx] = g;

  if (g.inWorld) {
    simAlpha   = Math.max(simAlpha, 0.4);
    simSettled = false;
    btnMerge.classList.add('im-hidden');
    updateSimStatus('Settling\u2026');
  }
  simWrap.classList.remove('im-hidden');
  unlockStep('step-sim-outer');
  updateStepMeta('step-sim-outer', 'Settle then merge', false);
}

cfgRotation.addEventListener('change', () => {
  if (!simEngine) return;
  const { Body } = Matter;
  for (const g of simGroups) {
    if (!g) continue;
    if (cfgRotation.checked) {
      Body.setInertia(g.body, Infinity);
    } else {
      Body.setInertia(g.body, g.originalInertia);
    }
  }
  simMergedImageData = null;
  simAlpha   = Math.max(simAlpha, 0.2);
  simSettled = false;
  btnMerge.classList.add('im-hidden');
  updateSimStatus('Settling\u2026');
});

function transformPolyVert(v, p) {
  const angle = p.angle || 0;
  if (!angle) return { x: p.x + v.x * p.scale, y: p.y + v.y * p.scale };
  const lx = v.x * p.scale - p.imgCentroidX;
  const ly = v.y * p.scale - p.imgCentroidY;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return {
    x: p.pivotX + lx * cos - ly * sin,
    y: p.pivotY + lx * sin + ly * cos,
  };
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
  const simCtx = simCanvas.getContext('2d');

  // Pre-render each placed image into a clipped canvas and capture its pixels.
  // The temp canvas is only as large as the region that overlaps the output,
  // so large-scale images don't create huge off-screen surfaces.
  const imgData = []; // { imgIdx, x0, y0, x1, y1, rw, data }
  for (const p of placements) {
    const entry = state.images[p.imgIdx];
    const angle = p.angle || 0;

    let x0, y0, x1, y1;
    if (angle) {
      const corners = [
        { x: 0, y: 0 }, { x: entry.w, y: 0 },
        { x: entry.w, y: entry.h }, { x: 0, y: entry.h },
      ].map(c => transformPolyVert(c, p));
      const cxs = corners.map(c => c.x), cys = corners.map(c => c.y);
      x0 = Math.max(0, Math.floor(Math.min(...cxs)));
      y0 = Math.max(0, Math.floor(Math.min(...cys)));
      x1 = Math.min(W, Math.ceil(Math.max(...cxs)));
      y1 = Math.min(H, Math.ceil(Math.max(...cys)));
    } else {
      const scaledW = Math.round(entry.w * p.scale);
      const scaledH = Math.round(entry.h * p.scale);
      x0 = Math.max(0, p.x);           y0 = Math.max(0, p.y);
      x1 = Math.min(W, p.x + scaledW); y1 = Math.min(H, p.y + scaledH);
    }
    if (x1 <= x0 || y1 <= y0) { imgData.push(null); continue; }

    const rw = x1 - x0, rh = y1 - y0;
    const tmp = document.createElement('canvas');
    tmp.width = rw; tmp.height = rh;
    const tmpCtx = tmp.getContext('2d');

    if (angle) {
      tmpCtx.save();
      tmpCtx.translate(p.pivotX - x0, p.pivotY - y0);
      tmpCtx.rotate(angle);
      tmpCtx.drawImage(entry.img, 0, 0, entry.w, entry.h,
        -p.imgCentroidX, -p.imgCentroidY, entry.w * p.scale, entry.h * p.scale);
      tmpCtx.restore();
    } else {
      // Draw only the source sub-region that maps to [x0..x1] × [y0..y1]
      const srcX = (x0 - p.x) / p.scale, srcY = (y0 - p.y) / p.scale;
      const srcW = rw / p.scale,          srcH = rh / p.scale;
      tmpCtx.drawImage(entry.img, srcX, srcY, srcW, srcH, 0, 0, rw, rh);
    }
    imgData.push({ imgIdx: p.imgIdx, x0, y0, x1, y1, rw, data: tmpCtx.getImageData(0, 0, rw, rh).data });
  }

  // Index by imgIdx for O(1) owner lookup
  const imgDataByIdx = new Map();
  for (const id of imgData) { if (id) imgDataByIdx.set(id.imgIdx, id); }

  // Build output image pixel-by-pixel using ownership map
  const [fr, fg, fb] = hexToRgb(state.fillColor);
  const outImgData = simCtx.createImageData(W, H);
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

  mergeCanvas = document.createElement('canvas');
  mergeCanvas.width  = W;
  mergeCanvas.height = H;
  mergeCanvas.getContext('2d').putImageData(outImgData, 0, 0);
  simMergedImageData = outImgData;
  simLastPlacements  = placements;

  const placed = placements.length, total = state.images.length;
  updateSimStatus(
    placed === total
      ? 'Merged - drag to re-arrange'
      : 'Merged (' + placed + '/' + total + ' placed) - drag to re-arrange'
  );
  btnDownload.textContent = 'Download PNG (' + W + '\xd7' + H + ')';
  btnDownload.classList.remove('im-hidden');
  updateStepMeta('step-sim-outer', 'Merged', true);
}

// ── Download ──────────────────────────────────────────────────────────────────
btnDownload.addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = 'merged.png';
  link.href = mergeCanvas ? mergeCanvas.toDataURL('image/png') : simCanvas.toDataURL('image/png');
  link.click();
});

// ── Accordion controller ──────────────────────────────────────────────────────

function openStep(stepId) {
  document.querySelectorAll('.im-step').forEach(s => {
    s.classList.toggle('im-step-open', s.id === stepId);
  });
  const target = document.getElementById(stepId);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function unlockStep(stepId) {
  const el = document.getElementById(stepId);
  if (el) el.classList.remove('im-step-locked');
}

function lockStep(stepId) {
  const el = document.getElementById(stepId);
  if (el) el.classList.add('im-step-locked');
}

function updateStepMeta(stepId, text, isOk) {
  const el = document.getElementById(stepId);
  if (!el) return;
  const meta = el.querySelector('.im-smeta');
  if (meta) { meta.textContent = text; meta.classList.toggle('im-ok', !!isOk); }
}

document.querySelectorAll('.im-step-hd').forEach(hd => {
  hd.addEventListener('click', () => {
    const step = hd.closest('.im-step');
    if (!step || step.classList.contains('im-step-locked')) return;
    const isOpen = step.classList.contains('im-step-open');
    document.querySelectorAll('.im-step').forEach(s => s.classList.remove('im-step-open'));
    if (!isOpen) step.classList.add('im-step-open');
  });
});

const btnAdvToggle = document.getElementById('btn-adv-toggle');
const advPanel     = document.getElementById('adv-panel');
if (btnAdvToggle && advPanel) {
  btnAdvToggle.addEventListener('click', () => {
    const open = advPanel.classList.toggle('im-hidden');
    btnAdvToggle.textContent = open ? '... More' : '... Less';
  });
}

openStep('step-images');

// ── Mouse corner resize ────────────────────────────────────────────────────────
// Corner handles are drawn on the canvas at the output image corners (viewport-
// aware). Touch corners are handled inside the touch IIFE below.
(function () {
  simCanvas.addEventListener('mousemove', (e) => {
    if (!simEngine || simCornerDrag) return;
    const corner = nearestCornerHandle(clientToCanvasPx(e.clientX, e.clientY));
    simCanvas.style.cursor = corner ? (corner.dir + '-resize') : '';
  });

  simCanvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || !simEngine) return;
    const canvasPx = clientToCanvasPx(e.clientX, e.clientY);
    const corner   = nearestCornerHandle(canvasPx);
    if (!corner) return;
    e.preventDefault();
    e.stopPropagation();
    simCanvas.setPointerCapture(e.pointerId);
    simCanvas.style.cursor = corner.dir + '-resize';
    const fcRel = getFixedCornerRel(corner.dir);
    const fcTs  = simDispScale * simViewScale;
    simCornerDrag = { dir: corner.dir, id: e.pointerId, startPx: canvasPx, startW: state.outW, startH: state.outH,
      startViewOffset: { x: simViewOffset.x, y: simViewOffset.y },
      fixedCanvas: { cx: (fcRel.rx * simPhysW - simViewOffset.x) * fcTs, cy: (fcRel.ry * simPhysH - simViewOffset.y) * fcTs } };
    simDragBodyOffset = { x: 0, y: 0 };
  }, { passive: false });

  simCanvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !simCornerDrag || e.pointerId !== simCornerDrag.id) return;
    e.preventDefault();
    updateCornerResize(clientToCanvasPx(e.clientX, e.clientY));
  }, { passive: false });

  simCanvas.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse' || !simCornerDrag || e.pointerId !== simCornerDrag.id) return;
    simCanvas.style.cursor = '';
    finishCornerResize();
  });

  simCanvas.addEventListener('pointercancel', (e) => {
    if (e.pointerType !== 'mouse' || !simCornerDrag || e.pointerId !== simCornerDrag.id) return;
    simCanvas.style.cursor = '';
    finishCornerResize();
  });
}());

// ── Touch interaction on sim canvas ───────────────────────────────────────────
// Long press (1 finger, ~380ms stationary) -> lifts nearest sim group.
//   Lifted + 2nd finger -> scale/rotate that group (pinch/twist).
// Two fingers simultaneously (no long press) -> viewport zoom/pan.
(function () {
  const LP_MS     = 380; // long-press threshold ms
  const CANCEL_PX = 9;   // cancel long-press if finger drifts this far

  let mode        = 'idle'; // 'idle' | 'lp' | 'lifted' | 'group' | 'view'
  let lpTimer     = null;
  let lpTouch     = null;   // Touch at long-press start
  let lpStartX    = 0, lpStartY = 0;
  let liftedGroup = null;   // simGroup being manipulated
  let liftedId    = -1;     // identifier of primary finger

  let grpStart    = null;   // { dist, scale, angle, bodyAngle } for group pinch
  let viewStart   = null;   // { dist, scale, offset, mid } for viewport pinch

  function findTouch(list, id) {
    for (const t of list) if (t.identifier === id) return t;
    return null;
  }

  function twoTouchDist(t1, t2) {
    return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
  }

  function twoTouchMidPx(t1, t2) {
    const rect = simCanvas.getBoundingClientRect();
    return {
      x: ((t1.clientX + t2.clientX) / 2 - rect.left) / rect.width  * simCanvas.width,
      y: ((t1.clientY + t2.clientY) / 2 - rect.top)  / rect.height * simCanvas.height,
    };
  }

  function nearestGroup(phys) {
    let best = null, bestD = Infinity;
    for (const g of simGroups) {
      if (!g || !g.inWorld) continue;
      const d = Math.hypot(g.body.position.x - phys.x, g.body.position.y - phys.y);
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  function triggerLift() {
    lpTimer = null;
    if (!simEngine || !lpTouch) return;
    const g = nearestGroup(canvasToPhysics(lpTouch.clientX, lpTouch.clientY));
    if (!g) return;
    liftedGroup = g;
    mode = 'lifted';
    if (navigator.vibrate) navigator.vibrate(28);
    const autoScale = computeAutoScales()[g.imgIdx].scale;
    pinchPreview = { imgIdx: g.imgIdx, scale: state.images[g.imgIdx].scale ?? autoScale };
  }

  function initGroupPinch(t1, t2) {
    const autoScale = computeAutoScales()[liftedGroup.imgIdx].scale;
    const scale = state.images[liftedGroup.imgIdx].scale ?? autoScale;
    grpStart = {
      dist:      twoTouchDist(t1, t2),
      scale,
      angle:     Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX),
      bodyAngle: liftedGroup.body.angle,
    };
    pinchPreview = { imgIdx: liftedGroup.imgIdx, scale };
  }

  function updateGroupPinch(t1, t2) {
    const dist       = twoTouchDist(t1, t2);
    const newScale   = Math.round(Math.max(0.05, Math.min(20, grpStart.scale * dist / grpStart.dist)) * 100) / 100;
    pinchPreview     = { imgIdx: liftedGroup.imgIdx, scale: newScale };

    const curAngle   = Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX);
    let   angleDelta = curAngle - grpStart.angle;
    if (angleDelta >  Math.PI) angleDelta -= 2 * Math.PI;
    if (angleDelta < -Math.PI) angleDelta += 2 * Math.PI;
    let   newBodyAngle = grpStart.bodyAngle + angleDelta;

    // Snap to 0, 90, 180, 270 deg within +/-10
    const SNAP   = 10 * Math.PI / 180;
    const TWO_PI = 2 * Math.PI;
    const norm   = ((newBodyAngle % TWO_PI) + TWO_PI) % TWO_PI;
    for (const s of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
      const diff = norm - s;
      if (Math.abs(diff) < SNAP) { newBodyAngle -= diff; break; }
    }

    Matter.Body.setAngle(liftedGroup.body, newBodyAngle);
    updateSimStatus(newScale.toFixed(2) + '\xd7  ' + Math.round(newBodyAngle * 180 / Math.PI) + '\xb0');
  }

  function commitScale() {
    if (!liftedGroup || !pinchPreview) return;
    const entry = state.images[liftedGroup.imgIdx];
    entry.scale = pinchPreview.scale;
    const ri = state.rankOrder.indexOf(liftedGroup.imgIdx);
    if (ri === state.paintIdx) {
      painterScaleAuto.checked = false;
      painterScaleInp.disabled = false;
      painterScaleInp.value = entry.scale.toFixed(2);
      updatePainterZoom(liftedGroup.imgIdx);
    }
  }

  function releaseGroup() {
    commitScale();
    if (liftedGroup) simRefreshGroup(liftedGroup.imgIdx);
    liftedGroup  = null;
    pinchPreview = null;
    grpStart     = null;
  }

  function initViewPinch(t1, t2) {
    viewStart = {
      dist:   twoTouchDist(t1, t2),
      scale:  simViewScale,
      offset: { x: simViewOffset.x, y: simViewOffset.y },
      mid:    canvasToPhysics((t1.clientX + t2.clientX) / 2, (t1.clientY + t2.clientY) / 2),
    };
  }

  function updateViewPinch(t1, t2) {
    const dist      = twoTouchDist(t1, t2);
    const newScale  = Math.max(0.1, Math.min(10, viewStart.scale * dist / viewStart.dist));
    const midPx     = twoTouchMidPx(t1, t2);
    simViewScale    = newScale;
    simViewOffset.x = viewStart.mid.x - midPx.x / (simDispScale * newScale);
    simViewOffset.y = viewStart.mid.y - midPx.y / (simDispScale * newScale);
    updateMouseViewport();
  }

  function reset() {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    if (mode === 'resize') finishCornerResize();
    releaseGroup();
    viewStart = null;
    mode      = 'idle';
    liftedId  = -1;
    lpTouch   = null;
  }

  simCanvas.addEventListener('touchstart', (e) => {
    if (!simEngine) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const all = e.touches;

    if (all.length === 1 && mode === 'idle') {
      const t        = all[0];
      const canvasPx = clientToCanvasPx(t.clientX, t.clientY);
      const corner   = nearestCornerHandle(canvasPx);
      if (corner) {
        mode = 'resize';
        const fcRel2 = getFixedCornerRel(corner.dir);
        const fcTs2  = simDispScale * simViewScale;
        simCornerDrag = { dir: corner.dir, id: t.identifier, startPx: canvasPx, startW: state.outW, startH: state.outH,
          startViewOffset: { x: simViewOffset.x, y: simViewOffset.y },
          fixedCanvas: { cx: (fcRel2.rx * simPhysW - simViewOffset.x) * fcTs2, cy: (fcRel2.ry * simPhysH - simViewOffset.y) * fcTs2 } };
        simDragBodyOffset = { x: 0, y: 0 };
      } else {
        mode     = 'lp';
        lpTouch  = t;
        lpStartX = t.clientX;
        lpStartY = t.clientY;
        liftedId = t.identifier;
        lpTimer  = setTimeout(triggerLift, LP_MS);
      }

    } else if (all.length === 2) {
      if (mode === 'lp') {
        clearTimeout(lpTimer); lpTimer = null;
        mode = 'view';
        initViewPinch(all[0], all[1]);
      } else if (mode === 'idle') {
        mode = 'view';
        initViewPinch(all[0], all[1]);
      } else if (mode === 'lifted') {
        mode = 'group';
        const t1 = findTouch(all, liftedId) || all[0];
        const t2 = t1 === all[0] ? all[1] : all[0];
        initGroupPinch(t1, t2);
      }

    } else if (all.length > 2) {
      reset();
    }
  }, { passive: false, capture: true });

  simCanvas.addEventListener('touchmove', (e) => {
    if (!simEngine) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const all = e.touches;

    if (mode === 'resize' && simCornerDrag) {
      const t = findTouch(all, simCornerDrag.id);
      if (t) updateCornerResize(clientToCanvasPx(t.clientX, t.clientY));

    } else if (mode === 'lp') {
      const t = findTouch(all, liftedId);
      if (t && Math.hypot(t.clientX - lpStartX, t.clientY - lpStartY) > CANCEL_PX) {
        clearTimeout(lpTimer); lpTimer = null;
        mode = 'idle';
      }

    } else if (mode === 'lifted') {
      const t = findTouch(all, liftedId);
      if (t && liftedGroup) {
        const phys = canvasToPhysics(t.clientX, t.clientY);
        Matter.Body.setPosition(liftedGroup.body, { x: phys.x, y: phys.y });
        Matter.Body.setVelocity(liftedGroup.body, { x: 0, y: 0 });
        simMergedImageData = null;
        simLastPlacements  = null;
        simAlpha   = Math.max(simAlpha, 0.3);
        simSettled = false;
        btnMerge.classList.add('im-hidden');
      }

    } else if (mode === 'group' && grpStart && all.length >= 2) {
      const t1 = findTouch(all, liftedId) || all[0];
      const t2 = t1 === all[0] ? all[1] : all[0];
      updateGroupPinch(t1, t2);

    } else if (mode === 'view' && viewStart && all.length >= 2) {
      updateViewPinch(all[0], all[1]);
    }
  }, { passive: false, capture: true });

  simCanvas.addEventListener('touchend', (e) => {
    const all = e.touches;

    if (mode === 'resize') {
      if (all.length === 0) { finishCornerResize(); mode = 'idle'; }

    } else if (mode === 'lp') {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
      mode = 'idle';

    } else if (mode === 'lifted') {
      if (all.length === 0) {
        releaseGroup();
        mode = 'idle';
      }

    } else if (mode === 'group') {
      if (all.length < 2) {
        commitScale();
        grpStart = null;
        if (all.length === 1 && findTouch(all, liftedId)) {
          // one finger remains -- back to drag mode
          mode = 'lifted';
        } else {
          releaseGroup();
          mode = 'idle';
        }
      }

    } else if (mode === 'view') {
      if (all.length < 2) {
        viewStart = null;
        mode      = 'idle';
      }
    }
  }, { passive: true });

  simCanvas.addEventListener('touchcancel', () => reset(), { passive: true });
}());

// ── Touch drag-to-reorder filmstrip ───────────────────────────────────────────
// Long-press (380ms without movement) lifts the card; dragging horizontally
// reorders it live; lifting the finger commits the new order.
(function () {
  const LONG_PRESS_MS = 380;
  const MOVE_CANCEL   = 9; // px — cancel long-press if finger moves this far
  let timer = null, drag = null, savedOrder = null;
  let pressX = 0, pressY = 0;

  rankList.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const li = e.target.closest('.im-rank-item');
    if (!li) return;
    // Don't start drag when tapping the hide/remove buttons
    if (e.target.closest('.im-film-hide, .im-film-rm')) return;

    const t = e.touches[0];
    pressX = t.clientX;
    pressY = t.clientY;

    timer = setTimeout(() => {
      timer = null;
      savedOrder = [...state.rankOrder];
      drag = { li };
      li.classList.add('dragging');
      if (navigator.vibrate) navigator.vibrate(28);
    }, LONG_PRESS_MS);
  }, { passive: true });

  rankList.addEventListener('touchmove', (e) => {
    const t = e.touches[0];

    // Cancel pending long-press if finger moved too much
    if (timer) {
      if (Math.abs(t.clientX - pressX) > MOVE_CANCEL ||
          Math.abs(t.clientY - pressY) > MOVE_CANCEL) {
        clearTimeout(timer);
        timer = null;
      }
      return;
    }

    if (!drag) return;
    e.preventDefault(); // stop page scroll while reordering

    const over = document.elementFromPoint(t.clientX, t.clientY)
                          ?.closest('.im-rank-item');
    if (over && over !== drag.li) {
      const children = Array.from(rankList.children);
      const overIdx  = children.indexOf(over);
      const dragIdx  = children.indexOf(drag.li);
      if (overIdx < dragIdx) rankList.insertBefore(drag.li, over);
      else                   rankList.insertBefore(drag.li, over.nextSibling);
    }
  }, { passive: false });

  function finish(commit) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!drag) return;
    drag.li.classList.remove('dragging');

    if (commit) {
      const newOrder      = Array.from(rankList.children).map(li => parseInt(li.dataset.imgIdx));
      const curImgIdx     = state.rankOrder[state.paintIdx];
      state.rankOrder     = newOrder;
      state.paintIdx      = newOrder.indexOf(curImgIdx);
    } else {
      state.rankOrder = savedOrder;
    }
    buildRankList();
    drag = null;
    savedOrder = null;
  }

  rankList.addEventListener('touchend',   () => finish(true),  { passive: true });
  rankList.addEventListener('touchcancel',() => finish(false), { passive: true });
}());

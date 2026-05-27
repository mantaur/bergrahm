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
  useYolo: false,
  yoloDecodeSize:  512,
  yoloWorkerCount: 4,

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
const cfgUseYolo          = document.getElementById('cfg-use-yolo');
const cfgYoloWorkers      = document.getElementById('cfg-yolo-workers');
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
const cfgFill            = document.getElementById('cfg-fill');
const cfgFillTransparent = document.getElementById('cfg-fill-transparent');
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

const yoloControls   = document.getElementById('yolo-controls');
const btnYoloToggle      = document.getElementById('btn-yolo-toggle');
const yoloStatus         = document.getElementById('yolo-status');
const yoloWorkerCountEl  = document.getElementById('yolo-worker-count');

const painterScaleAuto    = document.getElementById('painter-scale-auto');
const painterScaleInp     = document.getElementById('painter-scale-inp');
const painterZoomVal      = document.getElementById('painter-zoom-val');
const scalePreviewCanvas  = document.getElementById('painter-scale-preview');

const simWrap        = document.getElementById('sim-wrap');
const simCanvas      = document.getElementById('sim-canvas');
const simCtx         = simCanvas.getContext('2d');
const btnSimReset    = document.getElementById('btn-sim-reset');
const btnMerge       = document.getElementById('btn-merge');
const panelWrap      = document.getElementById('panel-wrap');
const btnPanelToggle = document.getElementById('btn-panel-toggle');

const btnExportSession = document.getElementById('btn-export-session');
const inpImportSession = document.getElementById('inp-import-session');
const sessionStatusEl  = document.getElementById('session-status');
const sessionConfirm   = document.getElementById('session-confirm');
const btnSessReplace   = document.getElementById('btn-sess-replace');
const btnSessAdd       = document.getElementById('btn-sess-add');
const btnSessCancel    = document.getElementById('btn-sess-cancel');
const btnCancel    = document.getElementById('btn-cancel');
const btnDownload  = document.getElementById('btn-download');
const simStatusEl  = document.getElementById('sim-status');


const paintCtx = paintCanvas.getContext('2d');
const maskCtx  = maskCanvas.getContext('2d');

// ── Panel ─────────────────────────────────────────────────────────────────────

function panelSetOpen(open) {
  panelWrap.classList.toggle('im-panel-hidden', !open);
  document.body.classList.toggle('im-panel-open', open);
}

btnPanelToggle.addEventListener('click', () =>
  panelSetOpen(panelWrap.classList.contains('im-panel-hidden'))
);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!panelWrap.classList.contains('im-panel-hidden')) panelSetOpen(false);
});

panelSetOpen(false); // start closed

// ── Config step ───────────────────────────────────────────────────────────────

// Detect GPU capability and set encoding default. The toggle lives in "More" settings.
detectEncodingCapability().then(({ tier }) => {
  const enable = tier === 'fast';
  cfgUseYolo.checked = enable;
  state.useYolo = enable;
  if (enable) {
    yoloControls.classList.remove('im-hidden');
    if (state.images.length > 0 && yoloPool.workers.length === 0) initYoloPool();
  }
});

cfgBlendMode.addEventListener('change', () => {
  const isDither = cfgBlendMode.value === 'dither';
  cfgDitherFields.classList.toggle('im-hidden', !isDither);
  cfgDitherExpField.classList.toggle('im-hidden', !isDither);
  if (!window._collabApplyingRemote) _broadcastSettings();
});

cfgWidth.addEventListener('input', () => {
  state.outW = parseInt(cfgWidth.value) || 1080;
  if (state.images.length > 0) updatePainterZoom(state.rankOrder[state.paintIdx]);
  scheduleResizeSim();
  if (!window._collabApplyingRemote) _broadcastSettings();
});

cfgHeight.addEventListener('input', () => {
  state.outH = parseInt(cfgHeight.value) || 1920;
  if (state.images.length > 0) updatePainterZoom(state.rankOrder[state.paintIdx]);
  scheduleResizeSim();
  if (!window._collabApplyingRemote) _broadcastSettings();
});

cfgFill.addEventListener('input', () => {
  state.fillColor = cfgFill.value;
  cfgFillTransparent.classList.remove('im-active');
  if (state.images.length > 0) updateScalePreview(state.rankOrder[state.paintIdx]);
  if (!window._collabApplyingRemote) _broadcastSettings();
});

cfgFill.addEventListener('click', () => {
  if (state.fillColor === null) {
    state.fillColor = cfgFill.value;
    cfgFillTransparent.classList.remove('im-active');
    if (state.images.length > 0) updateScalePreview(state.rankOrder[state.paintIdx]);
    if (!window._collabApplyingRemote) _broadcastSettings();
  }
});

cfgFillTransparent.addEventListener('click', () => {
  state.fillColor = null;
  cfgFillTransparent.classList.add('im-active');
  if (state.images.length > 0) updateScalePreview(state.rankOrder[state.paintIdx]);
  if (!window._collabApplyingRemote) _broadcastSettings();
});

let _broadcastSettingsTimer = null;
function _broadcastSettings() {
  if (_broadcastSettingsTimer) clearTimeout(_broadcastSettingsTimer);
  _broadcastSettingsTimer = setTimeout(() => {
    _broadcastSettingsTimer = null;
    window.dispatchEvent(new CustomEvent('collab:settings-changed', {
      detail: { outW: state.outW, outH: state.outH, fillColor: state.fillColor, blendMode: cfgBlendMode.value,
                simX1, simY1, simX2, simY2 },
    }));
  }, 200);
}

let _settingsThrottleTs = 0;
function _broadcastSettingsNow() {
  const now = Date.now();
  if (now - _settingsThrottleTs < 50) return;
  _settingsThrottleTs = now;
  window.dispatchEvent(new CustomEvent('collab:settings-changed', {
    detail: { outW: state.outW, outH: state.outH, fillColor: state.fillColor, blendMode: cfgBlendMode.value,
              simX1, simY1, simX2, simY2 },
  }));
}

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

cfgUseYolo.addEventListener('change', () => {
  state.useYolo = cfgUseYolo.checked;
  yoloControls.classList.toggle('im-hidden', !state.useYolo);
  if (state.useYolo && state.images.length > 0) {
    state.yoloWorkerCount = Math.max(1, parseInt(cfgYoloWorkers.value) || 4);
    if (yoloPool.workers.length === 0) {
      initYoloPool();
    } else if (yoloPool.readyCount > 0) {
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

  // Output rect filled with the configured fill color (skipped when transparent)
  if (state.fillColor !== null) {
    ctx.fillStyle = state.fillColor;
    ctx.fillRect(1.5, 1.5, dispOutW, dispOutH);
  }

  // Output rect outline
  ctx.strokeStyle = '#777';
  ctx.lineWidth   = 1;
  ctx.strokeRect(1.5, 1.5, dispOutW, dispOutH);

  // Image rect at target scale (green = manual, gray = auto estimate)
  ctx.strokeStyle = entry.scale === null ? '#888' : 'springgreen';
  ctx.strokeRect(1.5, 1.5, Math.round(imgW * fit), Math.round(imgH * fit));
}

function buildThumb(img, w, h) {
  const ts = Math.min(1, 256 / Math.max(w, h));
  const tW = Math.max(1, Math.round(w * ts));
  const tH = Math.max(1, Math.round(h * ts));
  const tc = document.createElement('canvas');
  tc.width = tW; tc.height = tH;
  tc.getContext('2d').drawImage(img, 0, 0, tW, tH);
  return tc.toDataURL('image/jpeg', 0.82);
}

function imageCountLabel(n) {
  return n + ' image' + (n === 1 ? '' : 's');
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

      const thumbUrl = buildThumb(img, w, h);
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
        window.dispatchEvent(new CustomEvent('collab:images-added', {
          detail: { indices: Array.from({ length: files.length }, (_, i) => baseIdx + i) },
        }));
        loadPainterImage(firstLoad ? 0 : Math.min(state.paintIdx, state.images.length - 1));
        unlockStep('step-paint');
        panelSetOpen(true);
        const n = state.images.length;
        updateStepMeta('step-images', imageCountLabel(n), true);
        // Start encoding if SAM is already checked and pool is live.
        if (state.useYolo) {
          state.yoloWorkerCount = Math.max(1, parseInt(cfgYoloWorkers.value) || 4);
          if (yoloPool.workers.length === 0) {
            initYoloPool(); // pool not started yet — it will call buildEncodeQueue when ready
          } else if (yoloPool.readyCount > 0) {
            if (firstLoad) {
              buildEncodeQueue(); // full sorted queue build
            } else {
              // Append only — don't re-queue images already being encoded.
              for (let j = baseIdx; j < baseIdx + files.length; j++) {
                if (!yoloPool.embeddingCache.has(j)) yoloPool.encodeQueue.push(j);
              }
              yoloPool.encodeQueueBuilt = true;
              _respawnWorkersForEncoding(); // re-spawn any surplus workers killed after last batch
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
  yoloPool.dots.clear();
  state.rankOrder.forEach((imgIdx, rank) => {
    const item = createRankItem(imgIdx, rank);
    rankList.appendChild(item);
  });
  btnExportSession.disabled = state.images.length === 0;
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
  yoloPool.embeddingCache.forEach((val, key) => {
    if (remap[key] !== undefined) newCache.set(remap[key], val);
  });
  yoloPool.embeddingCache = newCache;
  yoloPool.encodeQueue    = yoloPool.encodeQueue
    .filter(i => i !== imgIdx)
    .map(i => remap[i] ?? i);
  yoloPool.encodeRetries.clear();

  // Workers mid-encode will return old indices — discard those results and
  // re-queue surviving images under their new indices so they get re-encoded.
  for (let wi = 0; wi < yoloPool.encoding.length; wi++) {
    const oldEnc = yoloPool.encoding[wi];
    if (oldEnc === null) continue;
    yoloPool.staleEncodeSet.add(oldEnc); // onEncoded will discard this result
    if (oldEnc !== imgIdx && remap[oldEnc] !== undefined) {
      const newEnc = remap[oldEnc];
      if (!yoloPool.embeddingCache.has(newEnc)) yoloPool.encodeQueue.push(newEnc);
    }
    yoloPool.encoding[wi] = null;
  }

  // Remap simGroups to match the new image indices
  if (simRafId !== null) {
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
    updateStepMeta('step-images', 'Upload to start', false);
    return;
  }

  state.paintIdx = Math.min(state.paintIdx, state.rankOrder.length - 1);
  buildRankList();
  const n = state.images.length;
  updateStepMeta('step-images', imageCountLabel(n), true);
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
  if (entry.thumbUrl) {
    thumb.src = entry.thumbUrl;
  } else {
    thumb.classList.add('im-rank-thumb-pending');
  }
  thumb.alt = entry.name;

  const badge = document.createElement('span');
  badge.className = 'im-rank-badge';
  badge.textContent = '#' + (rank + 1);

  // SAM encoding status dot — only visible when SAM is enabled
  if (state.useYolo) {
    const encoded  = yoloPool.embeddingCache.has(imgIdx);
    const encoding = !encoded && yoloPool.encoding.includes(imgIdx);
    thumb.classList.add(encoded ? 'im-yolo-encoded' : encoding ? 'im-yolo-encoding' : 'im-yolo-pending');
    thumb.title = encoded ? 'Encoded' : encoding ? 'Encoding...' : 'Pending encoding';
    yoloPool.dots.set(imgIdx, thumb);
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
    if (!g || simRafId === null) return;
    if (entry.simHidden) {
      g.inWorld = false;
    } else if (!g.inWorld) {
      g.inWorld = true;
      _simViewDirty = true;
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
  _resortEncodeQueue();
  window.dispatchEvent(new CustomEvent('collab:rank-order-changed', { detail: { order: state.rankOrder.slice() } }));
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
  if (!entry || !entry.img) return; // image not yet received during streaming collab join

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
  if (state.useYolo && yoloPool.readyCount > 0) {
    updateYoloStatus(yoloPool.embeddingCache.has(imgIdx)
      ? (yoloPool.yoloMode ? 'Click a subject to segment' : 'YOLO ready')
      : 'Encoding...');
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

  // Seg mode: use click as a segment prompt
  if (yoloPool.yoloMode) {
    if (yoloPool.readyCount === 0) return;
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
      window.dispatchEvent(new CustomEvent('collab:polygon-changed', { detail: { imgIdx, polygons: entry.polygons } }));
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
  window.dispatchEvent(new CustomEvent('collab:polygon-changed', { detail: { imgIdx, polygons: entry.polygons } }));
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
  window.dispatchEvent(new CustomEvent('collab:polygon-changed', { detail: { imgIdx, polygons: [] } }));
});

btnPrev.addEventListener('click', () => {
  if (state.paintIdx > 0) loadPainterImage(state.paintIdx - 1);
});

btnNext.addEventListener('click', () => {
  if (state.paintIdx < state.images.length - 1) loadPainterImage(state.paintIdx + 1);
});

// ── YOLO seg — worker pool ────────────────────────────────────────────────────
// Each worker runs onnxruntime-web with yolo11n-seg.onnx. Worker 0 downloads
// the model on first use; subsequent workers load from the browser cache.
// Workers are stateless: after encoding they send all detected segments back to
// the main thread. Click-to-mask lookup is instant on the main thread.
// Worker count is set from state.yoloWorkerCount at init time; use this alias.
let YOLO_WORKER_COUNT = 4;

// Per-worker arrays (indexed 0..YOLO_WORKER_COUNT-1)
const yoloPool = {
  workers:   [],   // Worker instances
  ready:     [],   // bool — model loaded
  busy:      [],   // bool — currently processing a job
  encoding:  [],   // imgIdx | null — which image this worker is currently encoding
  readyCount: 0,

  // Shared coordination
  yoloMode:        false,
  embeddingCache: new Map(), // imgIdx → { segments, origW, origH }
  dots:           new Map(), // imgIdx → dot span element (cached to avoid DOM queries)
  encodeQueue:      [],        // imgIdx[] awaiting dispatch
  encodeQueueBuilt: false,    // true once buildEncodeQueue() has been called
  encodeRetries:    new Map(), // imgIdx → failure count (reset each session)
  staleEncodeSet:   new Set(), // old imgIdx values to discard in onEncoded after a remove
  initSent:         new Set(), // worker indices init'd by _respawnWorkersForEncoding (skip cascade)
  decodeWorkerIdx:  -1,        // worker slot reserved for on-demand encoding
};

function updateYoloStatus(text, warn) {
  yoloStatus.textContent = text;
  yoloStatus.className   = 'im-yolo-status' + (warn ? ' im-log-warn' : '');
}

function updateYoloWorkerCount() {
  const live  = yoloPool.ready.filter(Boolean).length;
  const total = YOLO_WORKER_COUNT;
  yoloWorkerCountEl.textContent = live + '/' + total + ' workers';
  yoloWorkerCountEl.className   = 'im-yolo-worker-count' + (live < total ? ' im-log-warn' : '');
}

function initYoloPool() {
  if (yoloPool.workers.length > 0) return; // already initialised
  YOLO_WORKER_COUNT = state.yoloWorkerCount;
  yoloPool.encodeQueueBuilt = false;
  if (location.protocol === 'file:') {
    updateYoloStatus(
      'Seg requires HTTP  -  open a terminal in docs/ and run: python3 -m http.server 8080, ' +
      'then visit http://localhost:8080/assets/pages/projects/imageMerge.html',
      true
    );
    return;
  }
  for (let i = 0; i < YOLO_WORKER_COUNT; i++) {
    const w = new Worker('yoloWorker.js?v=6');
    w.onmessage = (e) => onWorkerMsg(i, e.data);
    yoloPool.workers.push(w);
    yoloPool.ready.push(false);
    yoloPool.busy.push(false);
    yoloPool.encoding.push(null);
  }
  updateYoloStatus('Downloading YOLO model...');
  // Only start worker 0 now; the rest start after it reports ready so they
  // benefit from the browser cache the first worker populates.
  yoloPool.workers[0].postMessage({ type: 'init' });
}

// Respawn dead worker slots up to YOLO_WORKER_COUNT for a new batch of images.
// Skips live slots. Each respawned worker sends its own init (model already cached).
function _respawnWorkersForEncoding() {
  if (location.protocol === 'file:') return;
  for (let i = 0; i < YOLO_WORKER_COUNT; i++) {
    if (yoloPool.ready[i]) continue;         // slot alive
    if (yoloPool.initSent.has(i)) continue;  // already being re-initialised
    const wi = i;
    const w = new Worker('yoloWorker.js?v=6');
    w.onmessage = (e) => onWorkerMsg(wi, e.data);
    yoloPool.workers[i]  = w;
    yoloPool.ready[i]    = false;
    yoloPool.busy[i]     = false;
    yoloPool.encoding[i] = null;
    yoloPool.initSent.add(i);
    w.postMessage({ type: 'init' });
  }
}

function onWorkerMsg(wIdx, msg) {
  switch (msg.type) {
    case 'ready':
      onWorkerReady(wIdx);
      break;
    case 'encoded':
      onEncoded(wIdx, msg);
      break;
    case 'progress':
      if (yoloPool.readyCount === 0) updateYoloStatus(msg.text);
      break;
    case 'error':
      onEncodeError(wIdx, msg.message);
      break;
  }
}

function onWorkerReady(wIdx) {
  yoloPool.ready[wIdx] = true;
  yoloPool.busy[wIdx]  = false;
  yoloPool.readyCount++;
  yoloPool.initSent.delete(wIdx);
  updateYoloWorkerCount();

  btnYoloToggle.disabled = false;

  // Only cascade-start remaining workers on the very first pool init (not re-spawns,
  // which already sent their own init messages and tracked them via initSent).
  if (yoloPool.readyCount === 1 && yoloPool.initSent.size === 0) {
    for (let i = 1; i < YOLO_WORKER_COUNT; i++) yoloPool.workers[i].postMessage({ type: 'init' });
    if (state.images.length > 0) buildEncodeQueue();
  }

  const all = yoloPool.readyCount === YOLO_WORKER_COUNT;
  updateYoloStatus(all
    ? (yoloPool.yoloMode ? 'Click a subject to segment' : 'YOLO ready  -  toggle on then click a subject')
    : ('YOLO loading (' + yoloPool.readyCount + '/' + YOLO_WORKER_COUNT + ')...')
  );
  drainEncodeQueue();
}

function onEncoded(wIdx, { imgIdx, segments, origW, origH }) {
  yoloPool.busy[wIdx]     = false;
  yoloPool.encoding[wIdx] = null;

  // Result from before a remove — index is stale, discard it.
  if (yoloPool.staleEncodeSet.has(imgIdx)) {
    yoloPool.staleEncodeSet.delete(imgIdx);
    drainEncodeQueue();
    return;
  }

  yoloPool.embeddingCache.set(imgIdx, { segments, origW, origH });
  window.dispatchEvent(new CustomEvent('collab:encoding-ready', { detail: { imgIdx } }));

  const dot = yoloPool.dots.get(imgIdx);
  if (dot) { dot.classList.remove('im-yolo-encoding', 'im-yolo-pending'); dot.classList.add('im-yolo-encoded'); dot.title = 'Encoded'; }

  if (imgIdx === state.rankOrder[state.paintIdx]) {
    updateYoloStatus(yoloPool.yoloMode ? 'Click a subject to segment' : 'YOLO ready');
  }
  drainEncodeQueue();
}

// ── Worker coordination ───────────────────────────────────────────────────────

function freeWorkerIdx() {
  const liveCount = yoloPool.ready.filter(Boolean).length;
  for (let i = 0; i < YOLO_WORKER_COUNT; i++) {
    if (!yoloPool.ready[i] || yoloPool.busy[i]) continue;
    if (liveCount > 1 && i === yoloPool.decodeWorkerIdx) continue;
    return i;
  }
  return -1;
}

// Like freeWorkerIdx but no decode-worker reservation — used for on-demand encoding.
function freeDecodeWorkerIdx() {
  for (let i = 0; i < YOLO_WORKER_COUNT; i++) {
    if (yoloPool.ready[i] && !yoloPool.busy[i]) return i;
  }
  return -1;
}

function drainEncodeQueue() {
  while (yoloPool.encodeQueue.length > 0) {
    const wIdx = freeWorkerIdx();
    if (wIdx === -1) break;
    const imgIdx = yoloPool.encodeQueue.shift();
    if (yoloPool.embeddingCache.has(imgIdx)) continue; // already cached
    sendEncode(wIdx, imgIdx);
  }
  // Once the queue is empty and no worker is busy, release surplus workers —
  // only one alive worker is kept for decoding. Guard against premature teardown
  // before any images have been queued (e.g. pool initialised before upload).
  if (yoloPool.encodeQueueBuilt && yoloPool.encodeQueue.length === 0 && !yoloPool.busy.some(Boolean)) {
    let keptOne = false;
    for (let i = 0; i < YOLO_WORKER_COUNT; i++) {
      if (!yoloPool.ready[i]) continue; // already terminated
      if (!keptOne) { keptOne = true; yoloPool.decodeWorkerIdx = i; continue; }
      yoloPool.workers[i].terminate();
      yoloPool.ready[i]    = false;
      yoloPool.encoding[i] = null;
      yoloPool.readyCount  = Math.max(0, yoloPool.readyCount - 1);
    }
    updateYoloWorkerCount();
  }
}

function onEncodeError(wIdx, message) {
  const imgIdx = yoloPool.encoding[wIdx] ?? null;
  yoloPool.encoding[wIdx] = null;
  yoloPool.busy[wIdx]     = false;

  // Terminate the failed worker — frees its WASM heap (~3 GB).
  yoloPool.workers[wIdx].terminate();
  yoloPool.ready[wIdx] = false;
  yoloPool.readyCount  = Math.max(0, yoloPool.readyCount - 1);
  updateYoloWorkerCount();

  if (imgIdx !== null) {
    const dot = yoloPool.dots.get(imgIdx);
    if (dot) { dot.classList.remove('im-yolo-encoding'); dot.classList.add('im-yolo-pending'); dot.title = 'Pending encoding'; }
  }

  if (imgIdx !== null && !yoloPool.embeddingCache.has(imgIdx)) {
    const attempts = (yoloPool.encodeRetries.get(imgIdx) || 0) + 1;
    yoloPool.encodeRetries.set(imgIdx, attempts);
    if (attempts <= 2) {
      // Re-queue at the front so it's picked up by the next free worker.
      yoloPool.encodeQueue.unshift(imgIdx);
      updateYoloStatus('YOLO worker failed  -  retrying with fewer workers...', true);
    } else {
      const failDot = yoloPool.dots.get(imgIdx);
      if (failDot) { failDot.classList.remove('im-yolo-encoding', 'im-yolo-pending'); failDot.classList.add('im-yolo-failed'); failDot.title = 'Encoding failed'; }
      updateYoloStatus('Could not encode [' + (state.images[imgIdx]?.name ?? imgIdx) + ']  -  skipping.', true);
    }
  } else {
    // Failure during decode or init (imgIdx null) — just report it.
    updateYoloStatus('YOLO error: ' + message, true);
  }

  drainEncodeQueue();
}

function sendEncode(wIdx, imgIdx) {
  yoloPool.busy[wIdx]     = true;
  yoloPool.encoding[wIdx] = imgIdx;
  const dot = yoloPool.dots.get(imgIdx);
  if (dot) { dot.classList.remove('im-yolo-pending'); dot.classList.add('im-yolo-encoding'); dot.title = 'Encoding...'; }
  const entry = state.images[imgIdx];
  const tmp   = document.createElement('canvas');
  tmp.width   = entry.w;
  tmp.height  = entry.h;
  const tmpCtx = tmp.getContext('2d');
  tmpCtx.drawImage(entry.img, 0, 0);
  const id = tmpCtx.getImageData(0, 0, entry.w, entry.h);
  yoloPool.workers[wIdx].postMessage(
    { type: 'encode', imgIdx, pixels: id.data.buffer, width: entry.w, height: entry.h },
    [id.data.buffer]
  );
}

// Build the encode queue sorted by rank order, so highest-priority images encode first.
function buildEncodeQueue() {
  yoloPool.encodeQueueBuilt = true;
  yoloPool.encodeRetries.clear();
  const sorted = [...state.images.keys()].sort((a, b) => {
    const ra = state.rankOrder.indexOf(a);
    const rb = state.rankOrder.indexOf(b);
    return (ra === -1 ? Infinity : ra) - (rb === -1 ? Infinity : rb);
  });
  for (const imgIdx of sorted) {
    if (!yoloPool.embeddingCache.has(imgIdx))
      yoloPool.encodeQueue.push(imgIdx);
  }
  drainEncodeQueue();
}

// Re-sort the pending encode queue to match the current rank order after a reorder.
function _resortEncodeQueue() {
  yoloPool.encodeQueue.sort((a, b) => {
    const ra = state.rankOrder.indexOf(a);
    const rb = state.rankOrder.indexOf(b);
    return (ra === -1 ? Infinity : ra) - (rb === -1 ? Infinity : rb);
  });
}

// Return the YOLO segment whose bbox contains (x,y) and whose mask pixel is 1,
// preferring the segment with the smallest bbox area (most specific).
// x,y are in original image coordinates.
function findBestSegmentAt(segments, x, y, origW, origH) {
  const DECODE_SIZE = 512;
  const capScale = Math.min(1, DECODE_SIZE / Math.max(origH, origW));
  const outW = Math.round(origW * capScale);
  const outH = Math.round(origH * capScale);
  const mx = Math.min(outW - 1, Math.round(x * capScale));
  const my = Math.min(outH - 1, Math.round(y * capScale));

  let best = null, bestArea = Infinity;
  for (const seg of segments) {
    const [bx1, by1, bx2, by2] = seg.bbox;
    if (x < bx1 || x > bx2 || y < by1 || y > by2) continue;
    if (seg.mask[my * seg.maskW + mx] !== 1) continue;
    const area = (bx2 - bx1) * (by2 - by1);
    if (area < bestArea) { bestArea = area; best = seg; }
  }
  return best;
}

// Ray-casting point-in-polygon test.
function pointInPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

// Handle a user click in seg mode -- instant lookup, no worker call needed.
// If the click lands inside an existing polygon, remove it instead.
function requestDecode(x, y) {
  const imgIdx = state.rankOrder[state.paintIdx];
  const entry  = state.images[imgIdx];

  // Deselect: remove the first polygon that contains the click point.
  for (let i = 0; i < entry.polygons.length; i++) {
    if (pointInPoly(entry.polygons[i], x, y)) {
      pushPolyUndo(imgIdx);
      entry.polygons.splice(i, 1);
      redrawPolyOverlay(imgIdx);
      updateUndoBtn(imgIdx);
      simRefreshGroup(imgIdx);
      window.dispatchEvent(new CustomEvent('collab:polygon-changed', { detail: { imgIdx, polygons: entry.polygons } }));
      updateYoloStatus('Segment removed. Click to add or click an object to segment.');
      return;
    }
  }

  if (!yoloPool.embeddingCache.has(imgIdx)) {
    if (!yoloPool.encoding.includes(imgIdx)) {
      const wIdx = freeDecodeWorkerIdx();
      if (wIdx !== -1) {
        sendEncode(wIdx, imgIdx);
      } else {
        yoloPool.encodeQueue.unshift(imgIdx);
        drainEncodeQueue();
      }
    }
    updateYoloStatus('Encoding - click the subject again when the thumbnail stops pulsing', true);
    return;
  }
  const { segments, origW, origH } = yoloPool.embeddingCache.get(imgIdx);
  const seg = findBestSegmentAt(segments, x, y, origW, origH);
  if (!seg) {
    updateYoloStatus('No segment found  -  try clicking on a recognized object.', true);
    return;
  }
  applyMaskAsPolygon(seg.mask, seg.maskW, seg.maskH, imgIdx);
}

function applyMaskAsPolygon(maskData, width, height, forImgIdx) {
  if (forImgIdx !== state.rankOrder[state.paintIdx]) return; // stale result
  const poly = maskToPolygon(maskData, width, height);
  if (!poly || poly.length < 3) {
    updateYoloStatus('No region found  -  try clicking a different point.', true);
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
  window.dispatchEvent(new CustomEvent('collab:polygon-changed', { detail: { imgIdx: forImgIdx, polygons: entry.polygons } }));
  updateYoloStatus('Segment added. Click for another or switch to manual mode.');
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

btnYoloToggle.addEventListener('click', () => {
  yoloPool.yoloMode = !yoloPool.yoloMode;
  btnYoloToggle.classList.toggle('im-yolo-active', yoloPool.yoloMode);
  btnYoloToggle.textContent = yoloPool.yoloMode ? 'Seg: On' : 'Seg: Off';
  if (yoloPool.yoloMode) {
    const imgIdx = state.rankOrder[state.paintIdx];
    updateYoloStatus(yoloPool.embeddingCache.has(imgIdx)
      ? 'Click a subject to segment'
      : 'Click a subject to begin encoding and segment');
  } else {
    updateYoloStatus('YOLO ready');
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
    } else if (msg.type === 'progress') {
      updateSimStatus('Merging... ' + msg.pct + '%');
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
  btnMerge.classList.remove('im-hidden');
  simMergedImageData = null;
}

// ── Force-directed placement sim ──────────────────────────────────────────────
let simGroups          = [];   // indexed by imgIdx; null entry = image has no polygons
let simRafId           = null;
let _lastSimTs         = null;
let simMergedImageData = null; // set when merge complete; cleared when sim re-activates
let _simViewDirty      = true;
let simLastPlacements  = null; // placements from last finishMerge — used for mask overlay
let simCornerDrag      = null; // { dir, id, startPx, startX1, startY1, startX2, startY2 }
let simBodyDragging    = false; // true while a body is held by MouseConstraint
let pinchPreview       = null; // { imgIdx, scale } drawn live during pinch gesture
let _activeDragIdx     = -1;   // imgIdx currently being dragged locally; -1 if none
let _lastDragBroadcast = 0;    // timestamp of last collab:body-dragging dispatch
const _remoteGrabs     = new Map(); // imgIdx -> { color } for bodies grabbed by peers
let simDispScale       = 1;    // display px per physics px (fixed; based on SIM_WORLD)
const SIM_WORLD        = 10000; // fixed physics world size, independent of output canvas
let simX1              = 0;    // output rect TL x in world space
let simY1              = 0;    // output rect TL y in world space
let simX2              = 0;    // output rect BR x in world space
let simY2              = 0;    // output rect BR y in world space
let _simOutExplicit    = false; // set when corners are set by remote; suppresses resizeSim re-center
let mergeCanvas        = null; // offscreen full-res canvas -- used for download
let mergeX1            = 0;   // simX1 at the time of the last finishMerge
let mergeY1            = 0;   // simY1 at the time of the last finishMerge
let simViewScale       = 1;          // viewport zoom (1 = no zoom)
let simViewOffset      = { x: 0, y: 0 }; // viewport pan offset in physics coords

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
  const entry = state.images[imgIdx];
  const scale = computeAutoScales()[imgIdx].scale;
  const N     = state.images.length;
  const eps   = Math.max(1, 2 * scale);

  const polys = [];
  for (const poly of entry.polygons) {
    const verts = poly.map(v => ({ x: v.x * scale, y: v.y * scale }));
    const simp  = rdpSimplify(verts, eps);
    if (simp.length < 3) continue;
    polys.push(simp);
  }
  if (polys.length === 0) return null;

  // Centroid of all polygon vertices combined
  let cx = 0, cy = 0, cnt = 0;
  for (const poly of polys) { for (const v of poly) { cx += v.x; cy += v.y; cnt++; } }
  cx /= cnt; cy /= cnt;

  return {
    imgIdx,
    x: 0, y: 0, angle: 0,
    scale,
    imgCentroidSim: { x: cx, y: cy },
    polysInSim:     polys,
    color:          `hsl(${Math.round(imgIdx * 360 / Math.max(N, 1))}, 70%, 55%)`,
    inWorld:        false,
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
    { dir: 'nw', cx: (simX1 - simViewOffset.x) * ts, cy: (simY1 - simViewOffset.y) * ts },
    { dir: 'ne', cx: (simX2 - simViewOffset.x) * ts, cy: (simY1 - simViewOffset.y) * ts },
    { dir: 'sw', cx: (simX1 - simViewOffset.x) * ts, cy: (simY2 - simViewOffset.y) * ts },
    { dir: 'se', cx: (simX2 - simViewOffset.x) * ts, cy: (simY2 - simViewOffset.y) * ts },
  ];
}

// expandPhys: expand each polygon's vertices outward from its centroid (physics units)
function _physPointInGroup(phys, g, expandPhys = 0) {
  const dx = phys.x - g.x, dy = phys.y - g.y;
  const cos = Math.cos(g.angle), sin = Math.sin(g.angle);
  const lx = dx * cos + dy * sin + g.imgCentroidSim.x;
  const ly = -dx * sin + dy * cos + g.imgCentroidSim.y;
  for (const poly of g.polysInSim) {
    let testPoly = poly;
    if (expandPhys > 0) {
      let pcx = 0, pcy = 0;
      for (const v of poly) { pcx += v.x; pcy += v.y; }
      pcx /= poly.length; pcy /= poly.length;
      testPoly = poly.map(v => {
        const ex = v.x - pcx, ey = v.y - pcy;
        const len = Math.hypot(ex, ey) || 1;
        return { x: pcx + ex * (len + expandPhys) / len,
                 y: pcy + ey * (len + expandPhys) / len };
      });
    }
    if (pointInPoly(testPoly, lx, ly)) return true;
  }
  return false;
}

// touchTolCssPx: tolerance in CSS pixels expanding the polygon hit zone (0 = exact)
function nearestGroup(phys, touchTolCssPx = 0) {
  const expandPhys = touchTolCssPx > 0
    ? touchTolCssPx / (simDispScale * simViewScale) : 0;
  let best = null, bestD = Infinity;
  for (const g of simGroups) {
    if (!g || !g.inWorld) continue;
    if (_physPointInGroup(phys, g, expandPhys)) {
      const d = Math.hypot(g.x - phys.x, g.y - phys.y);
      if (d < bestD) { bestD = d; best = g; }
    }
  }
  return best;
}

function nearestCornerHandle(canvasPx) {
  if (simRafId === null) return null;
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
  if (simRafId === null) return;
  const ctx     = simCtx;
  const ts      = simDispScale * simViewScale;
  const handles = getCornerHandlePositions();

  ctx.save();

  if (simCornerDrag) {
    // Ghost showing the original rect before drag started
    const ox1 = (simCornerDrag.startX1 - simViewOffset.x) * ts;
    const oy1 = (simCornerDrag.startY1 - simViewOffset.y) * ts;
    const ox2 = (simCornerDrag.startX2 - simViewOffset.x) * ts;
    const oy2 = (simCornerDrag.startY2 - simViewOffset.y) * ts;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(ox1, oy1, ox2 - ox1, oy2 - oy1);
    ctx.setLineDash([]);

    // Dashed preview rect showing the new output boundary
    ctx.strokeStyle = 'rgba(0,255,127,0.5)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([6, 4]);
    const nw = handles[0], se = handles[3];
    ctx.strokeRect(nw.cx, nw.cy, se.cx - nw.cx, se.cy - nw.cy);
    ctx.setLineDash([]);
    // Size label
    ctx.fillStyle  = 'springgreen';
    ctx.font       = 'bold 17px monospace';
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
  const dx  = (canvasPx.x - simCornerDrag.startPx.x) / ts;
  const dy  = (canvasPx.y - simCornerDrag.startPx.y) / ts;
  const dir = simCornerDrag.dir;

  let x1 = simCornerDrag.startX1, y1 = simCornerDrag.startY1;
  let x2 = simCornerDrag.startX2, y2 = simCornerDrag.startY2;

  if (dir === 'nw' || dir === 'sw') x1 = Math.min(x1 + dx, x2 - 200);
  if (dir === 'ne' || dir === 'se') x2 = Math.max(x2 + dx, x1 + 200);
  if (dir === 'nw' || dir === 'ne') y1 = Math.min(y1 + dy, y2 - 200);
  if (dir === 'sw' || dir === 'se') y2 = Math.max(y2 + dy, y1 + 200);

  simX1 = x1; simY1 = y1; simX2 = x2; simY2 = y2;
  state.outW = Math.round(x2 - x1);
  state.outH = Math.round(y2 - y1);
  cfgWidth.value  = state.outW;
  cfgHeight.value = state.outH;
  _simViewDirty = true;
  _broadcastSettingsNow();
}

function finishCornerResize() {
  window.dispatchEvent(new CustomEvent('collab:resize-done', {
    detail: {
      oldX1: simCornerDrag.startX1, oldY1: simCornerDrag.startY1,
      oldX2: simCornerDrag.startX2, oldY2: simCornerDrag.startY2,
    },
  }));
  if (simRafId !== null) resizeSim();
  simCornerDrag = null;
  _broadcastSettings();
  window.dispatchEvent(new CustomEvent('collab:canvas-resized'));
}

function initSim(savedPositions = null) {
  teardownSim();

  const W = state.outW, H = state.outH;

  const dpr    = Math.min(window.devicePixelRatio || 1, 2);
  const canvasW = Math.round(window.innerWidth  * dpr);
  const canvasH = Math.round(window.innerHeight * dpr);
  simCanvas.width  = canvasW;
  simCanvas.height = canvasH;
  simMergedImageData = null;
  mergeCanvas = null;

  simX1 = (SIM_WORLD - state.outW) / 2;
  simY1 = (SIM_WORLD - state.outH) / 2;
  simX2 = simX1 + state.outW;
  simY2 = simY1 + state.outH;

  simDispScale = Math.min(canvasW / SIM_WORLD, canvasH / SIM_WORLD);
  const fitTotal = Math.min(canvasW / state.outW, canvasH / state.outH) * 0.82;
  simViewScale  = fitTotal / simDispScale;
  simViewOffset = {
    x: (simX1 + simX2) / 2 - canvasW / 2 / (simDispScale * simViewScale),
    y: (simY1 + simY2) / 2 - canvasH / 2 / (simDispScale * simViewScale),
  };

  simGroups = [];
  for (let i = 0; i < state.images.length; i++) {
    simGroups.push(buildSimGroup(i));
  }

  const active = simGroups.filter(g => g && !state.images[g.imgIdx].simHidden);
  active.forEach((g, rank) => {
    const saved = savedPositions && savedPositions[g.imgIdx];
    const pos   = saved ? saved.pos : simGridPos(rank, active.length, W, H);
    g.x = pos.x; g.y = pos.y;
    g.angle   = saved ? saved.angle : 0;
    g.inWorld = true;
  });

  _lastSimTs = null;
  _simViewDirty = true;
  simRafId = requestAnimationFrame(simTick);
  if (active.length > 0) btnMerge.classList.remove('im-hidden');
}

function placeGroup(g, x, y, angle) {
  g.x = x; g.y = y; g.angle = angle;
  _simViewDirty = true;
}

function dispatchBodyLift(g) {
  window.dispatchEvent(new CustomEvent('collab:body-lift', {
    detail: { imgIdx: g.imgIdx, prevX: g.x, prevY: g.y, prevAngle: g.angle },
  }));
}

function dispatchBodyMoved(g) {
  window.dispatchEvent(new CustomEvent('collab:body-moved', {
    detail: { imgIdx: g.imgIdx, x: g.x, y: g.y, angle: g.angle },
  }));
}


function teardownSim() {
  if (simRafId !== null) { cancelAnimationFrame(simRafId); simRafId = null; }
  simGroups  = [];
  simBodyDragging = false;
  _lastSimTs = null;
  btnMerge.classList.add('im-hidden');
  btnDownload.classList.add('im-hidden');
}

function simGridPos(rank, n, W, H) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * W / H)));
  const cw = W / cols, ch = H / Math.ceil(n / cols);
  return { x: simX1 + (rank % cols + 0.5) * cw, y: simY1 + (Math.floor(rank / cols) + 0.5) * ch };
}


function simTick(ts) {
  simRafId = requestAnimationFrame(simTick);
  const dt = _lastSimTs ? Math.min(ts - _lastSimTs, 50) : 16.67;
  _lastSimTs = ts;

  if (_activeDragIdx >= 0) {
    const now = performance.now();
    if (now - _lastDragBroadcast > 33) {
      const dg = simGroups[_activeDragIdx];
      if (dg) {
        window.dispatchEvent(new CustomEvent('collab:body-dragging', {
          detail: { imgIdx: _activeDragIdx, x: dg.x, y: dg.y, angle: dg.angle },
        }));
      }
      _lastDragBroadcast = now;
    }
  }

  if (simBodyDragging || simCornerDrag || pinchPreview) _simViewDirty = true;

  if (simMergedImageData) {
    if (_simViewDirty) {
      _simViewDirty = false;
      drawSim();
      if (mergeCanvas) {
        simCtx.save();
        simCtx.scale(simDispScale * simViewScale, simDispScale * simViewScale);
        simCtx.translate(-simViewOffset.x, -simViewOffset.y);
        simCtx.drawImage(mergeCanvas, mergeX1, mergeY1, mergeCanvas.width, mergeCanvas.height);
        simCtx.restore();
      }
      drawMergedMaskOverlay();
      drawCornerHandles();
    }
    return;
  }

  if (_simViewDirty) {
    _simViewDirty = false;
    drawSim();
    drawCornerHandles();
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

  const W  = state.outW;
  const H  = state.outH;

  const totalScale = simDispScale * simViewScale;
  const px = 1 / totalScale; // 1 screen pixel in physics units
  const vx0 = simViewOffset.x;
  const vy0 = simViewOffset.y;
  const vx1 = vx0 + DW / totalScale;
  const vy1 = vy0 + DH / totalScale;
  const visW     = vx1 - vx0;
  const rawStep  = visW / 8;
  const gridStep = Math.pow(2, Math.round(Math.log2(rawStep)));
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth   = px;
  ctx.beginPath();
  const gx0 = Math.floor(vx0 / gridStep) * gridStep;
  const gy0 = Math.floor(vy0 / gridStep) * gridStep;
  for (let x = gx0; x <= vx1; x += gridStep) { ctx.moveTo(x, vy0); ctx.lineTo(x, vy1); }
  for (let y = gy0; y <= vy1; y += gridStep) { ctx.moveTo(vx0, y); ctx.lineTo(vx1, y); }
  ctx.stroke();
  ctx.font      = `${Math.round(10 / totalScale)}px sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.textBaseline = 'top';
  ctx.textAlign    = 'left';
  for (let x = gx0; x <= vx1; x += gridStep) if (x !== 0) ctx.fillText(x, x + 4 * px, vy0 + 4 * px);
  ctx.textAlign = 'right';
  for (let y = gy0; y <= vy1; y += gridStep) if (y !== 0) ctx.fillText(y, vx0 - 4 * px, y + 4 * px);

  ctx.strokeStyle = '#555';
  ctx.lineWidth   = px;
  ctx.strokeRect(simX1, simY1, W, H);

  const fontSize = Math.round(12 / totalScale);
  ctx.font      = `${fontSize}px sans-serif`;
  ctx.textAlign = 'center';

  for (const g of simGroups) {
    if (!g || !g.inWorld) continue;
    const bx  = g.x;
    const by  = g.y;
    const ang = g.angle;
    const cos = Math.cos(ang), sin = Math.sin(ang);

    // Live scale factor during pinch gesture for this body
    const pp = pinchPreview && pinchPreview.imgIdx === g.imgIdx ? pinchPreview : null;
    const scaleFactor = pp ? pp.scale / g.scale : 1;

    if (mergeCanvas) continue;

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
      ctx.lineWidth   = (pp ? 2.5 : 1.5) / totalScale;
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
    ctx.lineWidth   = 1 / totalScale;
    ctx.setLineDash([4 / totalScale, 4 / totalScale]);
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

  // Draw dashed colored border around bodies grabbed by remote peers
  for (const [imgIdx, { color }] of _remoteGrabs) {
    const g = simGroups[imgIdx];
    if (!g || !g.inWorld) continue;
    const bx  = g.x, by = g.y;
    const ang = g.angle;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const entry = state.images[imgIdx];
    const corners = [
      { x: 0, y: 0 }, { x: entry.w, y: 0 },
      { x: entry.w, y: entry.h }, { x: 0, y: entry.h },
    ].map(c => {
      const lx = c.x * g.scale - g.imgCentroidSim.x;
      const ly = c.y * g.scale - g.imgCentroidSim.y;
      return { x: bx + lx * cos - ly * sin, y: by + lx * sin + ly * cos };
    });
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5 / totalScale;
    ctx.setLineDash([6 / totalScale, 4 / totalScale]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}


function drawMergedMaskOverlay() {
  if (!simLastPlacements) return;
  const ctx = simCtx;
  const W   = state.outW;
  const ds  = Math.max(1, Math.round(W / 400));
  const N   = state.images.length;

  ctx.save();
  ctx.scale(simDispScale * simViewScale, simDispScale * simViewScale);
  ctx.translate(-simViewOffset.x + mergeX1, -simViewOffset.y + mergeY1);

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
    }
  }
  ctx.restore();
}

function updateSimStatus(text) { simStatusEl.textContent = text; }

function _clearMergedImage() {
  simMergedImageData = null;
  simLastPlacements  = null;
  mergeCanvas        = null;
  btnDownload.classList.add('im-hidden');
  btnMerge.classList.remove('im-hidden');
  _simViewDirty = true;
}

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
      x:            Math.round(g.x - g.imgCentroidSim.x - simX1),
      y:            Math.round(g.y - g.imgCentroidSim.y - simY1),
      scale,
      angle:        g.angle,
      pivotX:       g.x - simX1,
      pivotY:       g.y - simY1,
      imgCentroidX: g.imgCentroidSim.x,
      imgCentroidY: g.imgCentroidSim.y,
    };
  });
}


btnSimReset.addEventListener('click', () => {
  if (simRafId === null) return;
  window.dispatchEvent(new CustomEvent('collab:pre-reset', {
    detail: { groups: simGroups.filter(Boolean).map(g => ({ imgIdx: g.imgIdx, x: g.x, y: g.y, angle: g.angle })) },
  }));
  const W = state.outW, H = state.outH;
  const active = simGroups.filter(g => g && !state.images[g.imgIdx].simHidden);
  active.forEach((g, rank) => {
    const pos = simGridPos(rank, active.length, W, H);
    g.x = pos.x; g.y = pos.y; g.angle = 0;
  });
  _clearMergedImage();
  _simViewDirty = true;
  window.dispatchEvent(new CustomEvent('collab:canvas-resized'));
});

const cfgScaleAll    = document.getElementById('cfg-scale-all');
const cfgScaleAllVal = document.getElementById('cfg-scale-all-val');
const btnScaleAll    = document.getElementById('btn-scale-all');

cfgScaleAll.addEventListener('input', () => {
  cfgScaleAllVal.textContent = parseFloat(cfgScaleAll.value).toFixed(2) + 'x';
});

btnScaleAll.addEventListener('click', () => {
  const factor = parseFloat(cfgScaleAll.value);
  if (!factor || factor === 1) return;
  const autoScales = computeAutoScales();
  state.images.forEach((entry, i) => {
    if (entry.simHidden) return;
    const base = entry.scale !== null ? entry.scale : autoScales[i].scale;
    entry.scale = Math.max(0.05, base * factor);
    entry.scaleFixed = true;
  });
  cfgScaleAll.value = '1';
  cfgScaleAllVal.textContent = '1.00x';
  buildRankList();
  // Broadcast scale changes so peers rebuild their sim groups before receiving positions
  window.dispatchEvent(new CustomEvent('collab:scales-changed', {
    detail: { scales: state.images.map(e => e.scale) },
  }));
  if (simRafId !== null) {
    const savedPositions = {};
    simGroups.forEach((g, i) => {
      if (g) savedPositions[i] = { pos: { x: g.x, y: g.y }, angle: g.angle };
    });
    initSim(savedPositions);
    window.dispatchEvent(new CustomEvent('collab:canvas-resized'));
  }
});


let _resizeSimTimer = null;
let _resizePreBounds = null; // bounds captured at start of each typing burst
function scheduleResizeSim() {
  if (simRafId === null) return;
  if (!_resizeSimTimer) {
    // First keypress of this burst — snapshot current bounds for undo
    _resizePreBounds = { x1: simX1, y1: simY1, x2: simX2, y2: simY2 };
  } else {
    clearTimeout(_resizeSimTimer);
  }
  _resizeSimTimer = setTimeout(() => {
    _resizeSimTimer = null;
    const pre = _resizePreBounds;
    _resizePreBounds = null;
    resizeSim();
    if (pre) {
      window.dispatchEvent(new CustomEvent('collab:resize-done', {
        detail: { oldX1: pre.x1, oldY1: pre.y1, oldX2: pre.x2, oldY2: pre.y2 },
      }));
    }
    _broadcastSettings();
    window.dispatchEvent(new CustomEvent('collab:canvas-resized'));
  }, 600);
}

function resizeSim() {
  if (simRafId === null) return;
  // Corner drag and remote sync set corners directly; text-input resize expands around current center.
  if (!simCornerDrag && !_simOutExplicit) {
    const cx = (simX1 + simX2) / 2;
    const cy = (simY1 + simY2) / 2;
    simX1 = cx - state.outW / 2;
    simY1 = cy - state.outH / 2;
    simX2 = cx + state.outW / 2;
    simY2 = cy + state.outH / 2;
  }
  _simOutExplicit = false;
  _simViewDirty = true;
}

function simRefreshGroup(imgIdx) {
  const entry = state.images[imgIdx];
  const hasPolys = entry && entry.polygons.length > 0;

  if (simRafId === null) {
    if (hasPolys) initSim();
    return;
  }

  const old = simGroups[imgIdx];
  if (old) simGroups[imgIdx] = null;

  if (!hasPolys) return;

  _clearMergedImage();
  const g = buildSimGroup(imgIdx);
  if (!g) return;

  if (old) {
    g.x = old.x; g.y = old.y; g.angle = old.angle;
  } else {
    const rank = state.rankOrder.indexOf(imgIdx);
    const n    = simGroups.filter(Boolean).length + 1;
    const pos  = simGridPos(rank, n, state.outW, state.outH);
    g.x = pos.x; g.y = pos.y;
  }

  g.inWorld = !entry.simHidden;
  simGroups[imgIdx] = g;

  if (g.inWorld) {
    _simViewDirty = true;
    btnMerge.classList.remove('im-hidden');
  }
}


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
  btnMerge.classList.add('im-hidden');

  const W = state.outW, H = state.outH;

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
  const fillTransparent = state.fillColor === null;
  const [fr, fg, fb] = fillTransparent ? [0, 0, 0] : hexToRgb(state.fillColor);
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
        out[out4 + 3] = fillTransparent ? 0 : 255;
      }
    }
  }

  mergeCanvas = document.createElement('canvas');
  mergeCanvas.width  = W;
  mergeCanvas.height = H;
  mergeCanvas.getContext('2d').putImageData(outImgData, 0, 0);
  simMergedImageData = outImgData;
  simLastPlacements  = placements;
  mergeX1 = simX1;
  mergeY1 = simY1;
  _simViewDirty      = true;

  const placed = placements.length, total = state.images.length;
  updateSimStatus(
    placed === total
      ? 'Merged - drag to re-arrange'
      : 'Merged (' + placed + '/' + total + ' placed) - drag to re-arrange'
  );
  btnDownload.classList.remove('im-hidden');
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

// Re-init sim canvas on window resize so it stays fullscreen
function _onSimCanvasResize() {
  if (simRafId === null) return;
  const dpr     = Math.min(window.devicePixelRatio || 1, 2);
  const canvasW = Math.round(window.innerWidth  * dpr);
  const canvasH = Math.round(window.innerHeight * dpr);
  simCanvas.width  = canvasW;
  simCanvas.height = canvasH;
  const oldDisp = simDispScale;
  simDispScale  = Math.min(canvasW / SIM_WORLD, canvasH / SIM_WORLD);
  simViewScale  = simViewScale * oldDisp / simDispScale; // keep visual zoom constant
  _simViewDirty = true;
}

let _windowResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_windowResizeTimer);
  _windowResizeTimer = setTimeout(_onSimCanvasResize, 200);
});

// ── Mouse interaction: drag (translate), Ctrl+drag (scale+rotate), corner resize
(function () {
  simCanvas.addEventListener('mousemove', (e) => {
    if (simRafId === null || simCornerDrag || _mouseDrag || _ctrlDrag) return;
    const canvasPx = clientToCanvasPx(e.clientX, e.clientY);
    const corner = nearestCornerHandle(canvasPx);
    if (corner) { simCanvas.style.cursor = corner.dir + '-resize'; return; }
    const g = nearestGroup(canvasToPhysics(e.clientX, e.clientY));
    if (g && !_remoteGrabs.has(g.imgIdx)) {
      simCanvas.style.cursor = e.ctrlKey ? 'crosshair' : 'grab';
    } else {
      simCanvas.style.cursor = '';
    }
  });

  let _mouseDrag = null; // { pointerId, group, offsetX, offsetY }
  let _ctrlDrag  = null; // { pointerId, group, grabPhys, initScale, initAngle, initDist, initCursorAngle }

  simCanvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || simRafId === null) return;
    const canvasPx = clientToCanvasPx(e.clientX, e.clientY);
    const corner   = nearestCornerHandle(canvasPx);
    if (corner) {
      e.preventDefault();
      e.stopPropagation();
      simCanvas.setPointerCapture(e.pointerId);
      simCanvas.style.cursor = corner.dir + '-resize';
      simCornerDrag = {
        dir: corner.dir, id: e.pointerId,
        startPx: canvasPx,
        startX1: simX1, startY1: simY1, startX2: simX2, startY2: simY2,
      };
      _clearMergedImage();
      return;
    }
    const phys = canvasToPhysics(e.clientX, e.clientY);
    const g    = nearestGroup(phys);
    if (!g || _remoteGrabs.has(g.imgIdx)) return;
    e.preventDefault();
    simCanvas.setPointerCapture(e.pointerId);
    if (e.ctrlKey) {
      const autoScale = computeAutoScales()[g.imgIdx].scale;
      const cx = g.x, cy = g.y;
      const dx0 = phys.x - cx, dy0 = phys.y - cy;
      const d0 = Math.hypot(dx0, dy0);
      const minPhys = 8 / (simDispScale * simViewScale);
      _ctrlDrag = {
        pointerId: e.pointerId, group: g,
        center: { x: cx, y: cy },
        initScale: state.images[g.imgIdx].scale ?? autoScale,
        initAngle: g.angle,
        initDist: d0 > minPhys ? d0 : null,
        initCursorAngle: d0 > minPhys ? Math.atan2(dy0, dx0) : null,
      };
      simBodyDragging = true;
      simCanvas.style.cursor = 'crosshair';
    } else {
      _mouseDrag = { pointerId: e.pointerId, group: g, offsetX: g.x - phys.x, offsetY: g.y - phys.y };
      simBodyDragging = true;
      simCanvas.style.cursor = 'grabbing';
    }
    _clearMergedImage();
    dispatchBodyLift(g);
    _activeDragIdx = g.imgIdx;
    window.dispatchEvent(new CustomEvent('collab:body-grabbing', { detail: { imgIdx: g.imgIdx } }));
  }, { passive: false });

  simCanvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (simCornerDrag && e.pointerId === simCornerDrag.id) {
      updateCornerResize(clientToCanvasPx(e.clientX, e.clientY));
      return;
    }
    if (_mouseDrag && e.pointerId === _mouseDrag.pointerId) {
      const phys = canvasToPhysics(e.clientX, e.clientY);
      _mouseDrag.group.x = phys.x + _mouseDrag.offsetX;
      _mouseDrag.group.y = phys.y + _mouseDrag.offsetY;
      _simViewDirty = true;
      return;
    }
    if (_ctrlDrag && e.pointerId === _ctrlDrag.pointerId) {
      const phys = canvasToPhysics(e.clientX, e.clientY);
      const dx = phys.x - _ctrlDrag.center.x;
      const dy = phys.y - _ctrlDrag.center.y;
      const dist = Math.hypot(dx, dy);
      const curAngle = Math.atan2(dy, dx);

      if (_ctrlDrag.initDist === null) {
        const minPhys = 8 / (simDispScale * simViewScale);
        if (dist < minPhys) return;
        _ctrlDrag.initDist = dist;
        _ctrlDrag.initCursorAngle = curAngle;
      }

      let newScale = Math.max(0.05, Math.min(20, _ctrlDrag.initScale * Math.pow(dist / _ctrlDrag.initDist, 0.5)));
      let delta = curAngle - _ctrlDrag.initCursorAngle;
      if (delta >  Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      let newAngle = _ctrlDrag.initAngle + delta;

      if (e.shiftKey) {
        const scaleStep = _ctrlDrag.initScale * 0.05;
        newScale = Math.max(0.05, Math.round(newScale / scaleStep) * scaleStep);
        newAngle = Math.round(newAngle / (5 * Math.PI / 180)) * (5 * Math.PI / 180);
      }

      _ctrlDrag.group.angle = newAngle;
      pinchPreview = { imgIdx: _ctrlDrag.group.imgIdx, scale: newScale };
      updateSimStatus(newScale.toFixed(2) + '\xd7  ' + Math.round(newAngle * 180 / Math.PI) + '\xb0');
      _simViewDirty = true;
    }
  }, { passive: false });

  function _endMouseDrag() {
    if (!_mouseDrag) return;
    simBodyDragging = false;
    _activeDragIdx  = -1;
    simCanvas.style.cursor = '';
    dispatchBodyMoved(_mouseDrag.group);
    window.dispatchEvent(new CustomEvent('collab:body-releasing', { detail: { imgIdx: _mouseDrag.group.imgIdx } }));
    _mouseDrag = null;
  }

  function _endCtrlDrag() {
    if (!_ctrlDrag) return;
    const g = _ctrlDrag.group;
    if (pinchPreview && pinchPreview.imgIdx === g.imgIdx) {
      const entry = state.images[g.imgIdx];
      entry.scale = pinchPreview.scale;
      pinchPreview = null;
      const ri = state.rankOrder.indexOf(g.imgIdx);
      if (ri === state.paintIdx) {
        painterScaleAuto.checked = false;
        painterScaleInp.disabled = false;
        painterScaleInp.value = entry.scale.toFixed(2);
        updatePainterZoom(g.imgIdx);
      }
    }
    simRefreshGroup(g.imgIdx);
    simBodyDragging = false;
    _activeDragIdx  = -1;
    simCanvas.style.cursor = '';
    dispatchBodyMoved(g);
    window.dispatchEvent(new CustomEvent('collab:body-releasing', { detail: { imgIdx: g.imgIdx } }));
    updateSimStatus('');
    _ctrlDrag = null;
  }

  simCanvas.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (simCornerDrag && e.pointerId === simCornerDrag.id) { simCanvas.style.cursor = ''; finishCornerResize(); return; }
    if (_mouseDrag  && e.pointerId === _mouseDrag.pointerId)  _endMouseDrag();
    if (_ctrlDrag   && e.pointerId === _ctrlDrag.pointerId)   _endCtrlDrag();
  });

  simCanvas.addEventListener('pointercancel', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (simCornerDrag && e.pointerId === simCornerDrag.id) { simCanvas.style.cursor = ''; finishCornerResize(); return; }
    if (_mouseDrag  && e.pointerId === _mouseDrag.pointerId)  _endMouseDrag();
    if (_ctrlDrag   && e.pointerId === _ctrlDrag.pointerId)   _endCtrlDrag();
  });
}());

// ── Touch interaction on sim canvas ───────────────────────────────────────────
// Long press (1 finger, ~380ms stationary) -> lifts nearest sim group.
//   Lifted + 2nd finger -> scale/rotate that group (pinch/twist).
// Two fingers simultaneously (no long press) -> viewport zoom/pan.
(function () {
  const LP_MS     = 380; // long-press threshold ms
  const CANCEL_PX = 9;   // cancel long-press if finger drifts this far

  let mode        = 'idle'; // 'idle'|'lp'|'corner-lp'|'pan'|'lifted'|'group'|'view'|'resize'
  let lpTimer     = null;
  let lpTouch     = null;   // Touch at long-press start
  let lpStartX    = 0, lpStartY = 0;
  let lpCorner    = null;   // corner captured during 'corner-lp'
  let lpStartCPx  = null;   // canvas px at corner-lp start
  let panLastPx   = null;   // canvas px for single-finger pan delta
  let liftedGroup = null;   // simGroup being manipulated
  let liftedOffset = { x: 0, y: 0 }; // body-center minus finger in physics coords
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


  function triggerLift() {
    lpTimer = null;
    if (simRafId === null || !lpTouch) return;
    const fingerPhys = canvasToPhysics(lpTouch.clientX, lpTouch.clientY);
    const g = nearestGroup(fingerPhys, 40);
    if (!g) return;
    liftedGroup  = g;
    liftedOffset = { x: g.x - fingerPhys.x, y: g.y - fingerPhys.y };
    mode = 'lifted';
    _clearMergedImage();
    dispatchBodyLift(g);
    _activeDragIdx = g.imgIdx;
    window.dispatchEvent(new CustomEvent('collab:body-grabbing', { detail: { imgIdx: g.imgIdx } }));
    if (navigator.vibrate) navigator.vibrate(28);
    const autoScale = computeAutoScales()[g.imgIdx].scale;
    pinchPreview = { imgIdx: g.imgIdx, scale: state.images[g.imgIdx].scale ?? autoScale };
  }

  function triggerCornerResize() {
    lpTimer = null;
    if (simRafId === null || !lpCorner || !lpStartCPx) return;
    simCornerDrag = {
      dir: lpCorner.dir, id: liftedId,
      startPx: lpStartCPx,
      startX1: simX1, startY1: simY1, startX2: simX2, startY2: simY2,
    };
    _clearMergedImage();
    mode = 'resize';
    if (navigator.vibrate) navigator.vibrate(28);
  }

  function initGroupPinch(t1, t2) {
    const autoScale = computeAutoScales()[liftedGroup.imgIdx].scale;
    const scale = state.images[liftedGroup.imgIdx].scale ?? autoScale;
    grpStart = {
      dist:      twoTouchDist(t1, t2),
      scale,
      angle:     Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX),
      bodyAngle: liftedGroup.angle,
    };
    pinchPreview = { imgIdx: liftedGroup.imgIdx, scale };
    _clearMergedImage();
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

    // Snap to 0, 90, 180, 270 deg within +/-20
    const SNAP   = 20 * Math.PI / 180;
    const TWO_PI = 2 * Math.PI;
    const norm   = ((newBodyAngle % TWO_PI) + TWO_PI) % TWO_PI;
    for (const s of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
      let diff = norm - s;
      if (diff >  Math.PI) diff -= TWO_PI;
      if (diff < -Math.PI) diff += TWO_PI;
      if (Math.abs(diff) < SNAP) { newBodyAngle -= diff; break; }
    }

    liftedGroup.angle = newBodyAngle;
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
    if (liftedGroup) {
      simRefreshGroup(liftedGroup.imgIdx);
      dispatchBodyMoved(liftedGroup);
      window.dispatchEvent(new CustomEvent('collab:body-releasing', { detail: { imgIdx: liftedGroup.imgIdx } }));
    }
    _activeDragIdx = -1;
    liftedGroup  = null;
    liftedOffset = { x: 0, y: 0 };
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
    _simViewDirty   = true;
  }

  function reset() {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    if (mode === 'resize') finishCornerResize();
    releaseGroup();
    viewStart  = null;
    lpCorner   = null;
    lpStartCPx = null;
    panLastPx  = null;
    mode       = 'idle';
    liftedId   = -1;
    lpTouch    = null;
  }

  simCanvas.addEventListener('touchstart', (e) => {
    if (simRafId === null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const all = e.touches;

    if (all.length === 1 && mode === 'idle') {
      const t        = all[0];
      const canvasPx = clientToCanvasPx(t.clientX, t.clientY);
      const corner   = nearestCornerHandle(canvasPx);
      if (corner) {
        mode       = 'corner-lp';
        lpTouch    = t;
        lpStartX   = t.clientX;
        lpStartY   = t.clientY;
        liftedId   = t.identifier;
        lpCorner   = corner;
        lpStartCPx = canvasPx;
        lpTimer    = setTimeout(triggerCornerResize, LP_MS);
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
    if (simRafId === null) return;
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
        mode      = 'pan';
        panLastPx = clientToCanvasPx(t.clientX, t.clientY);
      }

    } else if (mode === 'corner-lp') {
      const t = findTouch(all, liftedId);
      if (t && Math.hypot(t.clientX - lpStartX, t.clientY - lpStartY) > CANCEL_PX) {
        clearTimeout(lpTimer); lpTimer = null;
        lpCorner  = null; lpStartCPx = null;
        mode      = 'pan';
        panLastPx = clientToCanvasPx(t.clientX, t.clientY);
      }

    } else if (mode === 'pan') {
      const t = findTouch(all, liftedId);
      if (t) {
        const px = clientToCanvasPx(t.clientX, t.clientY);
        const ts = simDispScale * simViewScale;
        simViewOffset.x -= (px.x - panLastPx.x) / ts;
        simViewOffset.y -= (px.y - panLastPx.y) / ts;
        panLastPx = px;
        _simViewDirty = true;
      }

    } else if (mode === 'lifted') {
      const t = findTouch(all, liftedId);
      if (t && liftedGroup) {
        const phys = canvasToPhysics(t.clientX, t.clientY);
        liftedGroup.x = phys.x + liftedOffset.x;
        liftedGroup.y = phys.y + liftedOffset.y;
        simMergedImageData = null;
        simLastPlacements  = null;
        btnDownload.classList.add('im-hidden');
        btnMerge.classList.remove('im-hidden');
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

    } else if (mode === 'corner-lp') {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
      lpCorner = null; lpStartCPx = null;
      mode = 'idle';

    } else if (mode === 'pan') {
      if (all.length === 0) { panLastPx = null; mode = 'idle'; }

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

// ── Mouse wheel: viewport pan + Ctrl+scroll zoom ─────────────────────────────
simCanvas.addEventListener('wheel', (e) => {
  if (simRafId === null) return;
  e.preventDefault();
  const rect        = simCanvas.getBoundingClientRect();
  const cssToCanvas = simCanvas.width / rect.width;
  const ts          = simDispScale * simViewScale;
  if (e.ctrlKey) {
    const zoomFactor = Math.exp(-e.deltaY * 0.01);
    const newScale   = Math.max(0.1, Math.min(10, simViewScale * zoomFactor));
    const cursorPx   = clientToCanvasPx(e.clientX, e.clientY);
    simViewOffset.x  = simViewOffset.x + cursorPx.x / ts - cursorPx.x / (simDispScale * newScale);
    simViewOffset.y  = simViewOffset.y + cursorPx.y / ts - cursorPx.y / (simDispScale * newScale);
    simViewScale     = newScale;
  } else {
    simViewOffset.x += e.deltaX * cssToCanvas / ts;
    simViewOffset.y += e.deltaY * cssToCanvas / ts;
  }
  _simViewDirty = true;
}, { passive: false });

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

// ── Session export / import ───────────────────────────────────────────────────

function _sessionStatus(text) {
  sessionStatusEl.textContent = text;
  sessionStatusEl.classList.toggle('im-hidden', !text);
}

// Build exported session blob and trigger download.
btnExportSession.addEventListener('click', async () => {
  if (state.images.length === 0) return;
  btnExportSession.disabled = true;
  _sessionStatus('Exporting 0%');
  try {
    await SessionIO.export({
      state,
      simGroups,
      yoloPool,
      cfg: {
        blendMode:    cfgBlendMode.value,
        seed:         parseInt(cfgSeed.value) || 42,
        ditherExp:    parseInt(cfgDitherExp.value) || 4,
        useScaleRange: cfgUseScaleRange.checked,
        simViewScale,
        simViewOffset,
        simX1, simY1, simX2, simY2,
      },
    }, (pct, text) => _sessionStatus(text));
    _sessionStatus('Exported');
    setTimeout(() => _sessionStatus(''), 3000);
  } catch (e) {
    _sessionStatus('Export failed: ' + e.message);
  } finally {
    btnExportSession.disabled = state.images.length === 0;
  }
});

// File selected — show confirm if session active, else replace immediately.
let _pendingImportFile = null;

inpImportSession.addEventListener('change', () => {
  const file = inpImportSession.files[0];
  inpImportSession.value = '';
  if (!file) return;
  _pendingImportFile = file;
  sessionConfirm.classList.add('im-hidden');
  if (state.images.length > 0) {
    sessionConfirm.classList.remove('im-hidden');
  } else {
    _doImportReplace(file);
    _pendingImportFile = null;
  }
});

btnSessReplace.addEventListener('click', () => {
  sessionConfirm.classList.add('im-hidden');
  if (_pendingImportFile) _doImportReplace(_pendingImportFile);
  _pendingImportFile = null;
});

btnSessAdd.addEventListener('click', () => {
  sessionConfirm.classList.add('im-hidden');
  if (_pendingImportFile) _doImportAdd(_pendingImportFile);
  _pendingImportFile = null;
});

btnSessCancel.addEventListener('click', () => {
  sessionConfirm.classList.add('im-hidden');
  _pendingImportFile = null;
});

async function _doImportReplace(file) {
  _sessionStatus('Importing 0%');
  try {
    const { session, imgs, encodings } = await SessionIO.import(file, (pct, text) => _sessionStatus(text));
    _applyImportReplace(session, imgs, encodings);
    _sessionStatus('');
  } catch (e) {
    _sessionStatus('Import failed: ' + e.message);
  }
}

async function _doImportAdd(file) {
  _sessionStatus('Importing 0%');
  try {
    const { session, imgs, encodings } = await SessionIO.import(file, (pct, text) => _sessionStatus(text));
    _applyImportAdd(session, imgs, encodings);
    _sessionStatus('');
  } catch (e) {
    _sessionStatus('Import failed: ' + e.message);
  }
}

function _applyImportReplace(session, imgs, encodings) {
  teardownSim();

  // Wipe existing state
  state.images    = [];
  state.rankOrder = [];
  state.undoStack = [];
  yoloPool.embeddingCache.clear();
  yoloPool.dots.clear();
  rankList.innerHTML = '';

  // Restore config to DOM + state
  state.outW = session.outW;         cfgWidth.value  = session.outW;
  state.outH = session.outH;         cfgHeight.value = session.outH;
  state.fillColor = session.fillColor !== undefined ? session.fillColor : '#181a1b';
  if (state.fillColor === null) {
    cfgFillTransparent.classList.add('im-active');
  } else {
    cfgFill.value = state.fillColor;
    cfgFillTransparent.classList.remove('im-active');
  }
  cfgBlendMode.value = session.blendMode || 'voronoi';
  cfgBlendMode.dispatchEvent(new Event('change'));
  cfgSeed.value      = session.seed    || 42;
  cfgDitherExp.value = session.ditherExp || 4;
  cfgUseScaleRange.checked = session.useScaleRange !== false;
  state.minScale = session.minScale || 0.5; cfgMinScale.value = state.minScale; cfgMinScaleV.textContent = state.minScale + 'x';
  state.maxScale = session.maxScale || 2.0; cfgMaxScale.value = state.maxScale; cfgMaxScaleV.textContent = state.maxScale + 'x';

  // Load images
  _loadSessionImages(session.images, imgs, 0);

  // Restore encodings
  _restoreEncodings(encodings, 0);

  state.rankOrder = (session.rankOrder || []).filter(i => state.images[i]);
  state.paintIdx  = Math.min(session.paintIdx || 0, Math.max(0, state.rankOrder.length - 1));

  paintArea.classList.remove('im-hidden');
  buildRankList();
  if (state.images.length > 0) loadPainterImage(state.paintIdx);
  unlockStep('step-paint');
  panelSetOpen(true);
  updateStepMeta('step-images', imageCountLabel(state.images.length), true);

  // Build saved positions and init sim
  const savedPositions = {};
  (session.images || []).forEach((si, i) => {
    if (si.simPos) savedPositions[i] = { pos: si.simPos, angle: si.simAngle || 0 };
  });
  initSim(savedPositions);

  // Restore viewport and output position after initSim resets them
  if (session.simViewScale) {
    simViewScale  = session.simViewScale;
    simViewOffset = { x: session.simViewOffset.x, y: session.simViewOffset.y };
  }
  if (session.simX1 != null) {
    simX1 = session.simX1; simY1 = session.simY1;
    simX2 = session.simX2; simY2 = session.simY2;
  } else if (session.simOutX != null) {
    simX1 = session.simOutX; simY1 = session.simOutY;
    simX2 = simX1 + state.outW; simY2 = simY1 + state.outH;
  }


  // Queue YOLO encoding for images without cached encodings
  if (state.useYolo && yoloPool.workers.length > 0 && yoloPool.readyCount > 0) {
    buildEncodeQueue();
  }
}

function _applyImportAdd(session, imgs, encodings) {
  const baseIdx = state.images.length;
  let addCount  = 0;

  // Map imported index -> new index (-1 if image failed to load)
  const remapIdx = (session.images || []).map((_si, i) => imgs[i] ? baseIdx + addCount++ : -1);

  _loadSessionImages(session.images, imgs, baseIdx, remapIdx);
  _restoreEncodings(encodings, baseIdx, remapIdx);

  // Append to rankOrder (in the order they appear in the imported session's rankOrder)
  const sessionRankOrder = (session.rankOrder || session.images.map((_, i) => i));
  for (const si of sessionRankOrder) {
    const ni = remapIdx[si];
    if (ni >= 0) state.rankOrder.push(ni);
  }

  buildRankList();
  updateStepMeta('step-images', imageCountLabel(state.images.length), true);

  // Add groups to running sim at their saved positions
  for (let i = 0; i < (session.images || []).length; i++) {
    const ni = remapIdx[i];
    if (ni < 0) continue;
    const si = session.images[i];
    if (simRafId !== null) {
      simRefreshGroup(ni);
      if (si.simPos && simGroups[ni]) {
        placeGroup(simGroups[ni], si.simPos.x, si.simPos.y, si.simAngle || 0);
      }
    }
  }

  if (state.useYolo && yoloPool.workers.length > 0 && yoloPool.readyCount > 0) {
    buildEncodeQueue();
  }
}

function _loadSessionImages(sessionImages, imgs, baseIdx, remapIdx) {
  (sessionImages || []).forEach((si, i) => {
    const img = imgs[i];
    const newIdx = remapIdx ? remapIdx[i] : baseIdx + i;
    if (!img || newIdx < 0) return;

    const w = si.w || img.naturalWidth;
    const h = si.h || img.naturalHeight;
    const thumbUrl = buildThumb(img, w, h);

    state.images[newIdx] = {
      file: null, name: si.name, img, thumbUrl, w, h,
      polygons:    si.polygons   || [],
      currentPoly: si.currentPoly || [],
      scale:       si.scale,
      scaleFixed:  si.scaleFixed  || false,
      simHidden:   si.simHidden   || false,
    };
    state.undoStack[newIdx] = [];
  });
}

// ── Collaboration remote-event handlers ───────────────────────────────────────

let _collabJoinTotal     = 0;
let _collabJoinFullsDone = 0;


window.addEventListener('collab:remote-session', async (e) => {
  await _doImportReplace(e.detail.blob);
});

window.addEventListener('collab:remote-image', async (e) => {
  const { name, w, h, jpegBase64, encoding, polygons, simPos, simAngle } = e.detail;
  const img = new Image();
  await new Promise(res => {
    img.onload = res;
    img.src = jpegBase64;
  });
  const thumbUrl = buildThumb(img, w, h);

  const idx = state.images.length;
  state.images.push({ file: null, name, img, thumbUrl, w, h,
    polygons: polygons || [], currentPoly: [], scale: null, simHidden: false });
  state.undoStack.push([]);
  state.rankOrder.push(idx);

  if (encoding) _restoreEncodings([encoding], idx);

  buildRankList();
  simRefreshGroup(idx);
  if (simPos && simGroups[idx]) placeGroup(simGroups[idx], simPos.x, simPos.y, simAngle || 0);
  const n = state.images.length;
  updateStepMeta('step-images', imageCountLabel(n), true);
  paintArea.classList.remove('im-hidden');
  unlockStep('step-paint');
});

window.addEventListener('collab:remote-positions', (e) => {
  if (simRafId === null) return;
  const { positions, simX1: rx1, simY1: ry1, simX2: rx2, simY2: ry2 } = e.detail;
  if (rx1 != null) {
    simX1 = rx1; simY1 = ry1; simX2 = rx2; simY2 = ry2;
    _simOutExplicit = true; _simViewDirty = true;
  }
  for (const [idxStr, { x, y, angle }] of Object.entries(positions)) {
    const g = simGroups[Number(idxStr)];
    if (g) placeGroup(g, x, y, angle);
  }
});

window.addEventListener('collab:remote-scales', ({ detail: { scales } }) => {
  scales.forEach((scale, i) => {
    const entry = state.images[i];
    if (!entry) return;
    entry.scale      = scale;
    entry.scaleFixed = scale !== null;
    simRefreshGroup(i);
  });
  buildRankList();
});

function _applyBodyMoveSnapshot(entry, pushBackEvent) {
  const { imgIdx, x, y, angle } = entry;
  const g = simGroups[imgIdx];
  if (!g) return;
  window.dispatchEvent(new CustomEvent(pushBackEvent, { detail: { imgIdx, x: g.x, y: g.y, angle: g.angle } }));
  placeGroup(g, x, y, angle);
  _clearMergedImage();
}

function _applyResetSnapshot(entry, pushBackEvent) {
  if (simRafId === null) return;
  window.dispatchEvent(new CustomEvent(pushBackEvent, {
    detail: { type: 'reset', groups: simGroups.filter(Boolean).map(g => ({ imgIdx: g.imgIdx, x: g.x, y: g.y, angle: g.angle })) },
  }));
  for (const { imgIdx, x, y, angle } of entry.groups) {
    const g = simGroups[imgIdx];
    if (g) placeGroup(g, x, y, angle);
  }
  _clearMergedImage();
  window.dispatchEvent(new CustomEvent('collab:canvas-resized'));
}

function _applyResizeSnapshot(entry, pushBackEvent) {
  if (simRafId === null) return;
  window.dispatchEvent(new CustomEvent(pushBackEvent, { detail: { type: 'resize', x1: simX1, y1: simY1, x2: simX2, y2: simY2 } }));
  const { x1, y1, x2, y2 } = entry;
  simX1 = x1; simY1 = y1; simX2 = x2; simY2 = y2;
  state.outW = Math.round(x2 - x1);
  state.outH = Math.round(y2 - y1);
  cfgWidth.value  = state.outW;
  cfgHeight.value = state.outH;
  _simViewDirty = true;
  _broadcastSettings();
  window.dispatchEvent(new CustomEvent('collab:canvas-resized'));
}

window.addEventListener('collab:undo-body-move', (e) => _applyBodyMoveSnapshot(e.detail, 'collab:redo-push'));
window.addEventListener('collab:redo-body-move', (e) => _applyBodyMoveSnapshot(e.detail, 'collab:undo-push'));
window.addEventListener('collab:undo-reset',     (e) => _applyResetSnapshot(e.detail,     'collab:redo-push'));
window.addEventListener('collab:redo-reset',     (e) => _applyResetSnapshot(e.detail,     'collab:undo-push'));
window.addEventListener('collab:undo-resize',    (e) => _applyResizeSnapshot(e.detail,    'collab:redo-push'));
window.addEventListener('collab:redo-resize',    (e) => _applyResizeSnapshot(e.detail,    'collab:undo-push'));

window.addEventListener('collab:remote-drag', ({ detail: { imgIdx, x, y, angle } }) => {
  if (simRafId === null) return;
  const g = simGroups[imgIdx];
  if (g) placeGroup(g, x, y, angle);
});

window.addEventListener('collab:remote-grab', ({ detail: { imgIdx, color } }) => {
  _remoteGrabs.set(imgIdx, { color });
  _simViewDirty = true;
});

window.addEventListener('collab:remote-release', ({ detail: { imgIdx } }) => {
  _remoteGrabs.delete(imgIdx);
  _simViewDirty = true;
});

window.addEventListener('collab:remote-polygon', ({ detail: { imgIdx, polygons } }) => {
  const entry = state.images[imgIdx];
  if (!entry) return;
  entry.polygons = polygons;
  if (imgIdx === state.rankOrder[state.paintIdx]) redrawPolyOverlay(imgIdx);
  simRefreshGroup(imgIdx);
});

function _restoreEncodings(encodings, baseIdx, remapIdx) {
  if (!encodings) return;
  encodings.forEach((enc, i) => {
    if (!enc) return;
    const newIdx = remapIdx ? remapIdx[i] : baseIdx + i;
    if (newIdx < 0) return;
    yoloPool.embeddingCache.set(newIdx, {
      origW: enc.origW, origH: enc.origH,
      segments: enc.segments.map(s => ({
        classId: s.classId, className: s.className, score: s.score,
        bbox: s.bbox, maskW: s.maskW, maskH: s.maskH,
        mask: Uint8Array.from(atob(s.mask), c => c.charCodeAt(0)),
      })),
    });
  });
}

window.addEventListener('collab:remote-encoding', (e) => {
  const { imgName, encoding } = e.detail;
  const idx = state.images.findIndex(im => im.name === imgName);
  if (idx < 0 || yoloPool.embeddingCache.has(idx)) return;
  _restoreEncodings([encoding], idx);
  const dot = yoloPool.dots.get(idx);
  if (dot) {
    dot.classList.remove('im-yolo-encoding', 'im-yolo-pending');
    dot.classList.add('im-yolo-encoded');
    dot.title = 'Encoded';
  }
});

// ── Streaming collab join handlers ────────────────────────────────────────────

function _updateFilmstripThumb(imgIdx) {
  const li = rankList.querySelector('[data-img-idx="' + imgIdx + '"]');
  if (!li) return;
  const imgEl = li.querySelector('.im-rank-thumb');
  if (!imgEl) return;
  const entry = state.images[imgIdx];
  if (entry?.thumbUrl) {
    imgEl.src = entry.thumbUrl;
    imgEl.classList.remove('im-rank-thumb-pending');
  }
}

window.addEventListener('collab:remote-session-meta', ({ detail: meta }) => {
  const n = meta.imageCount;

  state.images = meta.images.map(si => ({
    file: null, name: si.name, img: null, thumbUrl: null,
    w: si.w, h: si.h,
    polygons:    si.polygons    || [],
    currentPoly: si.currentPoly || [],
    scale:      si.scale,
    scaleFixed:  si.scaleFixed  || false,
    simHidden:   si.simHidden   || false,
  }));
  state.undoStack = state.images.map(() => []);
  state.rankOrder = meta.rankOrder || state.images.map((_, i) => i);
  state.paintIdx  = Math.min(meta.paintIdx || 0, Math.max(0, state.rankOrder.length - 1));

  yoloPool.embeddingCache.clear();
  yoloPool.dots.clear();

  if (window.applyRemoteSettings) window.applyRemoteSettings(meta);

  buildRankList();
  updateStepMeta('step-images', imageCountLabel(n), true);
  if (n > 0) { paintArea.classList.remove('im-hidden'); unlockStep('step-paint'); }

  const savedPositions = {};
  meta.images.forEach((si, i) => {
    if (si.simPos) savedPositions[i] = { pos: si.simPos, angle: si.simAngle || 0 };
  });
  if (simRafId !== null) teardownSim();
  if (n > 0) initSim(savedPositions);

  // Restore host viewport so guest sees the same view immediately
  if (meta.simViewScale && simRafId !== null) {
    simViewScale  = meta.simViewScale;
    simViewOffset = { x: meta.simViewOffset.x, y: meta.simViewOffset.y };
  }
  if (meta.simX1 != null) {
    simX1 = meta.simX1; simY1 = meta.simY1;
    simX2 = meta.simX2; simY2 = meta.simY2;
  }

  _collabJoinTotal     = n;
  _collabJoinFullsDone = 0;
});

window.addEventListener('collab:remote-image-thumb', ({ detail: { imgIdx, thumb } }) => {
  const entry = state.images[imgIdx];
  if (!entry) return;
  entry.thumbUrl = thumb;
  _updateFilmstripThumb(imgIdx);
});

window.addEventListener('collab:remote-image-full', ({ detail }) => {
  const { imgIdx, name, w, h, jpegBase64, polygons, currentPoly, scale, scaleFixed, simHidden } = detail;
  const entry = state.images[imgIdx];
  if (!entry) return;
  const img = new Image();
  img.onload = () => {
    if (jpegBase64.startsWith('blob:')) URL.revokeObjectURL(jpegBase64);
    entry.img         = img;
    entry.thumbUrl    = buildThumb(img, w, h);
    if (polygons)    entry.polygons    = polygons;
    if (currentPoly) entry.currentPoly = currentPoly;
    if (scale     != null) entry.scale     = scale;
    if (scaleFixed != null) entry.scaleFixed = scaleFixed;
    if (simHidden  != null) entry.simHidden  = simHidden;
    _updateFilmstripThumb(imgIdx);
    simRefreshGroup(imgIdx);
    _simViewDirty = true;
    if (++_collabJoinFullsDone >= _collabJoinTotal) loadPainterImage(state.paintIdx);
  };
  img.src = jpegBase64;
});

initSim();

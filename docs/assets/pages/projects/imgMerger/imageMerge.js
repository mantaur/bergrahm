// ── Image Merger ──────────────────────────────────────────────────────────────
const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.matchMedia("(pointer: coarse)").matches;

// Keep in sync with the ?v= cache-buster in index.html. Shown by the import
// debug overlay so on-device tests can prove which build they are running.
const BUILD = "103";

// Import/decode debug log. Always captured (bounded, strings only); the on-screen
// overlay is opt-in via ?impdbg=1 or localStorage impdbg=1.
const _implog = [];
window._implog = _implog;
function implog(msg) {
  if (_implog.length > 300) _implog.splice(0, 100);
  _implog.push(msg);
  const el = document.getElementById("imp-dbg");
  if (el) el.textContent = "BUILD " + BUILD + "\n" + _implog.slice(-20).join("\n");
}
(function () {
  const p = new URLSearchParams(location.search);
  if (!p.has("impdbg") && localStorage.getItem("impdbg") !== "1") return;
  const el = document.createElement("div");
  el.id = "imp-dbg";
  el.style.cssText =
    "position:fixed;left:6px;bottom:6px;z-index:99999;max-width:70vw;font:10px/1.3 monospace;" +
    "background:rgba(0,0,0,.85);color:#fc6;padding:6px 8px;border-radius:6px;white-space:pre-wrap;" +
    "pointer-events:none;max-height:35vh;overflow:hidden";
  el.textContent = "BUILD " + BUILD;
  document.body.appendChild(el);
  implog("UA " + navigator.userAgent);
  window.addEventListener("error", (e) => implog("ERR " + e.message));
  window.addEventListener("unhandledrejection", (e) => implog("REJ " + ((e.reason && e.reason.message) || e.reason)));
})();

const state = {
  // config
  outW: 1080,
  outH: 1920,
  fillColor: "#ff69b4",
  useYolo: false,
  yoloDecodeSize: 512,
  yoloWorkerCount: 1, // single encoder -- fast enough, and keeps the UI simple

  // images[i] = { id, file, blob, name, thumbUrl, w, h, polygons, currentPoly }
  //   blob = compressed bytes; the full bitmap is decoded on demand (decodeEntry).
  images: [],

  // rank order: array of image ids, position 0 = highest importance
  rankOrder: [],

  // painter state
  paintIdx: 0, // which image is being painted (position in rankOrder)
  undoStack: new Map(), // id -> mask-undo snapshots[]
};

// Images are addressed by a stable `id` (assigned at creation, shared across
// peers), not by array position -- so `imgIdx` here holds an id, and removing or
// reordering never invalidates a held reference.
let _imgIdSeq = 0;
function newImgId() {
  return window.crypto && crypto.randomUUID ? crypto.randomUUID() : "im-" + Date.now().toString(36) + "-" + ++_imgIdSeq;
}
function imgById(id) {
  return state.images.find((e) => e.id === id) || null;
}
function imgIdxById(id) {
  return state.images.findIndex((e) => e.id === id);
}

// ── Icon SVGs ─────────────────────────────────────────────────────────────────
const EYE_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8c1.5-3.5 4-5 7-5s5.5 1.5 7 5c-1.5 3.5-4 5-7 5s-5.5-1.5-7-5z"/><circle cx="8" cy="8" r="2.2"/></svg>';
const EYE_CLOSED = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8c1.5-3.5 4-5 7-5s5.5 1.5 7 5c-1.5 3.5-4 5-7 5s-5.5-1.5-7-5z"/><circle cx="8" cy="8" r="2.2"/><line x1="2" y1="2" x2="14" y2="14"/></svg>';
const REMOVE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const cfgUseYolo = document.getElementById("cfg-use-yolo");
const btnYoloMobile = document.getElementById("btn-yolo-mobile");
const yoloMobileStatus = document.getElementById("yolo-mobile-status");
const cfgBlendMode = document.getElementById("cfg-blend-mode");
const cfgDitherFields = document.getElementById("cfg-dither-fields");
const cfgDitherExpField = document.getElementById("cfg-dither-exp-field");
const cfgSeed = document.getElementById("cfg-seed");
const cfgDitherExp = document.getElementById("cfg-dither-exp");
const cfgWidth = document.getElementById("cfg-width");
const cfgHeight = document.getElementById("cfg-height");
const cfgSizePreset = document.getElementById("cfg-size-preset");
const cfgSlides = document.getElementById("cfg-slides");
const cfgFullSize = document.getElementById("cfg-full-size");
const cfgFill = document.getElementById("cfg-fill");
const cfgFillTransparent = document.getElementById("cfg-fill-transparent");
const cfgImages = document.getElementById("cfg-images");

const secPaint = document.getElementById("section-paint");
const paintArea = document.getElementById("paint-area");

const rankList = document.getElementById("rank-list");
const paintName = document.getElementById("paint-image-name");
const paintIndexLbl = document.getElementById("paint-index-label");
const btnUndo = document.getElementById("btn-undo");
const btnClearMask = document.getElementById("btn-clear-mask");
const btnPrev = document.getElementById("btn-prev-img");
const btnNext = document.getElementById("btn-next-img");
const canvasWrap = document.getElementById("canvas-wrap");
const paintCanvas = document.getElementById("paint-canvas");
const maskCanvas = document.getElementById("mask-canvas");

const yoloControls = document.getElementById("yolo-controls");
const btnYoloToggle = document.getElementById("btn-yolo-toggle");
const yoloStatus = document.getElementById("yolo-status");
const yoloWorkerCountEl = document.getElementById("yolo-worker-count");

const painterScaleAuto = document.getElementById("painter-scale-auto");
const painterScaleInp = document.getElementById("painter-scale-inp");
const painterZoomVal = document.getElementById("painter-zoom-val");
const scalePreviewCanvas = document.getElementById("painter-scale-preview");

const simWrap = document.getElementById("sim-wrap");
const simCanvas = document.getElementById("sim-canvas");
const simCtx = simCanvas.getContext("2d");
const btnSimReset = document.getElementById("btn-sim-reset");
const btnSimSelect = document.getElementById("btn-sim-select");
const simSelBadge = document.getElementById("sim-select-badge");
const btnMerge = document.getElementById("btn-merge");
const panelWrap = document.getElementById("panel-wrap");
const btnPanelToggle = document.getElementById("btn-panel-toggle");

const btnExportSession = document.getElementById("btn-export-session");
const inpImportSession = document.getElementById("inp-import-session");
const sessionStatusEl = document.getElementById("session-status");
const sessionConfirm = document.getElementById("session-confirm");
const btnSessReplace = document.getElementById("btn-sess-replace");
const btnSessAdd = document.getElementById("btn-sess-add");
const btnSessCancel = document.getElementById("btn-sess-cancel");
const btnCancel = document.getElementById("btn-cancel");
const btnDownload = document.getElementById("btn-download");
const simStatusEl = document.getElementById("sim-status");

const paintCtx = paintCanvas.getContext("2d");
const maskCtx = maskCanvas.getContext("2d");

// ── Panel ─────────────────────────────────────────────────────────────────────

function panelSetOpen(open) {
  panelWrap.classList.toggle("im-panel-hidden", !open);
  document.body.classList.toggle("im-panel-open", open);
}

btnPanelToggle.addEventListener("click", () => panelSetOpen(panelWrap.classList.contains("im-panel-hidden")));

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!panelWrap.classList.contains("im-panel-hidden")) panelSetOpen(false);
});

panelSetOpen(false); // start closed

// ── Config step ───────────────────────────────────────────────────────────────

// Detect GPU capability and set encoding default. The toggle lives in "More" settings.
detectEncodingCapability().then(({ tier }) => {
  const enable = tier === "fast";
  cfgUseYolo.checked = enable;
  state.useYolo = enable;
  if (enable) yoloControls.classList.remove("im-hidden");
  ensureYoloEncoding();
  _syncYoloMobile();
});

cfgBlendMode.addEventListener("change", () => {
  const mode = cfgBlendMode.value;
  cfgDitherFields.classList.toggle("im-hidden", mode !== "dither"); // seed: dither only
  cfgDitherExpField.classList.toggle("im-hidden", mode !== "dither" && mode !== "gradient"); // sharpness: both
  if (!window._collabApplyingRemote) _broadcastSettings();
});

// Seed / sharpness changes also sync to peers (they affect the merge result).
[cfgSeed, cfgDitherExp].forEach((el) =>
  el.addEventListener("input", () => {
    if (!window._collabApplyingRemote) _broadcastSettings();
  }),
);

// W/H inputs are the FULL output. The preset is a per-slide format; Slides (N)
// multiplies the preset width (carousel) and slices the download into N frames.
let _slideBaseW = 1080,
  _slideBaseH = 1920; // per-slide size from the last preset

function slidesN() {
  return Math.max(1, parseInt(cfgSlides.value) || 1);
}

function _commitFullSize(w, h) {
  state.outW = w;
  state.outH = h;
  if (state.images.length > 0) updatePainterZoom(state.rankOrder[state.paintIdx]);
  scheduleResizeSim();
  if (!window._collabApplyingRemote) _broadcastSettings();
  _updateCarouselHint();
}

function _updateCarouselHint() {
  const n = slidesN();
  cfgFullSize.textContent = n > 1 ? n + " slides of " + Math.round(state.outW / n) + "×" + state.outH : "";
  btnDownload.title = n > 1 ? "Download " + n + " slides (zip)" : "Download PNG";
}

// Reflect the current output size in the preset dropdown + carousel hint (after a
// session load, remote settings, undo or corner-resize set the size directly).
function _syncCarouselUI() {
  _slideBaseW = Math.round(state.outW / slidesN());
  _slideBaseH = state.outH;
  const per = _slideBaseW + "x" + _slideBaseH;
  cfgSizePreset.value = [...cfgSizePreset.options].some((o) => o.value === per) ? per : "custom";
  _updateCarouselHint();
}
window.syncCarouselUI = _syncCarouselUI;

cfgWidth.addEventListener("input", () => {
  cfgSizePreset.value = "custom";
  _commitFullSize(parseInt(cfgWidth.value) || 1080, parseInt(cfgHeight.value) || 1920);
});

cfgHeight.addEventListener("input", () => {
  cfgSizePreset.value = "custom";
  _commitFullSize(parseInt(cfgWidth.value) || 1080, parseInt(cfgHeight.value) || 1920);
});

cfgSizePreset.addEventListener("change", () => {
  if (cfgSizePreset.value === "custom") return;
  const [w, h] = cfgSizePreset.value.split("x").map(Number);
  _slideBaseW = w;
  _slideBaseH = h;
  const n = slidesN();
  cfgWidth.value = w * n;
  cfgHeight.value = h;
  _commitFullSize(w * n, h);
});

cfgSlides.addEventListener("input", () => {
  const n = slidesN();
  if (cfgSizePreset.value !== "custom") {
    cfgWidth.value = _slideBaseW * n;
    cfgHeight.value = _slideBaseH;
    _commitFullSize(_slideBaseW * n, _slideBaseH);
  } else {
    // Custom size: slides only controls how the current width is sliced.
    _updateCarouselHint();
    if (!window._collabApplyingRemote) _broadcastSettings();
  }
});

_syncCarouselUI(); // reflect the default size in the preset dropdown on load

cfgFill.addEventListener("input", () => {
  state.fillColor = cfgFill.value;
  cfgFillTransparent.classList.remove("im-active");
  if (state.images.length > 0) updateScalePreview(state.rankOrder[state.paintIdx]);
  if (!window._collabApplyingRemote) _broadcastSettings();
});

cfgFill.addEventListener("click", () => {
  if (state.fillColor === null) {
    state.fillColor = cfgFill.value;
    cfgFillTransparent.classList.remove("im-active");
    if (state.images.length > 0) updateScalePreview(state.rankOrder[state.paintIdx]);
    if (!window._collabApplyingRemote) _broadcastSettings();
  }
});

cfgFillTransparent.addEventListener("click", () => {
  state.fillColor = null;
  cfgFillTransparent.classList.add("im-active");
  if (state.images.length > 0) updateScalePreview(state.rankOrder[state.paintIdx]);
  if (!window._collabApplyingRemote) _broadcastSettings();
});

// Single source of truth for the peer-synced settings -- used by BOTH the live
// broadcast and the join snapshot (getSessionMeta), so the two can't drift (which
// is how seed/ditherExp/slides previously failed to sync). applyRemoteSettings
// consumes every key here.
function _settingsPayload() {
  return {
    outW: state.outW,
    outH: state.outH,
    slides: slidesN(),
    fillColor: state.fillColor,
    blendMode: cfgBlendMode.value,
    seed: parseInt(cfgSeed.value, 10) || 42,
    ditherExp: parseInt(cfgDitherExp.value, 10) || 4,
    simX1,
    simY1,
    simX2,
    simY2,
  };
}

let _broadcastSettingsTimer = null;
function _broadcastSettings() {
  if (_broadcastSettingsTimer) clearTimeout(_broadcastSettingsTimer);
  _broadcastSettingsTimer = setTimeout(() => {
    _broadcastSettingsTimer = null;
    window.dispatchEvent(
      new CustomEvent("collab:settings-changed", {
        detail: _settingsPayload(),
      }),
    );
  }, 200);
}

let _settingsThrottleTs = 0;
function _broadcastSettingsNow() {
  const now = Date.now();
  if (now - _settingsThrottleTs < 50) return;
  _settingsThrottleTs = now;
  window.dispatchEvent(
    new CustomEvent("collab:settings-changed", {
      detail: { outW: state.outW, outH: state.outH, fillColor: state.fillColor, blendMode: cfgBlendMode.value, slides: slidesN(), simX1, simY1, simX2, simY2 },
    }),
  );
}

// The only door for scale writes: local state, sim group, and the shared doc
// (via collab:scales-changed, which accepts partial maps) stay in step.
function setScales(scales, opts = {}) {
  for (const [id, scale] of Object.entries(scales)) {
    const entry = imgById(id);
    if (!entry) continue;
    entry.scale = scale;
    entry.scaleFixed = scale !== null;
    if (opts.refresh !== false) simRefreshGroup(id, opts.keepPreview === true);
  }
  if (opts.broadcast !== false) {
    window.dispatchEvent(new CustomEvent("collab:scales-changed", { detail: { scales } }));
  }
}

function setScale(imgIdx, scale, opts = {}) {
  setScales({ [imgIdx]: scale }, opts);
}

cfgUseYolo.addEventListener("change", () => {
  state.useYolo = cfgUseYolo.checked;
  yoloControls.classList.toggle("im-hidden", !state.useYolo);
  ensureYoloEncoding();
  _syncYoloMobile();
  // Rebuild rank list to add or remove SAM dots.
  if (state.images.length > 0) buildRankList();
});

// Mobile-only auto-segment button (a proxy for the advanced checkbox).
function _syncYoloMobile() {
  if (!btnYoloMobile) return;
  btnYoloMobile.textContent = state.useYolo ? "Auto-detect: on" : "Auto-detect subjects";
  btnYoloMobile.classList.toggle("im-yolo-active", state.useYolo);
}
if (btnYoloMobile)
  btnYoloMobile.addEventListener("click", () => {
    cfgUseYolo.checked = !cfgUseYolo.checked;
    cfgUseYolo.dispatchEvent(new Event("change")); // runs the toggle handler above
  });

// ── Painter scale bar ─────────────────────────────────────────────────────────
painterScaleAuto.addEventListener("change", () => {
  const imgIdx = state.rankOrder[state.paintIdx];
  painterScaleInp.disabled = painterScaleAuto.checked;
  setScale(imgIdx, painterScaleAuto.checked ? null : parseFloat(painterScaleInp.value));
  if (painterScaleAuto.checked) painterScaleInp.value = computeAutoScales()[imgIdx].scale.toFixed(2);
  updatePainterZoom(imgIdx);
});

painterScaleInp.addEventListener("change", () => {
  const imgIdx = state.rankOrder[state.paintIdx];
  let v = parseFloat(painterScaleInp.value);
  if (isNaN(v)) v = 1.0;
  v = Math.max(0.05, Math.min(20, v));
  painterScaleInp.value = v.toFixed(2);
  setScale(imgIdx, v);
  updatePainterZoom(imgIdx);
});

function updatePainterZoom(imgIdx) {
  const entry = imgById(imgIdx);
  const resolvedScale = entry.scale === null ? computeAutoScales()[imgIdx].scale : entry.scale;
  const displayW = Math.min(DISPLAY_MAX_W, entry.w);
  const outputW = entry.w * resolvedScale;
  painterZoomVal.textContent = Math.round((displayW / outputW) * 100) + "%";
  updateScalePreview(imgIdx);
}

function updateScalePreview(imgIdx) {
  const entry = imgById(imgIdx);
  const outW = state.outW;
  const outH = state.outH;

  const resolvedScale = entry.scale === null ? computeAutoScales()[imgIdx].scale : entry.scale;
  const imgW = entry.w * resolvedScale;
  const imgH = entry.h * resolvedScale;

  // Size the canvas to the union bounding box of output + scaled image, so the
  // larger geometry in each axis fills it -- no cramming into a corner when the
  // image and output aspect ratios differ wildly. Longest side capped at 80px.
  // (Done here, not in loadPainterImage, because the box depends on the scale,
  // which changes live without a painter reload.)
  const PREVIEW_MAX = 80;
  const boundW = Math.max(outW, imgW);
  const boundH = Math.max(outH, imgH);
  const bAr = boundW / boundH;
  const CW = bAr >= 1 ? PREVIEW_MAX : Math.max(1, Math.round(PREVIEW_MAX * bAr));
  const CH = bAr >= 1 ? Math.max(1, Math.round(PREVIEW_MAX / bAr)) : PREVIEW_MAX;
  scalePreviewCanvas.width = CW;
  scalePreviewCanvas.height = CH;
  const ctx = scalePreviewCanvas.getContext("2d");

  // Fit the union box into the canvas with a 1px margin (both shapes share the
  // top-left origin; the larger one touches the far edges).
  const fit = Math.min((CW - 2) / boundW, (CH - 2) / boundH);
  const dispOutW = Math.round(outW * fit);
  const dispOutH = Math.round(outH * fit);

  // Checkered background (transparent-PNG convention)
  const TILE = 6;
  for (let y = 0; y < CH; y += TILE) {
    for (let x = 0; x < CW; x += TILE) {
      ctx.fillStyle = (x / TILE + y / TILE) % 2 === 0 ? "#3c3c3c" : "#2a2a2a";
      ctx.fillRect(x, y, TILE, TILE);
    }
  }

  // Output rect filled with the configured fill color (skipped when transparent)
  if (state.fillColor !== null) {
    ctx.fillStyle = state.fillColor;
    ctx.fillRect(1.5, 1.5, dispOutW, dispOutH);
  }

  // Output rect outline
  ctx.strokeStyle = "#777";
  ctx.lineWidth = 1;
  ctx.strokeRect(1.5, 1.5, dispOutW, dispOutH);

  // Image rect at target scale (green = manual, gray = auto estimate)
  ctx.strokeStyle = entry.scale === null ? "#888" : "springgreen";
  ctx.strokeRect(1.5, 1.5, Math.round(imgW * fit), Math.round(imgH * fit));
}

// Decode-on-demand: images are kept only as compressed bytes (entry.blob); the
// full-res bitmap is decoded transiently when needed (painter, merge, encode,
// export) and released, so memory stays ~zip-sized even with 100+ large images.
// Some mobile browsers hard-reject createImageBitmap on very large encoded
// images (dimension caps, not memory). An <img> element decodes through the
// browser's subsampling path instead; rasterize at the target size and hand
// back a real ImageBitmap so callers (incl. worker transfer) are unaffected.
function _imgElementBitmap(url, revoke, opts) {
  const img = new Image();
  const loaded = new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error("image decode failed"));
  });
  img.src = url;
  return loaded
    .then(() => {
      const w = opts && opts.resizeWidth ? opts.resizeWidth : img.naturalWidth;
      const h = opts && opts.resizeHeight ? opts.resizeHeight : img.naturalHeight;
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      return createImageBitmap(cv);
    })
    .finally(() => {
      if (revoke) URL.revokeObjectURL(url);
    });
}

// Read the blob's actual backing bytes: size + first/last two bytes (a JPEG
// must show head=ffd8 tail=ffd9). A READ-FAIL or wrong markers means the
// browser's blob storage is broken/truncated -- the decoder never had a chance.
async function _blobProbe(blob) {
  try {
    const hx = (a) => Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - 2)).arrayBuffer());
    return "size=" + blob.size + " head=" + hx(head) + " tail=" + hx(tail);
  } catch (err) {
    return "READ-FAIL: " + (err && err.message);
  }
}

// Sniff the container from magic bytes; ImageDecoder needs the true type.
function _sniffImageType(bytes) {
  const b = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  return null;
}

// WebCodecs decode straight from the ArrayBuffer -- no Blob at any point, so
// the browser's blob storage (whose backing can go unreadable on Android) is
// out of the hot path entirely. desiredWidth/Height let JPEG decode subsample;
// the createImageBitmap resize off the frame guarantees the exact target.
function _imageDecoderBitmap(bytes, type, opts) {
  const init = { data: bytes, type };
  if (opts && opts.resizeWidth) {
    init.desiredWidth = opts.resizeWidth;
    init.desiredHeight = opts.resizeHeight;
  }
  const dec = new ImageDecoder(init);
  return dec
    .decode()
    .then(({ image }) => createImageBitmap(image, opts || undefined).finally(() => image.close()))
    .finally(() => dec.close());
}

// opts can carry { resizeWidth, resizeHeight, resizeQuality } to decode straight
// to a target size without ever materialising the full-res bitmap.
// Preference order for entries carrying entry.bytes (imported/collab/file-added):
// 1. ImageDecoder on the raw bytes (no blob storage involvement at all)
// 2. createImageBitmap on a transient Blob minted per call
// 3. img element decode of the same transient Blob
function decodeEntry(entry, opts) {
  if (!entry || (!entry.blob && !entry.bytes)) return Promise.resolve(null);
  const name = entry.name || entry.id;
  const tgt = opts ? opts.resizeWidth + "x" + opts.resizeHeight : "full";

  let first = null;
  const type = entry.bytes && entry.bytes.byteLength > 0 ? _sniffImageType(entry.bytes) : null;
  if (type && typeof ImageDecoder !== "undefined") {
    first = _imageDecoderBitmap(entry.bytes, type, opts).catch((err) => {
      implog("idec fail " + name + " " + tgt + ": " + (err && err.message));
      return null; // fall through to the blob chain
    });
  } else {
    first = Promise.resolve(null);
  }

  return first.then((bm) => {
    if (bm) return bm;
    const haveBytes = entry.bytes && entry.bytes.byteLength > 0;
    const src = haveBytes ? new Blob([entry.bytes], { type: "image/jpeg" }) : entry.blob;
    return createImageBitmap(src, opts || undefined).catch(async (err) => {
      implog("cib fail " + name + " " + tgt + (haveBytes ? " (bytes)" : "") + ": " + (err && err.message));
      implog("probe " + name + " " + (await _blobProbe(src)));
      // With bytes at hand, feed the img element a data: URL -- inline bytes,
      // no blob storage, works on insecure (plain-http LAN) contexts where
      // ImageDecoder does not exist. Otherwise fall back to an object URL.
      const url = haveBytes ? _bufToDataUrl(entry.bytes, type || "image/jpeg") : URL.createObjectURL(src);
      return _imgElementBitmap(url, !haveBytes, opts).then(
        (bm2) => {
          implog("img-fallback ok " + name + (haveBytes ? " (data-url)" : ""));
          return bm2;
        },
        (err2) => {
          implog("img-fallback fail " + name + ": " + (err2 && err2.message));
          throw err2;
        },
      );
    });
  });
}

// Base64 data URL from raw bytes -- portable across peers (a blob: URL is only
// valid in the document that created it, so it can't be streamed to a guest).
function _bufToDataUrl(buf, type) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return "data:" + (type || "image/jpeg") + ";base64," + btoa(bin);
}

function buildThumb(img, w, h) {
  const ts = Math.min(1, 256 / Math.max(w, h));
  const tW = Math.max(1, Math.round(w * ts));
  const tH = Math.max(1, Math.round(h * ts));
  const tc = document.createElement("canvas");
  tc.width = tW;
  tc.height = tH;
  tc.getContext("2d").drawImage(img, 0, 0, tW, tH);
  return tc.toDataURL("image/jpeg", 0.82);
}

function imageCountLabel(n) {
  return n + " image" + (n === 1 ? "" : "s");
}

// Dragging files over the upload zone lights it green. The file input fills the
// zone (inset:0), so it natively ingests the drop -- these listeners only drive
// the highlight, and only for actual file drags (not text/element drags).
const uploadZone = cfgImages.closest(".im-upload-zone");
if (uploadZone) {
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
  const lit = (on) => uploadZone.classList.toggle("im-uz-drag", on);
  uploadZone.addEventListener("dragenter", (e) => {
    if (hasFiles(e)) lit(true);
  });
  uploadZone.addEventListener("dragover", (e) => {
    if (hasFiles(e)) lit(true);
  });
  uploadZone.addEventListener("dragleave", (e) => {
    if (!uploadZone.contains(e.relatedTarget)) lit(false);
  });
  uploadZone.addEventListener("drop", () => lit(false));
}

cfgImages.addEventListener("change", () => {
  const files = Array.from(cfgImages.files);
  if (!files.length) return;
  // Clear input so re-selecting same files triggers change again.
  cfgImages.value = "";

  const firstLoad = state.images.length === 0;
  const entries = new Array(files.length); // buffered so a mid-decode remote add can't collide
  let loaded = 0;

  files.forEach((file, i) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const w = img.naturalWidth,
        h = img.naturalHeight;
      const thumbUrl = buildThumb(img, w, h);
      URL.revokeObjectURL(url);

      const entry = {
        id: newImgId(),
        file,
        blob: file,
        assetHash: null,
        thumbHash: null,
        name: file.name,
        thumbUrl,
        w,
        h,
        polygons: [],
        currentPoly: [],
        scale: null,
        simHidden: false,
      };
      // Rescue the bytes into JS memory while the File reference is fresh: on
      // Android the picker's grant can lapse, after which every read of the File
      // throws NotReadableError ("permission problems after a reference...").
      file.arrayBuffer().then(
        (buf) => {
          entry.bytes = buf;
        },
        () => {},
      );
      ensureAssetHash(entry); // content-address the bytes for on-demand serving
      ensureThumbHash(entry); // content-address the tiny preview too
      entries[i] = entry;
      loaded++;
      if (loaded === files.length) {
        registerImages(entries);
        paintArea.classList.remove("im-hidden");
        loadPainterImage(firstLoad ? 0 : Math.min(state.paintIdx, state.images.length - 1));
        unlockStep("step-paint");
        panelSetOpen(true);
        updateStepMeta("step-images", imageCountLabel(state.images.length), true);
        ensureYoloEncoding(); // start the model / queue the new images for segmentation
      }
    };
    img.src = url;
  });
});

// ── Rank list (drag-to-reorder) ───────────────────────────────────────────────
function buildRankList() {
  rankList.innerHTML = "";
  yoloPool.dots.clear();
  state.rankOrder.forEach((imgIdx, rank) => {
    const item = createRankItem(imgIdx, rank);
    rankList.appendChild(item);
  });
  btnExportSession.disabled = state.images.length === 0;
  _refreshPainterNav();
  _showMergeBtn(); // an image arriving/leaving can change merge readiness (all transferred?)
}

// The only door for adding images: state, undo stacks, rank order, and the shared
// doc (via collab:images-added) stay in step no matter which path adds.
function registerImages(entries, opts = {}) {
  const ids = [];
  for (const entry of entries) {
    if (!entry || imgById(entry.id)) continue;
    state.images.push(entry);
    state.undoStack.set(entry.id, []);
    if (!state.rankOrder.includes(entry.id)) state.rankOrder.push(entry.id);
    ids.push(entry.id);
  }
  if (!ids.length) return ids;
  buildRankList();
  if (opts.broadcast !== false) {
    window.dispatchEvent(new CustomEvent("collab:images-added", { detail: { ids } }));
  }
  return ids;
}

// The only door for visibility writes: sim group and shared doc (via
// collab:image-meta-changed) stay in step with the eye toggle.
function setSimHidden(imgIdx, hidden, opts = {}) {
  const entry = imgById(imgIdx);
  if (!entry || entry.simHidden === hidden) return;
  entry.simHidden = hidden;
  const g = simGroups.get(imgIdx);
  if (g && simRafId !== null) {
    g.inWorld = !hidden;
    _simViewDirty = true;
  }
  const eye = rankList.querySelector('li[data-img-idx="' + imgIdx + '"] .im-film-hide');
  if (eye) {
    eye.innerHTML = hidden ? EYE_CLOSED : EYE_OPEN;
    eye.title = hidden ? "Show in sim" : "Hide in sim";
  }
  if (opts.broadcast !== false) {
    window.dispatchEvent(new CustomEvent("collab:image-meta-changed", { detail: { imgIdx, meta: { simHidden: hidden } } }));
  }
}

// The only door for reordering: keeps paintIdx on the same image and syncs the doc.
function setRankOrder(order, opts = {}) {
  const curImgIdx = state.rankOrder[state.paintIdx];
  state.rankOrder = order;
  const cur = state.rankOrder.indexOf(curImgIdx);
  if (cur !== -1) state.paintIdx = cur;
  buildRankList();
  _resortEncodeQueue();
  if (opts.broadcast !== false) {
    window.dispatchEvent(new CustomEvent("collab:rank-order-changed", { detail: { order: state.rankOrder.slice() } }));
  }
}

// Keep the painter's index label + prev/next enabled state in sync with the image list,
// so an image that arrives (or leaves) while the painter is open updates the controls
// even without a full loadPainterImage.
function _refreshPainterNav() {
  if (state.images.length === 0) return;
  const rankIdx = Math.min(state.paintIdx, state.images.length - 1);
  paintIndexLbl.textContent = rankIdx + 1 + " / " + state.images.length;
  btnPrev.disabled = rankIdx === 0;
  btnNext.disabled = rankIdx === state.images.length - 1;
}

// opts.broadcast === false when applying a removal received from a peer, so the
// removal isn't echoed back out (avoids a rebroadcast loop).
function removeImage(imgIdx, opts = {}) {
  const idx = imgIdxById(imgIdx);
  if (idx === -1) return; // unknown / already-removed id (e.g. late remote msg)
  if (opts.broadcast !== false) {
    window.dispatchEvent(new CustomEvent("collab:image-removed", { detail: { imgIdx } }));
  }

  // Stable ids: a removal is a plain delete -- nothing else needs remapping.
  const goneHash = state.images[idx].assetHash;
  const goneThumb = state.images[idx].thumbHash;
  state.images.splice(idx, 1);
  state.undoStack.delete(imgIdx);
  state.rankOrder = state.rankOrder.filter((id) => id !== imgIdx);
  // Evict the bytes if no remaining image references them (bounds memory; also avoids a
  // stale store entry suppressing a later pull of the same content).
  if (goneHash && !state.images.some((e) => e.assetHash === goneHash)) assetStore.delete(goneHash);
  if (goneThumb && !state.images.some((e) => e.thumbHash === goneThumb)) assetStore.delete(goneThumb);

  // SAM: drop cache/queue entries for this id. If a worker is mid-encode for it,
  // mark the id stale so onEncoded discards the incoming result.
  yoloPool.embeddingCache.delete(imgIdx);
  yoloPool.encodeQueue = yoloPool.encodeQueue.filter((id) => id !== imgIdx);
  yoloPool.encodeRetries.delete(imgIdx);
  yoloPool.dots.delete(imgIdx);
  for (let wi = 0; wi < yoloPool.encoding.length; wi++) {
    if (yoloPool.encoding[wi] === imgIdx) {
      yoloPool.staleEncodeSet.add(imgIdx);
      yoloPool.encoding[wi] = null;
    }
  }

  // Drop the sim group (Map keyed by id).
  if (simRafId !== null) simGroups.delete(imgIdx);
  if (selectedIds.delete(imgIdx)) _updateSelectionUI();

  if (state.images.length === 0) {
    buildRankList(); // clear the (now empty) filmstrip; also disables export
    paintArea.classList.add("im-hidden");
    lockStep("step-paint");
    updateStepMeta("step-images", "Upload to start", false);
    return;
  }

  state.paintIdx = Math.min(state.paintIdx, state.rankOrder.length - 1);
  buildRankList();
  const n = state.images.length;
  updateStepMeta("step-images", imageCountLabel(n), true);
  loadPainterImage(state.paintIdx);
}

function createRankItem(imgIdx, rank) {
  const entry = imgById(imgIdx);
  const li = document.createElement("li");
  li.className = "im-rank-item";
  if (state.rankOrder[state.paintIdx] === imgIdx) li.classList.add("active-paint");
  li.dataset.imgIdx = imgIdx;
  li.draggable = true;

  const thumb = document.createElement("img");
  thumb.className = "im-rank-thumb";
  if (entry.thumbUrl) {
    thumb.src = entry.thumbUrl;
  } else {
    thumb.classList.add("im-rank-thumb-pending");
  }
  thumb.alt = entry.name;

  const badge = document.createElement("span");
  badge.className = "im-rank-badge";
  badge.textContent = "#" + (rank + 1);

  // SAM encoding status dot — only visible when SAM is enabled
  if (state.useYolo) {
    const encoded = yoloPool.embeddingCache.has(imgIdx);
    const encoding = !encoded && yoloPool.encoding.includes(imgIdx);
    thumb.classList.add(encoded ? "im-yolo-encoded" : encoding ? "im-yolo-encoding" : "im-yolo-pending");
    thumb.title = encoded ? "Encoded" : encoding ? "Encoding..." : "Pending encoding";
    yoloPool.dots.set(imgIdx, thumb);
  }

  const nameLbl = document.createElement("span");
  nameLbl.className = "im-rank-name";
  nameLbl.textContent = entry.name;

  const hideBtn = document.createElement("button");
  hideBtn.className = "im-rank-edit-btn im-film-hide";
  hideBtn.innerHTML = entry.simHidden ? EYE_CLOSED : EYE_OPEN;
  hideBtn.title = entry.simHidden ? "Show in sim" : "Hide in sim";
  hideBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setSimHidden(imgIdx, !entry.simHidden);
  });

  const removeBtn = document.createElement("button");
  removeBtn.className = "im-rank-edit-btn im-btn-danger im-film-rm";
  removeBtn.innerHTML = REMOVE_ICON;
  removeBtn.title = "Remove image";
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    removeImage(imgIdx);
  });

  const btnGroup = document.createElement("div");
  btnGroup.className = "im-rank-btn-group";
  btnGroup.appendChild(hideBtn);
  btnGroup.appendChild(removeBtn);

  const editBtn = document.createElement("button");
  editBtn.className = "im-rank-edit-btn im-rank-edit-overlay";
  editBtn.textContent = "Edit mask";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const newPaintIdx = state.rankOrder.indexOf(imgIdx);
    loadPainterImage(newPaintIdx);
    openStep("step-paint");
  });

  li.appendChild(thumb);
  li.appendChild(badge);
  li.appendChild(nameLbl);
  li.appendChild(editBtn);
  li.appendChild(btnGroup);

  li.addEventListener("dragstart", onDragStart);
  li.addEventListener("dragover", onDragOver);
  li.addEventListener("dragleave", onDragLeave);
  li.addEventListener("drop", onDrop);
  li.addEventListener("dragend", onDragEnd);

  return li;
}

let dragSrcIdx = null; // index in rankOrder

function onDragStart(e) {
  dragSrcIdx = Array.from(rankList.children).indexOf(e.currentTarget);
  e.currentTarget.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  e.currentTarget.classList.add("drag-over");
}

function onDragLeave(e) {
  e.currentTarget.classList.remove("drag-over");
}

function onDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove("drag-over");
  const destIdx = Array.from(rankList.children).indexOf(e.currentTarget);
  if (dragSrcIdx === null || dragSrcIdx === destIdx) return;
  const order = state.rankOrder.slice();
  const moved = order.splice(dragSrcIdx, 1)[0];
  order.splice(destIdx, 0, moved);
  setRankOrder(order);
}

function onDragEnd(e) {
  e.currentTarget.classList.remove("dragging");
  dragSrcIdx = null;
}

// ── Painter ───────────────────────────────────────────────────────────────────
const MAX_UNDO = 30;
const DISPLAY_MAX_W = 860; // max display width for painter canvas

// The painter canvases are display-only; polygon coordinates live in image-pixel
// space (entry.w x entry.h). The backing store is capped to the on-screen size so a
// multi-megapixel phone photo doesn't allocate a ~50MB canvas that the mobile browser
// then evicts (iOS blanks oversized backing stores). A context transform maps
// image-pixel drawing onto the smaller store, so coordinates, sync and merge are
// unchanged -- only the resolution of the pixels we keep around shrinks.
let _paintImgW = 0,
  _paintImgH = 0,
  _paintBScale = 1;

// Display + capped-backing-store dimensions for an image in the painter. The backing
// store is capped to the on-screen size (x capped DPR) so a 12MP phone photo doesn't
// allocate a canvas the browser blanks under memory pressure.
function _painterDims(entry) {
  const availW = canvasWrap.parentElement.clientWidth - parseFloat(getComputedStyle(canvasWrap.parentElement).paddingLeft || "0") - parseFloat(getComputedStyle(canvasWrap.parentElement).paddingRight || "0");
  const effectiveMaxW = Math.min(DISPLAY_MAX_W, availW > 0 ? availW : DISPLAY_MAX_W);
  const scale = Math.min(1, effectiveMaxW / entry.w);
  const dispW = Math.round(entry.w * scale);
  const dispH = Math.round(entry.h * scale);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const bScale = Math.min(1, Math.max(1, Math.round(dispW * dpr)) / entry.w);
  return { dispW, dispH, bScale, bw: Math.max(1, Math.round(entry.w * bScale)), bh: Math.max(1, Math.round(entry.h * bScale)) };
}

function _fmtRate(bps) {
  if (bps >= 1048576) return (bps / 1048576).toFixed(1) + " MB/s";
  if (bps >= 1024) return Math.round(bps / 1024) + " KB/s";
  return Math.round(bps) + " B/s";
}

// Per-image download speed, sampled from the bytes received for this hash between calls
// (the loading tick calls this ~2x/s). Resets when the viewed hash changes.
let _loadSpeed = { hash: null, t: 0, got: 0, rate: 0 };
function _painterLoadSpeed(hash) {
  if (!hash || !window.collabAssetGot) return 0;
  const got = window.collabAssetGot(hash);
  const now = performance.now();
  if (_loadSpeed.hash !== hash) {
    _loadSpeed = { hash, t: now, got, rate: 0 };
    return 0;
  }
  const dt = (now - _loadSpeed.t) / 1000;
  if (dt >= 0.25) {
    _loadSpeed.rate = Math.max(0, (got - _loadSpeed.got) / dt);
    _loadSpeed.t = now;
    _loadSpeed.got = got;
  }
  return _loadSpeed.rate;
}

// Placeholder shown when an image's pixels haven't arrived yet: a plain panel with
// "Loading X%" (X from the transfer progress) instead of the stale previous image.
function _drawPainterLoading(entry, dims) {
  if (paintCanvas.width !== dims.bw || paintCanvas.height !== dims.bh) {
    paintCanvas.width = dims.bw;
    paintCanvas.height = dims.bh;
    maskCanvas.width = dims.bw;
    maskCanvas.height = dims.bh;
  }
  paintCanvas.style.width = dims.dispW + "px";
  paintCanvas.style.height = dims.dispH + "px";
  maskCanvas.style.width = dims.dispW + "px";
  maskCanvas.style.height = dims.dispH + "px";
  maskCtx.setTransform(1, 0, 0, 1, 0, 0);
  maskCtx.clearRect(0, 0, dims.bw, dims.bh); // no stale mask over the placeholder
  paintCtx.setTransform(1, 0, 0, 1, 0, 0);
  paintCtx.fillStyle = "#e5e7eb";
  paintCtx.fillRect(0, 0, dims.bw, dims.bh);
  const frac = window.collabAssetProgress ? window.collabAssetProgress(entry.assetHash) : 0;
  const pct = Math.round(frac * 100);
  paintCtx.fillStyle = "#6b7280";
  paintCtx.textAlign = "center";
  paintCtx.textBaseline = "middle";
  paintCtx.font = Math.max(13, Math.round(dims.bw * 0.045)) + "px sans-serif";
  paintCtx.fillText(pct > 0 ? "Loading " + pct + "%" : "Loading...", dims.bw / 2, dims.bh / 2);
  // With the sync debug HUD on, show THIS image's download speed -- so a discrepancy vs
  // the overall HUD rate (e.g. this image stalled while others transfer) is visible.
  if (window._sync && window._sync.on) {
    paintCtx.fillStyle = "#9ca3af";
    paintCtx.font = Math.max(11, Math.round(dims.bw * 0.03)) + "px sans-serif";
    paintCtx.fillText(_fmtRate(_painterLoadSpeed(entry.assetHash)), dims.bw / 2, dims.bh / 2 + Math.max(22, Math.round(dims.bh * 0.07)));
  }
}

let _lastPainterViewId = null;

function loadPainterImage(rankIdx) {
  state.paintIdx = rankIdx;
  const imgIdx = state.rankOrder[rankIdx];
  const entry = imgById(imgIdx);
  if (!entry) return;

  // Stepping onto an image is an explicit "retry now": reset the exhausted
  // decode backoffs so images whose decodes kept failing (memory pressure
  // during a large import) recover the moment they are viewed.
  if (_lastPainterViewId !== imgIdx) {
    _lastPainterViewId = imgIdx;
    entry._painterRetry = 0;
    if (entry.blob && !entry.thumbUrl) _thumbFallback(entry);
  }

  // These apply whether or not the pixels have arrived.
  paintName.textContent = entry.name;
  paintIndexLbl.textContent = rankIdx + 1 + " / " + state.images.length;
  currentPoly = entry.currentPoly; // point at this image's in-progress polygon
  rubberBandPt = null;
  Array.from(rankList.children).forEach((li, i) => li.classList.toggle("active-paint", i === rankIdx));
  updateUndoBtn(imgIdx);
  btnPrev.disabled = rankIdx === 0;
  btnNext.disabled = rankIdx === state.images.length - 1;

  const dims = _painterDims(entry);
  _paintImgW = entry.w;
  _paintImgH = entry.h;
  _paintBScale = dims.bScale;

  // Pixels not here yet: show a loading placeholder for THIS image (not the previous one)
  // and prioritize pulling it. It renders for real once its blob lands (_fillEntryFromStore
  // re-invokes this); the loading tick keeps the % current meanwhile.
  if (!entry.blob) {
    _drawPainterLoading(entry, dims);
    reconcileAssets();
    return;
  }

  paintCanvas.width = dims.bw;
  paintCanvas.height = dims.bh;
  maskCanvas.width = dims.bw;
  maskCanvas.height = dims.bh;
  paintCanvas.style.width = dims.dispW + "px";
  paintCanvas.style.height = dims.dispH + "px";
  maskCanvas.style.width = dims.dispW + "px";
  maskCanvas.style.height = dims.dispH + "px";

  // Decode on demand straight to the canvas backing size (full-res of a 32MP
  // photo is a ~130MB allocation; the canvas only holds bw x bh). A failed
  // decode (allocation pressure) retries with backoff while still viewed.
  decodeEntry(entry, dims.bScale < 1 ? { resizeWidth: dims.bw, resizeHeight: dims.bh, resizeQuality: "high" } : undefined)
    .then((bm) => {
      if (!bm) return;
      entry._painterRetry = 0;
      if (state.rankOrder[state.paintIdx] !== imgIdx) {
        bm.close();
        return;
      } // navigated away
      paintCtx.drawImage(bm, 0, 0, dims.bw, dims.bh);
      bm.close();
    })
    .catch((err) => {
      const tries = (entry._painterRetry || 0) + 1;
      entry._painterRetry = tries;
      implog("paint fail " + (entry.name || entry.id) + " t" + tries + ": " + (err && err.message));
      if (tries > 4) return;
      setTimeout(() => {
        if (state.rankOrder[state.paintIdx] === imgIdx) loadPainterImage(state.paintIdx);
      }, 1500 * tries);
    });
  redrawPolyOverlay(imgIdx);

  // Sync painter scale bar to this image's scale setting
  const isAuto = entry.scale === null;
  const resolvedScale = isAuto ? computeAutoScales()[imgIdx].scale : entry.scale;
  painterScaleAuto.checked = isAuto;
  painterScaleInp.disabled = isAuto;
  painterScaleInp.value = resolvedScale.toFixed(2);

  // (scale-preview canvas is sized inside updateScalePreview -> updatePainterZoom)
  updatePainterZoom(imgIdx);

  if (state.useYolo && yoloPool.readyCount > 0) {
    updateYoloStatus(yoloPool.embeddingCache.has(imgIdx) ? (yoloPool.yoloMode ? "Click a subject to segment" : "YOLO ready") : "Encoding...");
  }
}

// Keep the "Loading X%" placeholder's percentage current while the viewed image streams in.
setInterval(() => {
  if (state.images.length === 0 || paintArea.classList.contains("im-hidden")) return;
  const entry = imgById(state.rankOrder[state.paintIdx]);
  if (entry && !entry.blob) _drawPainterLoading(entry, _painterDims(entry));
}, 500);

// ── Lasso / polygon overlay ───────────────────────────────────────────────────
const SNAP_RADIUS_PX = 15; // snap-to-close distance in display pixels

// currentPoly is reassigned to entry.currentPoly on each image load so mutations
// persist automatically when navigating between images.
let currentPoly = [];
let rubberBandPt = null;

function getCanvasPos(e) {
  const rect = paintCanvas.getBoundingClientRect();
  const scaleX = _paintImgW / rect.width;
  const scaleY = _paintImgH / rect.height;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

/** Snap radius in canvas-native pixels (accounts for display scaling). */
function snapRadius() {
  return SNAP_RADIUS_PX * (_paintImgW / paintCanvas.getBoundingClientRect().width);
}

// Scale a desired CSS-pixel size into native canvas pixels so lines/dots are
// always visible regardless of how much the image is scaled down for display.
function canvasPx(cssPx) {
  const cssW = paintCanvas.getBoundingClientRect().width;
  if (!cssW) return cssPx;
  return Math.max(cssPx, (cssPx * _paintImgW) / cssW);
}

function redrawPolyOverlay(imgIdx) {
  const entry = imgById(imgIdx);
  // Draw in image-pixel space; the transform maps it onto the capped backing store.
  maskCtx.setTransform(_paintBScale, 0, 0, _paintBScale, 0, 0);
  maskCtx.clearRect(0, 0, _paintImgW, _paintImgH);

  // Completed polygons
  for (const poly of entry.polygons) {
    drawPoly(poly, "rgba(255,51,102,0.22)", "#ff3366", true);
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
    maskCtx.strokeStyle = "rgba(255,220,0,0.9)";
    maskCtx.lineWidth = lw;
    maskCtx.stroke();
    maskCtx.setLineDash([]);

    // Snap ring on first vertex once closeable
    if (currentPoly.length >= 3) {
      maskCtx.beginPath();
      maskCtx.arc(currentPoly[0].x, currentPoly[0].y, snapRadius(), 0, Math.PI * 2);
      maskCtx.strokeStyle = "rgba(255,255,80,0.45)";
      maskCtx.lineWidth = lw;
      maskCtx.stroke();
    }

    // Vertex dots for in-progress poly
    currentPoly.forEach((v, i) => {
      maskCtx.beginPath();
      maskCtx.arc(v.x, v.y, i === 0 ? canvasPx(7) : canvasPx(4), 0, Math.PI * 2);
      maskCtx.fillStyle = i === 0 ? "#ffee44" : "#ff3366";
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
  maskCtx.fillStyle = fillStyle;
  maskCtx.fill();
  maskCtx.strokeStyle = strokeStyle;
  maskCtx.lineWidth = lw;
  maskCtx.stroke();
  poly.forEach((v) => {
    maskCtx.beginPath();
    maskCtx.arc(v.x, v.y, canvasPx(4), 0, Math.PI * 2);
    maskCtx.fillStyle = strokeStyle;
    maskCtx.fill();
  });
}

// ── Lasso interaction ─────────────────────────────────────────────────────────
canvasWrap.addEventListener("click", (e) => {
  const imgIdx = state.rankOrder[state.paintIdx];
  const entry = imgById(imgIdx);
  const pos = getCanvasPos(e);

  // Seg mode: use click as a segment prompt
  if (yoloPool.yoloMode) {
    if (yoloPool.readyCount === 0) return;
    requestDecode(pos.x, pos.y);
    return;
  }

  const snap = snapRadius();

  // Close polygon when clicking near first vertex (need ≥3 vertices)
  if (currentPoly.length >= 3) {
    const dx = pos.x - currentPoly[0].x;
    const dy = pos.y - currentPoly[0].y;
    if (dx * dx + dy * dy <= snap * snap) {
      setPolygons(imgIdx, [...entry.polygons, currentPoly.slice()], { undo: true, clearCurrent: true });
      return;
    }
  }

  pushPolyUndo(imgIdx);
  currentPoly.push({ x: pos.x, y: pos.y });
  redrawPolyOverlay(imgIdx);
  updateUndoBtn(imgIdx);
});

canvasWrap.addEventListener("mousemove", (e) => {
  if (currentPoly.length === 0) return;
  rubberBandPt = getCanvasPos(e);
  redrawPolyOverlay(state.rankOrder[state.paintIdx]);
});

canvasWrap.addEventListener("mouseleave", () => {
  if (currentPoly.length === 0) return;
  rubberBandPt = null;
  redrawPolyOverlay(state.rankOrder[state.paintIdx]);
});

// Touch: a tap adds/closes a vertex; a drag scrolls the drawer (touch-action: pan-y).
let _paintTouch = null;
const TAP_SLOP = 10; // px of movement that reclassifies a tap as a scroll

canvasWrap.addEventListener(
  "touchstart",
  (e) => {
    _paintTouch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, moved: false } : null; // multi-touch is never a paint tap
  },
  { passive: true },
);

canvasWrap.addEventListener(
  "touchmove",
  (e) => {
    if (!_paintTouch) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - _paintTouch.x, t.clientY - _paintTouch.y) > TAP_SLOP) {
      _paintTouch.moved = true; // a scroll, not a tap
    }
  },
  { passive: true },
);

canvasWrap.addEventListener(
  "touchend",
  (e) => {
    const pt = _paintTouch;
    _paintTouch = null;
    if (!pt || pt.moved || e.touches.length > 0) return; // scroll/drag or multi-touch
    e.preventDefault(); // suppress the compatibility click; we paint at the tap point
    canvasWrap.dispatchEvent(new MouseEvent("click", { clientX: pt.x, clientY: pt.y, bubbles: true }));
  },
  { passive: false },
);

// ── Polygon undo ──────────────────────────────────────────────────────────────
function pushPolyUndo(imgIdx) {
  const entry = imgById(imgIdx);
  const stack = state.undoStack.get(imgIdx);
  if (!entry || !stack) return;
  stack.push({
    polygons: entry.polygons.map((p) => p.map((v) => ({ x: v.x, y: v.y }))),
    currentPoly: currentPoly.map((v) => ({ x: v.x, y: v.y })),
  });
  if (stack.length > MAX_UNDO) stack.shift();
}

function updateUndoBtn(imgIdx) {
  const stack = state.undoStack.get(imgIdx);
  btnUndo.disabled = !stack || stack.length === 0;
}

// The only door for polygon writes: local state, painter UI, sim group, and the
// shared doc (via collab:polygon-changed) stay in step no matter which path edits.
function setPolygons(imgIdx, polygons, opts = {}) {
  const entry = imgById(imgIdx);
  if (!entry) return;
  if (opts.undo) pushPolyUndo(imgIdx);
  entry.polygons = polygons;
  if (opts.clearCurrent) {
    currentPoly.length = 0;
    rubberBandPt = null;
  }
  if (imgIdx === state.rankOrder[state.paintIdx]) {
    redrawPolyOverlay(imgIdx);
    updateUndoBtn(imgIdx);
  }
  if (opts.refresh !== false) simRefreshGroup(imgIdx, opts.keepPreview === true);
  if (opts.broadcast !== false) {
    window.dispatchEvent(new CustomEvent("collab:polygon-changed", { detail: { imgIdx, polygons } }));
  }
}

btnUndo.addEventListener("click", () => {
  const imgIdx = state.rankOrder[state.paintIdx];
  const entry = imgById(imgIdx);
  const stack = state.undoStack.get(imgIdx);
  if (!stack || !stack.length) return;
  const snap = stack.pop();
  // Restore currentPoly in-place so the entry.currentPoly reference stays valid
  currentPoly.length = 0;
  snap.currentPoly.forEach((v) => currentPoly.push(v));
  rubberBandPt = currentPoly.length > 0 ? rubberBandPt : null;
  setPolygons(imgIdx, snap.polygons);
});

btnClearMask.addEventListener("click", () => {
  const imgIdx = state.rankOrder[state.paintIdx];
  const entry = imgById(imgIdx);
  if (entry.polygons.length === 0 && currentPoly.length === 0) return;
  setPolygons(imgIdx, [], { undo: true, clearCurrent: true });
});

btnPrev.addEventListener("click", () => {
  if (state.paintIdx > 0) loadPainterImage(state.paintIdx - 1);
});

btnNext.addEventListener("click", () => {
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
  workers: [], // Worker instances
  ready: [], // bool — model loaded
  busy: [], // bool — currently processing a job
  encoding: [], // imgIdx | null — which image this worker is currently encoding
  readyCount: 0,

  // Shared coordination
  yoloMode: false,
  embeddingCache: new Map(), // imgIdx → { segments, origW, origH }
  dots: new Map(), // imgIdx → dot span element (cached to avoid DOM queries)
  encodeQueue: [], // imgIdx[] awaiting dispatch
  encodeQueueBuilt: false, // true once buildEncodeQueue() has been called
  encodeRetries: new Map(), // imgIdx → failure count (reset each session)
  staleEncodeSet: new Set(), // old imgIdx values to discard in onEncoded after a remove
  initSent: new Set(), // worker indices init'd by _respawnWorkersForEncoding (skip cascade)
  decodeWorkerIdx: -1, // worker slot reserved for on-demand encoding
};

function updateYoloStatus(text, warn) {
  yoloStatus.textContent = text;
  yoloStatus.className = "im-yolo-status" + (warn ? " im-log-warn" : "");
  if (yoloMobileStatus) yoloMobileStatus.textContent = state.useYolo ? text : "";
}

function updateYoloWorkerCount() {
  const live = yoloPool.ready.filter(Boolean).length;
  const total = YOLO_WORKER_COUNT;
  yoloWorkerCountEl.textContent = total > 1 ? live + "/" + total + " workers" : "";
  yoloWorkerCountEl.className = "im-yolo-worker-count" + (live < total ? " im-log-warn" : "");
}

function initYoloPool() {
  if (yoloPool.workers.length > 0) return; // already initialised
  YOLO_WORKER_COUNT = state.yoloWorkerCount;
  yoloPool.encodeQueueBuilt = false;
  if (location.protocol === "file:") {
    updateYoloStatus("Seg requires HTTP  -  open a terminal in docs/ and run: python3 -m http.server 8080, " + "then visit http://localhost:8080/assets/pages/projects/imageMerge.html", true);
    return;
  }
  for (let i = 0; i < YOLO_WORKER_COUNT; i++) {
    const w = new Worker("yoloWorker.js?v=6");
    w.onmessage = (e) => onWorkerMsg(i, e.data);
    yoloPool.workers.push(w);
    yoloPool.ready.push(false);
    yoloPool.busy.push(false);
    yoloPool.encoding.push(null);
  }
  updateYoloStatus("Downloading YOLO model...");
  // Only start worker 0 now; the rest start after it reports ready so they
  // benefit from the browser cache the first worker populates.
  yoloPool.workers[0].postMessage({ type: "init" });
}

// Respawn dead worker slots up to YOLO_WORKER_COUNT for a new batch of images.
// Skips live slots. Each respawned worker sends its own init (model already cached).
function _respawnWorkersForEncoding() {
  if (location.protocol === "file:") return;
  for (let i = 0; i < YOLO_WORKER_COUNT; i++) {
    if (yoloPool.ready[i]) continue; // slot alive
    if (yoloPool.initSent.has(i)) continue; // already being re-initialised
    const wi = i;
    const w = new Worker("yoloWorker.js?v=6");
    w.onmessage = (e) => onWorkerMsg(wi, e.data);
    yoloPool.workers[i] = w;
    yoloPool.ready[i] = false;
    yoloPool.busy[i] = false;
    yoloPool.encoding[i] = null;
    yoloPool.initSent.add(i);
    w.postMessage({ type: "init" });
  }
}

function onWorkerMsg(wIdx, msg) {
  switch (msg.type) {
    case "ready":
      onWorkerReady(wIdx);
      break;
    case "encoded":
      onEncoded(wIdx, msg);
      break;
    case "progress":
      if (yoloPool.readyCount === 0) updateYoloStatus(msg.text);
      break;
    case "error":
      onEncodeError(wIdx, msg.message);
      break;
  }
}

function onWorkerReady(wIdx) {
  yoloPool.ready[wIdx] = true;
  yoloPool.busy[wIdx] = false;
  yoloPool.readyCount++;
  yoloPool.initSent.delete(wIdx);
  updateYoloWorkerCount();

  btnYoloToggle.disabled = false;

  // Only cascade-start remaining workers on the very first pool init (not re-spawns,
  // which already sent their own init messages and tracked them via initSent).
  if (yoloPool.readyCount === 1 && yoloPool.initSent.size === 0) {
    for (let i = 1; i < YOLO_WORKER_COUNT; i++) yoloPool.workers[i].postMessage({ type: "init" });
    if (state.images.length > 0) buildEncodeQueue();
  }

  const all = yoloPool.readyCount === YOLO_WORKER_COUNT;
  updateYoloStatus(all ? (yoloPool.yoloMode ? "Click a subject to segment" : "YOLO ready  -  toggle on then click a subject") : "YOLO loading (" + yoloPool.readyCount + "/" + YOLO_WORKER_COUNT + ")...");
  drainEncodeQueue();
}

function onEncoded(wIdx, { imgIdx, segments, origW, origH }) {
  yoloPool.busy[wIdx] = false;
  yoloPool.encoding[wIdx] = null;

  // Result from before a remove — index is stale, discard it.
  if (yoloPool.staleEncodeSet.has(imgIdx)) {
    yoloPool.staleEncodeSet.delete(imgIdx);
    drainEncodeQueue();
    return;
  }

  yoloPool.embeddingCache.set(imgIdx, { segments, origW, origH });

  markDotEncoded(imgIdx);

  if (imgIdx === state.rankOrder[state.paintIdx]) {
    updateYoloStatus(yoloPool.yoloMode ? "Click a subject to segment" : "YOLO ready");
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
      if (!keptOne) {
        keptOne = true;
        yoloPool.decodeWorkerIdx = i;
        continue;
      }
      yoloPool.workers[i].terminate();
      yoloPool.ready[i] = false;
      yoloPool.encoding[i] = null;
      yoloPool.readyCount = Math.max(0, yoloPool.readyCount - 1);
    }
    updateYoloWorkerCount();
  }
}

function onEncodeError(wIdx, message) {
  const imgIdx = yoloPool.encoding[wIdx] ?? null;
  yoloPool.encoding[wIdx] = null;
  yoloPool.busy[wIdx] = false;

  // Terminate the failed worker — frees its WASM heap (~3 GB).
  yoloPool.workers[wIdx].terminate();
  yoloPool.ready[wIdx] = false;
  yoloPool.readyCount = Math.max(0, yoloPool.readyCount - 1);
  updateYoloWorkerCount();

  if (imgIdx !== null) {
    const dot = yoloPool.dots.get(imgIdx);
    if (dot) {
      dot.classList.remove("im-yolo-encoding");
      dot.classList.add("im-yolo-pending");
      dot.title = "Pending encoding";
    }
  }

  if (imgIdx !== null && !yoloPool.embeddingCache.has(imgIdx)) {
    const attempts = (yoloPool.encodeRetries.get(imgIdx) || 0) + 1;
    yoloPool.encodeRetries.set(imgIdx, attempts);
    if (attempts <= 2) {
      // Re-queue at the front so it's picked up by the next free worker.
      yoloPool.encodeQueue.unshift(imgIdx);
      updateYoloStatus("YOLO worker failed  -  retrying with fewer workers...", true);
    } else {
      const failDot = yoloPool.dots.get(imgIdx);
      if (failDot) {
        failDot.classList.remove("im-yolo-encoding", "im-yolo-pending");
        failDot.classList.add("im-yolo-failed");
        failDot.title = "Encoding failed";
      }
      updateYoloStatus("Could not encode [" + (imgById(imgIdx)?.name ?? imgIdx) + "]  -  skipping.", true);
    }
  } else {
    // Failure during decode or init (imgIdx null) — just report it.
    updateYoloStatus("YOLO error: " + message, true);
  }

  drainEncodeQueue();
}

// Flip an image's filmstrip SAM dot to the "encoded" state (no-op if not shown).
function markDotEncoded(id) {
  const dot = yoloPool.dots.get(id);
  if (!dot) return;
  dot.classList.remove("im-yolo-encoding", "im-yolo-pending");
  dot.classList.add("im-yolo-encoded");
  dot.title = "Encoded";
}

async function sendEncode(wIdx, imgIdx) {
  yoloPool.busy[wIdx] = true;
  yoloPool.encoding[wIdx] = imgIdx;
  const dot = yoloPool.dots.get(imgIdx);
  if (dot) {
    dot.classList.remove("im-yolo-pending");
    dot.classList.add("im-yolo-encoding");
    dot.title = "Encoding...";
  }
  const entry = imgById(imgIdx);
  // The model letterboxes to 640px; decoding a photo any larger only triples
  // full-res copies (bitmap + canvas + getImageData) on the main thread.
  const cap = entry ? Math.min(1, 640 / Math.max(entry.w, entry.h)) : 1;
  const bm = await decodeEntry(entry, cap < 1 ? { resizeWidth: Math.max(1, Math.round(entry.w * cap)), resizeHeight: Math.max(1, Math.round(entry.h * cap)), resizeQuality: "high" } : undefined);
  // Image may have been removed while decoding -> free the worker slot and re-drain.
  if (!bm || !imgById(imgIdx)) {
    if (bm) bm.close();
    yoloPool.busy[wIdx] = false;
    yoloPool.encoding[wIdx] = null;
    drainEncodeQueue();
    return;
  }
  const tmp = document.createElement("canvas");
  tmp.width = bm.width;
  tmp.height = bm.height;
  const tmpCtx = tmp.getContext("2d");
  tmpCtx.drawImage(bm, 0, 0);
  bm.close();
  const id = tmpCtx.getImageData(0, 0, tmp.width, tmp.height);
  yoloPool.workers[wIdx].postMessage({ type: "encode", imgIdx, pixels: id.data.buffer, width: tmp.width, height: tmp.height }, [id.data.buffer]);
}

// Build the encode queue sorted by rank order, so highest-priority images encode first.
// Single, idempotent entry point for auto-segmentation -- call from any path
// (toggle, images added, session import/load). Starts the pool (downloading the
// model) if needed, otherwise (re)queues any un-encoded images.
function ensureYoloEncoding() {
  if (!state.useYolo || state.images.length === 0) return;
  if (yoloPool.workers.length === 0) {
    initYoloPool();
    return;
  } // queues itself when ready
  buildEncodeQueue();
  _respawnWorkersForEncoding(); // revive any slots killed after the last batch
}

function buildEncodeQueue() {
  yoloPool.encodeQueueBuilt = true;
  yoloPool.encodeRetries.clear();
  const sorted = state.images
    .map((e) => e.id)
    .sort((a, b) => {
      const ra = state.rankOrder.indexOf(a);
      const rb = state.rankOrder.indexOf(b);
      return (ra === -1 ? Infinity : ra) - (rb === -1 ? Infinity : rb);
    });
  for (const id of sorted) {
    if (yoloPool.embeddingCache.has(id)) continue;
    if (yoloPool.encodeQueue.includes(id) || yoloPool.encoding.includes(id)) continue;
    yoloPool.encodeQueue.push(id);
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
// x,y are in encode-space coordinates (origW x origH, which may be capped).
function findBestSegmentAt(segments, x, y, origW, origH) {
  const DECODE_SIZE = 512;
  const capScale = Math.min(1, DECODE_SIZE / Math.max(origH, origW));
  const outW = Math.round(origW * capScale);
  const outH = Math.round(origH * capScale);
  const mx = Math.min(outW - 1, Math.round(x * capScale));
  const my = Math.min(outH - 1, Math.round(y * capScale));

  let best = null,
    bestArea = Infinity;
  for (const seg of segments) {
    const [bx1, by1, bx2, by2] = seg.bbox;
    if (x < bx1 || x > bx2 || y < by1 || y > by2) continue;
    if (seg.mask[my * seg.maskW + mx] !== 1) continue;
    const area = (bx2 - bx1) * (by2 - by1);
    if (area < bestArea) {
      bestArea = area;
      best = seg;
    }
  }
  return best;
}

// Ray-casting point-in-polygon test.
function pointInPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y;
    const xj = poly[j].x,
      yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Handle a user click in seg mode -- instant lookup, no worker call needed.
// If the click lands inside an existing polygon, remove it instead.
function requestDecode(x, y) {
  const imgIdx = state.rankOrder[state.paintIdx];
  const entry = imgById(imgIdx);

  // Deselect: remove the first polygon that contains the click point.
  for (let i = 0; i < entry.polygons.length; i++) {
    if (pointInPoly(entry.polygons[i], x, y)) {
      setPolygons(
        imgIdx,
        entry.polygons.filter((_, j) => j !== i),
        { undo: true },
      );
      updateYoloStatus("Segment removed. Click to add or click an object to segment.");
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
    updateYoloStatus("Encoding - click the subject again when the thumbnail stops pulsing", true);
    return;
  }
  const { segments, origW, origH } = yoloPool.embeddingCache.get(imgIdx);
  // Encodings are computed at a capped resolution (origW x origH <= entry size);
  // the click arrives in image space, so map it into encode space.
  const seg = findBestSegmentAt(segments, (x * origW) / entry.w, (y * origH) / entry.h, origW, origH);
  if (!seg) {
    updateYoloStatus("No segment found  -  try clicking on a recognized object.", true);
    return;
  }
  applyMaskAsPolygon(seg.mask, seg.maskW, seg.maskH, imgIdx);
}

// Seg polygons are kept out of an edge margin (7% of width/height per axis):
// a mask running to the frame edge gives the merge nothing to blend into (hard
// cut at the border). Vertices inside the margin are simply dropped and the
// surviving neighbors connect directly -- reads more naturally than a straight
// clip line along the margin rectangle. Manual painting is untouched.
const SEG_EDGE_MARGIN_FRAC = 0.07;

function applyMaskAsPolygon(maskData, width, height, forImgIdx) {
  if (forImgIdx !== state.rankOrder[state.paintIdx]) return; // stale result
  const poly = maskToPolygon(maskData, width, height);
  if (!poly || poly.length < 3) {
    updateYoloStatus("No region found  -  try clicking a different point.", true);
    return;
  }
  const entry = imgById(forImgIdx);

  // Scale polygon from mask space back to original image space.
  const scaleX = entry.w / width;
  const scaleY = entry.h / height;
  const scaledPoly = scaleX === 1 && scaleY === 1 ? poly : poly.map((pt) => ({ x: pt.x * scaleX, y: pt.y * scaleY }));

  const mx = entry.w * SEG_EDGE_MARGIN_FRAC;
  const my = entry.h * SEG_EDGE_MARGIN_FRAC;
  const kept = scaledPoly.filter((p) => p.x >= mx && p.x <= entry.w - mx && p.y >= my && p.y <= entry.h - my);
  if (kept.length < 3) {
    updateYoloStatus("Segment lies in the edge margin - paint it manually if needed.", true);
    return;
  }

  setPolygons(forImgIdx, [...entry.polygons, kept], { undo: true });
  updateYoloStatus("Segment added. Click for another or switch to manual mode.");
}

// Convert a flat Uint8Array mask (0=bg, 1=fg) to an [{x,y}...] polygon
// via a scanline boundary walk + Ramer-Douglas-Peucker simplification.
function maskToPolygon(mask, W, H) {
  const leftPts = [];
  const rightPts = [];

  for (let y = 0; y < H; y++) {
    let lo = -1,
      hi = -1;
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
  const first = pts[0],
    last = pts[pts.length - 1];
  const dx = last.x - first.x,
    dy = last.y - first.y;
  const lenSq = dx * dx + dy * dy;
  let maxDist = 0,
    maxIdx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    let dist;
    if (lenSq === 0) {
      const ex = pts[i].x - first.x,
        ey = pts[i].y - first.y;
      dist = Math.sqrt(ex * ex + ey * ey);
    } else {
      const t = ((pts[i].x - first.x) * dx + (pts[i].y - first.y) * dy) / lenSq;
      const px = first.x + t * dx,
        py = first.y + t * dy;
      const ex = pts[i].x - px,
        ey = pts[i].y - py;
      dist = Math.sqrt(ex * ex + ey * ey);
    }
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }
  if (maxDist > eps) {
    const L = rdpSimplify(pts.slice(0, maxIdx + 1), eps);
    const R = rdpSimplify(pts.slice(maxIdx), eps);
    return L.slice(0, -1).concat(R);
  }
  return [first, last];
}

btnYoloToggle.addEventListener("click", () => {
  yoloPool.yoloMode = !yoloPool.yoloMode;
  btnYoloToggle.classList.toggle("im-yolo-active", yoloPool.yoloMode);
  btnYoloToggle.textContent = yoloPool.yoloMode ? "Seg: On" : "Seg: Off";
  if (yoloPool.yoloMode) {
    const imgIdx = state.rankOrder[state.paintIdx];
    updateYoloStatus(yoloPool.embeddingCache.has(imgIdx) ? "Click a subject to segment" : "Click a subject to begin encoding and segment");
  } else {
    updateYoloStatus("YOLO ready");
  }
});

// ── Per-image auto-scale computation ──────────────────────────────────────────
// Returns an array of { scale, wasClamped } — one entry per image.
// Images with manual scale pass through unchanged.
// Auto-scale: find the shortest output dimension (ties go to width), then check
// the image's corresponding dimension. If it exceeds the output's shortest dim,
// scale = outShortDim / imageDim ceiled to the nearest 0.05 multiple.
function computeAutoScales() {
  const useW = state.outW <= state.outH; // width is shorter (or tied)
  const shortOut = useW ? state.outW : state.outH;

  // Keyed by image id (not position) so callers can look up by id.
  const out = {};
  for (const entry of state.images) {
    if (entry.scale !== null) {
      out[entry.id] = { scale: entry.scale, wasClamped: false };
      continue;
    }
    const imgDim = useW ? entry.w : entry.h;
    if (imgDim <= shortOut) {
      out[entry.id] = { scale: 1, wasClamped: false };
      continue;
    }
    const ratio = imgDim / shortOut;
    out[entry.id] = { scale: 1 / (Math.ceil(ratio / 0.01) * 0.01), wasClamped: false };
  }
  return out;
}

// ── Merge algorithm (delegated to Web Worker) ─────────────────────────────────
let activeWorker = null;

btnCancel.addEventListener("click", cancelMerge);

btnMerge.addEventListener("click", startMerge);

function startMerge() {
  const placements = extractPlacements();
  // On a collab guest the masks arrive before the pixels; don't merge until every
  // placed image has its bytes (mergeReady is the same gate the merge button uses).
  if (!mergeReady()) {
    updateSimStatus("Still importing");
    return;
  }

  updateSimStatus("Merging\u2026");
  btnMerge.classList.add("im-hidden");
  btnCancel.classList.remove("im-hidden");
  btnDownload.classList.add("im-hidden");

  const workerImages = state.images.map((entry) => ({
    w: entry.w,
    h: entry.h,
    name: entry.name,
    polygons: entry.polygons.map((p) => p.map((v) => ({ x: v.x, y: v.y }))),
  }));

  activeWorker = new Worker(new URL("mergeWorker.js?v=2", location.href));

  function cleanupWorker() {
    activeWorker.terminate();
    activeWorker = null;
  }

  activeWorker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === "done") {
      cleanupWorker();
      simLastOwnership = msg.ownership;
      updateSimStatus("Rendering...");
      _renderPixels(msg.placements, msg.ownership, 0.25)
        .then(({ pixels, PW, PH }) => _applyMergePreview(pixels, PW, PH, msg.placements))
        .catch((err) => {
          updateSimStatus("Render error: " + err.message);
          resetMergeUI();
        });
    } else if (msg.type === "progress") {
      updateSimStatus("Merging... " + msg.pct + "%");
    } else if (msg.type === "chamfer-req") {
      _runChamferJob(msg.id, msg.mask, msg.W, msg.H);
    } else if (msg.type === "error") {
      cleanupWorker();
      updateSimStatus("Worker error: " + msg.text);
      resetMergeUI();
    }
  };

  activeWorker.onerror = (err) => {
    cleanupWorker();
    updateSimStatus("Worker error: " + err.message);
    resetMergeUI();
  };

  activeWorker.postMessage({
    precomputedPlacements: placements,
    images: workerImages,
    outW: state.outW,
    outH: state.outH,
    blendMode: cfgBlendMode.value,
    seed: parseInt(cfgSeed.value, 10) || 0,
    ditherExp: parseInt(cfgDitherExp.value, 10) || 4,
  });
}

// Run a chamfer job the merge worker delegated out (it can't nest workers on
// Firefox). Worker-per-job is fine: the merge worker caps in-flight jobs at 8.
let _chamferWorkerUrl = null;
function _runChamferJob(id, maskBuf, W, H) {
  if (!_chamferWorkerUrl) _chamferWorkerUrl = new URL("chamferWorker.js?v=1", location.href).href;
  const w = new Worker(_chamferWorkerUrl);
  w.onmessage = (ev) => {
    w.terminate();
    if (activeWorker) activeWorker.postMessage({ type: "chamfer-res", id, dist: ev.data }, [ev.data]);
  };
  w.onerror = () => {
    w.terminate();
    if (activeWorker) activeWorker.postMessage({ type: "chamfer-res", id, dist: null });
  };
  w.postMessage({ mask: maskBuf, W, H }, [maskBuf]);
}

function cancelMerge() {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
    updateSimStatus("Merge cancelled.");
  }
  resetMergeUI();
}

function resetMergeUI() {
  btnCancel.classList.add("im-hidden");
  btnDownload.classList.add("im-hidden");
  _showMergeBtn();
  simMergedImageData = null;
}

// Merge needs every placed (visible, masked) image's pixels. On a collab guest or a
// fresh import the masks render before the images stream in, so gate the button on
// readiness rather than offering a merge that can't run yet.
function mergeReady() {
  if (simRafId === null) return false;
  // Every image must have finished transferring -- not just the placed/masked ones -- so a
  // merge can't run against a session that is still syncing in.
  if (state.images.length === 0 || !state.images.every((e) => e.blob)) return false;
  const placed = state.rankOrder.filter((id) => {
    const e = imgById(id);
    return e && !e.simHidden && e.polygons && e.polygons.length > 0;
  });
  return placed.length > 0 && placed.every((id) => imgById(id).blob);
}
function _showMergeBtn() {
  btnMerge.classList.toggle("im-hidden", !mergeReady());
}

// ── Mask placement canvas (pan / zoom / drag; no physics) ─────────────────────
let simGroups = new Map(); // id -> sim group (only images that have polygons)
let simRafId = null;
let _lastSimTs = null;
let simMergedImageData = null; // truthy when merge complete; cleared when sim re-activates
let _simViewDirty = true;
let simLastPlacements = null; // placements from last merge — used for mask overlay + download
let simLastOwnership = null; // ownership from last merge -- reused for full-res download
let _activePixelWorker = null; // running pixel-render worker (preview or download)
let _pixelWorkerBlobUrl = null; // cached blob URL for the pixel render worker
let simCornerDrag = null; // { dir, id, startPx, startX1, startY1, startX2, startY2 }
let simBodyDragging = false; // true while a body is being dragged
let pinchPreview = null; // { imgIdx, scale } drawn live during pinch gesture
let _activeDragIdx = null; // id currently being dragged locally; null if none
let _lastDragBroadcast = 0; // timestamp of last collab:body-dragging dispatch
const _remoteGrabs = new Map(); // imgIdx -> { color } for bodies grabbed by peers
const _remoteScalePreview = new Map(); // imgIdx -> scale, live (render-only) while a peer scales
const WORLD_SPAN = 10000; // world units spanned by the canvas at zoom 1 (base px/unit scale)
let simX1 = 0; // output rect TL x in world space
let simY1 = 0; // output rect TL y in world space
let simX2 = 0; // output rect BR x in world space
let simY2 = 0; // output rect BR y in world space
let _simOutExplicit = false; // set when corners are set by remote; suppresses resizeSim re-center
let mergeCanvas = null; // offscreen preview-res canvas shown in sim view
let mergeX1 = 0; // simX1 at the time of the last merge
let mergeY1 = 0; // simY1 at the time of the last merge
// ── Sim viewport ────────────────────────────────────────────────────────────────
// Zoom/pan/transforms/animation/presenter live in viewport.js (loaded first).
// Wire it to this module's sim state — it owns scale/offset/dispScale; the rest
// (canvas, dirty flag, artboard rect, sim groups) is injected here.
viewport.init({
  canvas: simCanvas,
  markDirty: () => {
    _simViewDirty = true;
  },
  getArtboard: () => ({ x1: simX1, y1: simY1, x2: simX2, y2: simY2 }),
  getGroup: (id) => simGroups.get(id) || null,
});

// RDP simplification (mirrored from merge worker for main-thread use)
function rdpSimplify(pts, eps) {
  if (pts.length <= 2) return pts.slice();
  const first = pts[0],
    last = pts[pts.length - 1];
  const dx = last.x - first.x,
    dy = last.y - first.y;
  const lenSq = dx * dx + dy * dy;
  let maxDist = 0,
    maxIdx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    let dist;
    if (lenSq === 0) {
      const ex = pts[i].x - first.x,
        ey = pts[i].y - first.y;
      dist = Math.sqrt(ex * ex + ey * ey);
    } else {
      const t = ((pts[i].x - first.x) * dx + (pts[i].y - first.y) * dy) / lenSq;
      const px = first.x + t * dx,
        py = first.y + t * dy;
      const ex = pts[i].x - px,
        ey = pts[i].y - py;
      dist = Math.sqrt(ex * ex + ey * ey);
    }
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
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
  const s = [...pts].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  function cr(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }
  const lo = [],
    hi = [];
  for (const p of s) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop();
    hi.push(p);
  }
  hi.pop();
  lo.pop();
  return lo.concat(hi);
}

function buildSimGroup(imgIdx) {
  const entry = imgById(imgIdx);
  const scale = computeAutoScales()[imgIdx].scale;
  const N = state.images.length;
  const colorIdx = imgIdxById(imgIdx); // position-based hue (cosmetic)
  const eps = Math.max(1, 2 * scale);

  const polys = [];
  for (const poly of entry.polygons) {
    const verts = poly.map((v) => ({ x: v.x * scale, y: v.y * scale }));
    const simp = rdpSimplify(verts, eps);
    if (simp.length < 3) continue;
    polys.push(simp);
  }
  if (polys.length === 0) return null;

  // Centroid of all polygon vertices combined
  let cx = 0,
    cy = 0,
    cnt = 0;
  for (const poly of polys) {
    for (const v of poly) {
      cx += v.x;
      cy += v.y;
      cnt++;
    }
  }
  cx /= cnt;
  cy /= cnt;

  return {
    imgIdx,
    x: 0,
    y: 0,
    angle: 0,
    scale,
    imgCentroidSim: { x: cx, y: cy },
    polysInSim: polys,
    color: `hsl(${Math.round((colorIdx * 360) / Math.max(N, 1))}, 70%, 55%)`,
    inWorld: false,
  };
}

// canvasToWorld / clientToCanvasPx now live on the viewport (viewport.js).

function getCornerHandlePositions() {
  const ts = viewport.totalScale;
  return [
    { dir: "nw", cx: (simX1 - viewport.offsetX) * ts, cy: (simY1 - viewport.offsetY) * ts },
    { dir: "ne", cx: (simX2 - viewport.offsetX) * ts, cy: (simY1 - viewport.offsetY) * ts },
    { dir: "sw", cx: (simX1 - viewport.offsetX) * ts, cy: (simY2 - viewport.offsetY) * ts },
    { dir: "se", cx: (simX2 - viewport.offsetX) * ts, cy: (simY2 - viewport.offsetY) * ts },
  ];
}

// expandPhys: expand each polygon's vertices outward from its centroid (world units)
function _physPointInGroup(phys, g, expandPhys = 0) {
  const dx = phys.x - g.x,
    dy = phys.y - g.y;
  const cos = Math.cos(g.angle),
    sin = Math.sin(g.angle);
  const lx = dx * cos + dy * sin + g.imgCentroidSim.x;
  const ly = -dx * sin + dy * cos + g.imgCentroidSim.y;
  for (const poly of g.polysInSim) {
    let testPoly = poly;
    if (expandPhys > 0) {
      let pcx = 0,
        pcy = 0;
      for (const v of poly) {
        pcx += v.x;
        pcy += v.y;
      }
      pcx /= poly.length;
      pcy /= poly.length;
      testPoly = poly.map((v) => {
        const ex = v.x - pcx,
          ey = v.y - pcy;
        const len = Math.hypot(ex, ey) || 1;
        return { x: pcx + (ex * (len + expandPhys)) / len, y: pcy + (ey * (len + expandPhys)) / len };
      });
    }
    if (pointInPoly(testPoly, lx, ly)) return true;
  }
  return false;
}

// touchTolCssPx: tolerance in CSS pixels expanding the polygon hit zone (0 = exact)
function nearestGroup(phys, touchTolCssPx = 0) {
  const expandPhys = touchTolCssPx > 0 ? touchTolCssPx / viewport.totalScale : 0;
  let best = null,
    bestD = Infinity;
  for (const g of simGroups.values()) {
    if (!g.inWorld) continue;
    if (_physPointInGroup(phys, g, expandPhys)) {
      const d = Math.hypot(g.x - phys.x, g.y - phys.y);
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
  }
  return best;
}

function nearestCornerHandle(canvasPx) {
  if (simRafId === null) return null;
  const rect = simCanvas.getBoundingClientRect();
  const hitR = (simCanvas.width / rect.width) * 36; // 36 css px in canvas px
  let best = null,
    bestD = Infinity;
  for (const h of getCornerHandlePositions()) {
    const d = Math.hypot(canvasPx.x - h.cx, canvasPx.y - h.cy);
    if (d < hitR && d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

function drawCornerHandles() {
  if (simRafId === null) return;
  const ctx = simCtx;
  const ts = viewport.totalScale;
  const handles = getCornerHandlePositions();

  ctx.save();

  if (simCornerDrag) {
    // Ghost showing the original rect before drag started
    const ox1 = (simCornerDrag.startX1 - viewport.offsetX) * ts;
    const oy1 = (simCornerDrag.startY1 - viewport.offsetY) * ts;
    const ox2 = (simCornerDrag.startX2 - viewport.offsetX) * ts;
    const oy2 = (simCornerDrag.startY2 - viewport.offsetY) * ts;
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(ox1, oy1, ox2 - ox1, oy2 - oy1);
    ctx.setLineDash([]);

    // Dashed preview rect showing the new output boundary
    ctx.strokeStyle = "rgba(0,255,127,0.5)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    const nw = handles[0],
      se = handles[3];
    ctx.strokeRect(nw.cx, nw.cy, se.cx - nw.cx, se.cy - nw.cy);
    ctx.setLineDash([]);
    // Size label
    ctx.fillStyle = "springgreen";
    ctx.font = "bold 17px monospace";
    ctx.textAlign = "center";
    const lblY = handles[2].cy + 20 < simCanvas.height - 6 ? handles[2].cy + 20 : handles[0].cy - 8;
    ctx.fillText(state.outW + " \xd7 " + state.outH, simCanvas.width / 2, lblY);
  }

  const ARM = 14;
  ctx.strokeStyle = "springgreen";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.globalAlpha = simCornerDrag ? 1.0 : 0.7;
  for (const h of handles) {
    const sx = h.dir === "ne" || h.dir === "se" ? 1 : -1;
    const sy = h.dir === "sw" || h.dir === "se" ? 1 : -1;
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
  const ts = viewport.totalScale;
  const dx = (canvasPx.x - simCornerDrag.startPx.x) / ts;
  const dy = (canvasPx.y - simCornerDrag.startPx.y) / ts;
  const dir = simCornerDrag.dir;

  let x1 = simCornerDrag.startX1,
    y1 = simCornerDrag.startY1;
  let x2 = simCornerDrag.startX2,
    y2 = simCornerDrag.startY2;

  if (dir === "nw" || dir === "sw") x1 = Math.min(x1 + dx, x2 - 200);
  if (dir === "ne" || dir === "se") x2 = Math.max(x2 + dx, x1 + 200);
  if (dir === "nw" || dir === "ne") y1 = Math.min(y1 + dy, y2 - 200);
  if (dir === "sw" || dir === "se") y2 = Math.max(y2 + dy, y1 + 200);

  simX1 = x1;
  simY1 = y1;
  simX2 = x2;
  simY2 = y2;
  state.outW = Math.round(x2 - x1);
  state.outH = Math.round(y2 - y1);
  cfgWidth.value = state.outW;
  cfgHeight.value = state.outH;
  _syncCarouselUI();
  _simViewDirty = true;
  _broadcastSettingsNow();
}

function finishCornerResize() {
  // Resize changes only the bounds (auto-scale re-derives; positions preserved).
  recordSimUndo({
    groups: [],
    bounds: {
      x1: simCornerDrag.startX1,
      y1: simCornerDrag.startY1,
      x2: simCornerDrag.startX2,
      y2: simCornerDrag.startY2,
    },
  });
  if (simRafId !== null) resizeSim();
  simCornerDrag = null;
  _broadcastSettings();
  window.dispatchEvent(new CustomEvent("collab:canvas-resized"));
}

function initSim(savedPositions = null) {
  teardownSim();

  const W = state.outW,
    H = state.outH;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvasW = Math.round(window.innerWidth * dpr);
  const canvasH = Math.round(window.innerHeight * dpr);
  simCanvas.width = canvasW;
  simCanvas.height = canvasH;
  simMergedImageData = null;
  mergeCanvas = null;

  simX1 = 0;
  simY1 = 0;
  simX2 = state.outW;
  simY2 = state.outH;

  const dispScale = Math.min(canvasW / WORLD_SPAN, canvasH / WORLD_SPAN);
  viewport.setDispScale(dispScale);
  const fitTotal = Math.min(canvasW / state.outW, canvasH / state.outH) * 0.82;
  const initScale = Math.max(0.1, Math.min(10, fitTotal / dispScale));
  viewport._cancelAnim(); // a fresh sim init drops any pending tween / presenter-follow
  viewport._set(initScale, (simX1 + simX2) / 2 - canvasW / 2 / (dispScale * initScale), (simY1 + simY2) / 2 - canvasH / 2 / (dispScale * initScale));

  simGroups = new Map();
  for (const entry of state.images) {
    const g = buildSimGroup(entry.id);
    if (g) simGroups.set(entry.id, g);
  }

  const active = [...simGroups.values()].filter((g) => !imgById(g.imgIdx).simHidden);
  active.forEach((g, rank) => {
    const saved = savedPositions && savedPositions[g.imgIdx];
    const pos = saved ? saved.pos : simGridPos(rank, active.length, W, H);
    g.x = pos.x;
    g.y = pos.y;
    g.angle = saved ? saved.angle : 0;
    g.inWorld = true;
  });

  _lastSimTs = null;
  _simViewDirty = true;
  simRafId = requestAnimationFrame(simTick);
  if (active.length > 0) _showMergeBtn();
}

function placeGroup(g, x, y, angle) {
  g.x = x;
  g.y = y;
  g.angle = angle;
  _simViewDirty = true;
}

let _liftSnap = null;
function dispatchBodyLift(g) {
  // Stash this image's pre-drag transform (incl. scale) for a scoped undo entry.
  _liftSnap = captureSimSnapshot([g.imgIdx], false);
  window.dispatchEvent(
    new CustomEvent("collab:body-lift", {
      detail: { imgIdx: g.imgIdx, prevX: g.x, prevY: g.y, prevAngle: g.angle },
    }),
  );
}

function dispatchBodyMoved(g) {
  if (_liftSnap) {
    recordSimUndo(_liftSnap);
    _liftSnap = null;
  }
  window.dispatchEvent(
    new CustomEvent("collab:body-moved", {
      detail: { imgIdx: g.imgIdx, x: g.x, y: g.y, angle: g.angle },
    }),
  );
}

// ── Multi-select + move-together ──────────────────────────────────────────────
// A selection is a set of image ids. Selected masks get a highlight outline and a
// shared dashed box; dragging any member translates the whole set as one (translate
// only). Desktop builds selections with shift/cmd-click + marquee + Ctrl/Cmd+A;
// mobile uses a tap-to-toggle select mode (the btn-sim-select FAB toggle). The move
// reuses the multi-image undo snapshot and the {id:pos} positions broadcast, so a
// group move is one undo entry and syncs to peers like a single drag.
const SEL_COLOR = "#38bdf8";
let selectedIds = new Set();
let selectMode = false; // mobile: tap-to-toggle selection
let _groupMove = null; // { ids, snap, start:Map(id->{x,y}), origin:{x,y}, pointerId }
let _marquee = null; // desktop drag-select rect, world coords
let _pan = null; // viewport pan drag (middle-mouse or Space+left)
let _spaceDown = false; // Space held -> left-drag pans the canvas

function setSelection(ids) {
  selectedIds = new Set([...ids].filter((id) => simGroups.has(id)));
  _simViewDirty = true;
  _updateSelectionUI();
}
function clearSelection() {
  if (selectedIds.size === 0) return;
  selectedIds.clear();
  _simViewDirty = true;
  _updateSelectionUI();
}
function toggleSelect(id) {
  if (!simGroups.has(id)) return;
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  _simViewDirty = true;
  _updateSelectionUI();
}
function _updateSelectionUI() {
  if (!simSelBadge) return;
  simSelBadge.textContent = selectedIds.size;
  simSelBadge.classList.toggle("im-hidden", selectedIds.size === 0);
}
function setSelectMode(on) {
  selectMode = on;
  // The cyan active state + count badge are the only signal -- no status text
  // (the HUD pill is tight on narrow phones; a title tooltip never fires on touch).
  if (btnSimSelect) btnSimSelect.classList.toggle("is-active", on);
  if (!on) clearSelection();
}

function groupPositions(ids) {
  const positions = {};
  for (const id of ids) {
    const g = simGroups.get(id);
    if (g) positions[id] = { x: g.x, y: g.y, angle: g.angle };
  }
  return positions;
}

function beginGroupMove(ids, origin, pointerId) {
  const arr = ids.filter((id) => simGroups.has(id) && !_remoteGrabs.has(id));
  if (arr.length === 0) return false;
  const start = new Map();
  for (const id of arr) {
    const g = simGroups.get(id);
    start.set(id, { x: g.x, y: g.y });
  }
  _groupMove = { ids: arr, snap: captureSimSnapshot(arr, false), start, origin, pointerId };
  simBodyDragging = true;
  _clearMergedImage();
  for (const id of arr) window.dispatchEvent(new CustomEvent("collab:body-grabbing", { detail: { imgIdx: id } }));
  return true;
}
function updateGroupMove(phys) {
  if (!_groupMove) return;
  const dx = phys.x - _groupMove.origin.x;
  const dy = phys.y - _groupMove.origin.y;
  for (const id of _groupMove.ids) {
    const g = simGroups.get(id);
    if (!g) continue;
    const s = _groupMove.start.get(id);
    g.x = s.x + dx;
    g.y = s.y + dy;
  }
  _simViewDirty = true;
}
function endGroupMove() {
  if (!_groupMove) return;
  recordSimUndo(_groupMove.snap);
  const positions = groupPositions(_groupMove.ids);
  for (const id of _groupMove.ids) {
    window.dispatchEvent(new CustomEvent("collab:body-releasing", { detail: { imgIdx: id } }));
  }
  window.dispatchEvent(new CustomEvent("collab:bodies-moved", { detail: { positions } }));
  _groupMove = null;
  simBodyDragging = false;
}

window.getSelectedIds = () => [...selectedIds];
window.setSimSelectMode = setSelectMode;

if (btnSimSelect) btnSimSelect.addEventListener("click", () => setSelectMode(!selectMode));

function teardownSim() {
  if (simRafId !== null) {
    cancelAnimationFrame(simRafId);
    simRafId = null;
  }
  simGroups = new Map();
  simBodyDragging = false;
  _lastSimTs = null;
  selectMode = false;
  if (btnSimSelect) btnSimSelect.classList.remove("is-active");
  clearSelection();
  btnMerge.classList.add("im-hidden");
  btnDownload.classList.add("im-hidden");
}

function simGridPos(rank, n, W, H) {
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * W) / H)));
  const cw = W / cols,
    ch = H / Math.ceil(n / cols);
  return { x: simX1 + ((rank % cols) + 0.5) * cw, y: simY1 + (Math.floor(rank / cols) + 0.5) * ch };
}

function simTick(ts) {
  simRafId = requestAnimationFrame(simTick);
  const dt = _lastSimTs ? Math.min(ts - _lastSimTs, 50) : 16.67;
  _lastSimTs = ts;

  viewport.stepAnim(ts); // advance any view tween / presenter-follow
  _updateRecenterUI();

  if (_activeDragIdx !== null) {
    const now = performance.now();
    if (now - _lastDragBroadcast > 33) {
      const dg = simGroups.get(_activeDragIdx);
      if (dg) {
        const detail = { imgIdx: _activeDragIdx, x: dg.x, y: dg.y, angle: dg.angle };
        // Carry the in-progress scale so peers can preview it live (like rotation).
        if (pinchPreview && pinchPreview.imgIdx === _activeDragIdx) detail.scale = pinchPreview.scale;
        window.dispatchEvent(new CustomEvent("collab:body-dragging", { detail }));
      }
      _lastDragBroadcast = now;
    }
  }

  if (_groupMove) {
    const now = performance.now();
    if (now - _lastDragBroadcast > 33) {
      window.dispatchEvent(new CustomEvent("collab:bodies-dragging", { detail: { positions: groupPositions(_groupMove.ids) } }));
      _lastDragBroadcast = now;
    }
  }

  if (simBodyDragging || simCornerDrag || pinchPreview) _simViewDirty = true;

  if (_simViewDirty) {
    _simViewDirty = false;
    drawSim();
    drawCornerHandles();
  }
}

function drawSim() {
  const ctx = simCtx;
  const DW = simCanvas.width,
    DH = simCanvas.height;
  ctx.clearRect(0, 0, DW, DH);
  ctx.fillStyle = "#1a1b1c";
  ctx.fillRect(0, 0, DW, DH);

  ctx.save();
  ctx.scale(viewport.totalScale, viewport.totalScale);
  ctx.translate(-viewport.offsetX, -viewport.offsetY);

  const W = state.outW;
  const H = state.outH;

  const totalScale = viewport.totalScale;
  const px = 1 / totalScale; // 1 screen pixel in world units
  const vx0 = viewport.offsetX;
  const vy0 = viewport.offsetY;
  const vx1 = vx0 + DW / totalScale;
  const vy1 = vy0 + DH / totalScale;
  const visW = vx1 - vx0;
  const rawStep = visW / 8;
  const gridStep = Math.pow(2, Math.round(Math.log2(rawStep)));
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = px;
  ctx.beginPath();
  const gx0 = Math.floor(vx0 / gridStep) * gridStep;
  const gy0 = Math.floor(vy0 / gridStep) * gridStep;
  for (let x = gx0; x <= vx1; x += gridStep) {
    ctx.moveTo(x, vy0);
    ctx.lineTo(x, vy1);
  }
  for (let y = gy0; y <= vy1; y += gridStep) {
    ctx.moveTo(vx0, y);
    ctx.lineTo(vx1, y);
  }
  ctx.stroke();
  ctx.font = `${Math.round(18 / totalScale)}px sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  for (let x = gx0; x <= vx1; x += gridStep) if (x !== 0) ctx.fillText(x, x + 4 * px, vy0 + 4 * px);
  for (let y = gy0; y <= vy1; y += gridStep) if (y !== 0) ctx.fillText(y, vx0 + 8 * px, y + 4 * px);

  // Merged preview: baked composite as a backdrop; live masks render over it
  // below, so peer moves stay visible without dropping the preview.
  if (mergeCanvas) ctx.drawImage(mergeCanvas, mergeX1, mergeY1, W, H);

  ctx.strokeStyle = "#555";
  ctx.lineWidth = px;
  ctx.strokeRect(simX1, simY1, W, H);

  const fontSize = Math.round(12 / totalScale);
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = "center";

  for (const g of simGroups.values()) {
    if (!g.inWorld) continue;
    const bx = g.x;
    const by = g.y;
    const ang = g.angle;
    const cos = Math.cos(ang),
      sin = Math.sin(ang);

    // Live scale factor during pinch gesture for this body
    let pp = pinchPreview && pinchPreview.imgIdx === g.imgIdx ? pinchPreview : null;
    if (!pp && _remoteScalePreview.has(g.imgIdx)) pp = { imgIdx: g.imgIdx, scale: _remoteScalePreview.get(g.imgIdx) };
    const scaleFactor = pp ? pp.scale / g.scale : 1;

    for (const poly of g.polysInSim) {
      ctx.beginPath();
      for (let i = 0; i < poly.length; i++) {
        const lx = (poly[i].x - g.imgCentroidSim.x) * scaleFactor;
        const ly = (poly[i].y - g.imgCentroidSim.y) * scaleFactor;
        const rx = bx + lx * cos - ly * sin;
        const ry = by + lx * sin + ly * cos;
        if (i === 0) ctx.moveTo(rx, ry);
        else ctx.lineTo(rx, ry);
      }
      ctx.closePath();
      ctx.globalAlpha = pp ? 0.6 : 0.4;
      ctx.fillStyle = g.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pp ? "springgreen" : g.color;
      ctx.lineWidth = (pp ? 2.5 : 1.5) / totalScale;
      ctx.stroke();
    }

    // Faint dashed rectangle showing full image bounds (rotation-aware)
    const entry = imgById(g.imgIdx);
    const drawScale = g.scale * scaleFactor;
    const imgCorners = [
      { x: 0, y: 0 },
      { x: entry.w, y: 0 },
      { x: entry.w, y: entry.h },
      { x: 0, y: entry.h },
    ].map((c) => {
      const lx = c.x * drawScale - g.imgCentroidSim.x * scaleFactor;
      const ly = c.y * drawScale - g.imgCentroidSim.y * scaleFactor;
      return { x: bx + lx * cos - ly * sin, y: by + lx * sin + ly * cos };
    });
    ctx.beginPath();
    ctx.moveTo(imgCorners[0].x, imgCorners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(imgCorners[i].x, imgCorners[i].y);
    ctx.closePath();
    ctx.globalAlpha = pp ? 0.45 : 0.18;
    ctx.strokeStyle = pp ? "springgreen" : g.color;
    ctx.lineWidth = 1 / totalScale;
    ctx.setLineDash([4 / totalScale, 4 / totalScale]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    ctx.globalAlpha = 0.85;
    ctx.fillStyle = pp ? "springgreen" : g.color;
    const label = pp ? entry.name.replace(/\.[^.]+$/, "") + "  " + pp.scale.toFixed(2) + "\xd7" : entry.name.replace(/\.[^.]+$/, "");
    ctx.fillText(label, bx, by + fontSize / 3);
    ctx.globalAlpha = 1;
  }

  _drawSelection(ctx, totalScale);
  _drawMarquee(ctx, totalScale);
  _drawRemoteGrabs(ctx, totalScale);

  ctx.restore();
}

// Highlight outline on each selected mask plus a dashed box around the whole set.
function _drawSelection(ctx, totalScale) {
  if (selectedIds.size === 0) return;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  ctx.strokeStyle = SEL_COLOR;
  ctx.lineWidth = 2.5 / totalScale;
  for (const id of selectedIds) {
    const g = simGroups.get(id);
    if (!g || !g.inWorld) continue;
    const cos = Math.cos(g.angle),
      sin = Math.sin(g.angle);
    for (const poly of g.polysInSim) {
      ctx.beginPath();
      for (let i = 0; i < poly.length; i++) {
        const lx = poly[i].x - g.imgCentroidSim.x;
        const ly = poly[i].y - g.imgCentroidSim.y;
        const rx = g.x + lx * cos - ly * sin;
        const ry = g.y + lx * sin + ly * cos;
        if (i === 0) ctx.moveTo(rx, ry);
        else ctx.lineTo(rx, ry);
        if (rx < minX) minX = rx;
        if (rx > maxX) maxX = rx;
        if (ry < minY) minY = ry;
        if (ry > maxY) maxY = ry;
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  if (minX === Infinity) return;
  const pad = 8 / totalScale;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.5 / totalScale;
  ctx.setLineDash([6 / totalScale, 4 / totalScale]);
  ctx.strokeRect(minX - pad, minY - pad, maxX - minX + 2 * pad, maxY - minY + 2 * pad);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function _drawMarquee(ctx, totalScale) {
  if (!_marquee || !_marquee.moved) return;
  const x = Math.min(_marquee.x0, _marquee.x1),
    y = Math.min(_marquee.y0, _marquee.y1);
  const w = Math.abs(_marquee.x1 - _marquee.x0),
    h = Math.abs(_marquee.y1 - _marquee.y0);
  ctx.fillStyle = "rgba(56,189,248,0.12)";
  ctx.strokeStyle = SEL_COLOR;
  ctx.lineWidth = 1 / totalScale;
  ctx.setLineDash([5 / totalScale, 4 / totalScale]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
}

// Masks peers are currently moving: the mask outline plus a dashed border in the
// peer's colour. Drawn in drawSim, or over the merged preview so a peer's edits
// stay visible without dropping the local user's preview.
function _drawRemoteGrabs(ctx, totalScale) {
  for (const [imgIdx, { color }] of _remoteGrabs) {
    const g = simGroups.get(imgIdx);
    if (!g || !g.inWorld) continue;
    const entry = imgById(imgIdx);
    if (!entry) continue;
    const bx = g.x,
      by = g.y,
      ang = g.angle;
    const cos = Math.cos(ang),
      sin = Math.sin(ang);
    const sf = _remoteScalePreview.has(imgIdx) ? _remoteScalePreview.get(imgIdx) / g.scale : 1;

    for (const poly of g.polysInSim) {
      ctx.beginPath();
      for (let i = 0; i < poly.length; i++) {
        const lx = (poly[i].x - g.imgCentroidSim.x) * sf;
        const ly = (poly[i].y - g.imgCentroidSim.y) * sf;
        const rx = bx + lx * cos - ly * sin,
          ry = by + lx * sin + ly * cos;
        if (i === 0) ctx.moveTo(rx, ry);
        else ctx.lineTo(rx, ry);
      }
      ctx.closePath();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = g.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = g.color;
      ctx.lineWidth = 1.5 / totalScale;
      ctx.stroke();
    }

    const corners = [
      { x: 0, y: 0 },
      { x: entry.w, y: 0 },
      { x: entry.w, y: entry.h },
      { x: 0, y: entry.h },
    ].map((c) => {
      const lx = (c.x * g.scale - g.imgCentroidSim.x) * sf;
      const ly = (c.y * g.scale - g.imgCentroidSim.y) * sf;
      return { x: bx + lx * cos - ly * sin, y: by + lx * sin + ly * cos };
    });
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5 / totalScale;
    ctx.setLineDash([6 / totalScale, 4 / totalScale]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
}

function updateSimStatus(text) {
  simStatusEl.textContent = text;
}

function _clearMergedImage() {
  simMergedImageData = null;
  simLastPlacements = null;
  simLastOwnership = null;
  mergeCanvas = null;
  if (_activePixelWorker) {
    _activePixelWorker.terminate();
    _activePixelWorker = null;
  }
  btnDownload.classList.add("im-hidden");
  _showMergeBtn();
  _simViewDirty = true;
}

function extractPlacements() {
  const autoScales = computeAutoScales();
  // The merge worker is positional: `imgIdx` here is the index into state.images
  // (== the worker's `images` array), not the stable id.
  return state.rankOrder
    .filter((id) => !imgById(id).simHidden)
    .map((id) => {
      const entry = imgById(id);
      const scale = autoScales[id].scale;
      const g = simGroups.get(id);
      const imgIdx = imgIdxById(id);
      if (!g) {
        return {
          imgIdx,
          x: Math.round((state.outW - entry.w * scale) / 2),
          y: Math.round((state.outH - entry.h * scale) / 2),
          scale,
          angle: 0,
          pivotX: state.outW / 2,
          pivotY: state.outH / 2,
          imgCentroidX: (entry.w * scale) / 2,
          imgCentroidY: (entry.h * scale) / 2,
        };
      }
      return {
        imgIdx,
        x: Math.round(g.x - g.imgCentroidSim.x - simX1),
        y: Math.round(g.y - g.imgCentroidSim.y - simY1),
        scale,
        angle: g.angle,
        pivotX: g.x - simX1,
        pivotY: g.y - simY1,
        imgCentroidX: g.imgCentroidSim.x,
        imgCentroidY: g.imgCentroidSim.y,
      };
    });
}

btnSimReset.addEventListener("click", () => {
  if (simRafId === null) return;
  // Reset moves every placed group -> snapshot them all (scope = all groups).
  recordSimUndo(
    captureSimSnapshot(
      [...simGroups.values()].map((g) => g.imgIdx),
      false,
    ),
  );
  const W = state.outW,
    H = state.outH;
  const active = [...simGroups.values()].filter((g) => !imgById(g.imgIdx).simHidden);
  active.forEach((g, rank) => {
    const pos = simGridPos(rank, active.length, W, H);
    g.x = pos.x;
    g.y = pos.y;
    g.angle = 0;
  });
  _clearMergedImage();
  _simViewDirty = true;
  window.dispatchEvent(new CustomEvent("collab:canvas-resized"));
});

const cfgScaleAll = document.getElementById("cfg-scale-all");
const cfgScaleAllVal = document.getElementById("cfg-scale-all-val");
const btnScaleAll = document.getElementById("btn-scale-all");

cfgScaleAll.addEventListener("input", () => {
  cfgScaleAllVal.textContent = parseFloat(cfgScaleAll.value).toFixed(2) + "x";
});

btnScaleAll.addEventListener("click", () => {
  const factor = parseFloat(cfgScaleAll.value);
  if (!factor || factor === 1) return;
  const autoScales = computeAutoScales();
  const next = {};
  for (const entry of state.images) {
    if (entry.simHidden) continue;
    const base = entry.scale !== null ? entry.scale : autoScales[entry.id].scale;
    next[entry.id] = Math.max(0.05, base * factor);
  }
  cfgScaleAll.value = "1";
  cfgScaleAllVal.textContent = "1.00x";
  setScales(next, { refresh: false }); // refreshAllSimGroups below rebuilds once
  buildRankList();
  if (simRafId !== null) {
    // Re-scale each mask in place. Do NOT initSim here: it resets the output rect
    // to the origin and re-fits the viewport, which teleports the masks out of an
    // imported (off-origin) output shape.
    refreshAllSimGroups();
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
      recordSimUndo({ groups: [], bounds: { x1: pre.x1, y1: pre.y1, x2: pre.x2, y2: pre.y2 } });
    }
    _broadcastSettings();
    window.dispatchEvent(new CustomEvent("collab:canvas-resized"));
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
  // Output dimensions changed — auto-scale may differ, so imgCentroidSim is stale.
  // Rebuild all existing groups preserving their current positions.
  refreshAllSimGroups();
}

// Rebuild every group in place (new scale, same position) and repaint. Used after a
// global rescale / output resize where the rect must NOT move (unlike initSim).
function refreshAllSimGroups() {
  for (const id of [...simGroups.keys()]) simRefreshGroup(id);
  _simViewDirty = true;
}

function simRefreshGroup(imgIdx, keepMerged = false) {
  const entry = imgById(imgIdx);
  const hasPolys = entry && entry.polygons.length > 0;

  if (simRafId === null) {
    if (hasPolys) initSim();
    return;
  }

  const old = simGroups.get(imgIdx) || null;
  simGroups.delete(imgIdx);

  if (!hasPolys) {
    // Last polygon removed -> the group is gone. Repaint the sim without it (and drop any
    // stale baked composite); _clearMergedImage sets _simViewDirty + refreshes the merge
    // button. Without this the canvas keeps showing the mask until the next pan/zoom.
    if (old) _clearMergedImage();
    return;
  }

  // Local edits drop the preview to re-enter editing; a peer's edit keeps it so
  // the rescaled/reshaped mask just re-renders live over the baked composite.
  if (!keepMerged) _clearMergedImage();
  const g = buildSimGroup(imgIdx);
  if (!g) return;

  if (old) {
    g.x = old.x;
    g.y = old.y;
    g.angle = old.angle;
  } else {
    const rank = state.rankOrder.indexOf(imgIdx);
    const n = simGroups.size + 1;
    const pos = simGridPos(rank, n, state.outW, state.outH);
    g.x = pos.x;
    g.y = pos.y;
  }

  g.inWorld = !entry.simHidden;
  simGroups.set(imgIdx, g);

  if (g.inWorld) {
    _simViewDirty = true;
    _showMergeBtn();
  }
}

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

// ── Pixel render worker ────────────────────────────────────────────────────────
// Runs off-main-thread: draws each placed image to OffscreenCanvas, assembles
// the final RGBA pixel buffer. Accepts pre-sized ImageBitmaps so the worker
// never needs to know about image scale — just position and rotation.

function _pixelWorkerBody() {
  // sRGB <-> linear-light LUTs so gradient blending averages in linear space.
  const S2L = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const L2S = new Uint8ClampedArray(4097);
  for (let i = 0; i <= 4096; i++) {
    const v = i / 4096;
    L2S[i] = Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
  }
  const lin2srgb = (v) => L2S[v <= 0 ? 0 : v >= 1 ? 4096 : (v * 4096) | 0];

  self.onmessage = async ({ data: msg }) => {
    try {
      const { imageBitmaps, placements, ownership, W, H, PW, PH, fillColor } = msg;
      const { owner, ownerA, ownerB, blend } = ownership || {}; // owner: hard modes; ownerA/B+blend: gradient
      const gradient = !!ownerA;

      const imgData = [];
      for (let k = 0; k < placements.length; k++) {
        const sp = placements[k];
        const bm = imageBitmaps[k];
        if (!bm) {
          imgData.push(null);
          continue;
        }

        let x0, y0, x1, y1;
        if (sp.angle) {
          const cos = Math.cos(sp.angle),
            sin = Math.sin(sp.angle);
          const bw = bm.width,
            bh = bm.height;
          const corners = [
            [0, 0],
            [bw, 0],
            [bw, bh],
            [0, bh],
          ].map(([cx, cy]) => {
            const dx = cx - sp.imgCentroidX,
              dy = cy - sp.imgCentroidY;
            return [sp.pivotX + cos * dx - sin * dy, sp.pivotY + sin * dx + cos * dy];
          });
          const xs = corners.map((c) => c[0]),
            ys = corners.map((c) => c[1]);
          x0 = Math.max(0, Math.floor(Math.min(...xs)));
          y0 = Math.max(0, Math.floor(Math.min(...ys)));
          x1 = Math.min(PW, Math.ceil(Math.max(...xs)));
          y1 = Math.min(PH, Math.ceil(Math.max(...ys)));
        } else {
          x0 = Math.max(0, sp.x);
          y0 = Math.max(0, sp.y);
          x1 = Math.min(PW, sp.x + bm.width);
          y1 = Math.min(PH, sp.y + bm.height);
        }

        if (x1 <= x0 || y1 <= y0) {
          bm.close();
          imgData.push(null);
          continue;
        }

        const rw = x1 - x0,
          rh = y1 - y0;
        const oc = new OffscreenCanvas(rw, rh);
        const ctx = oc.getContext("2d");

        if (sp.angle) {
          ctx.save();
          ctx.translate(sp.pivotX - x0, sp.pivotY - y0);
          ctx.rotate(sp.angle);
          ctx.drawImage(bm, 0, 0, bm.width, bm.height, -sp.imgCentroidX, -sp.imgCentroidY, bm.width, bm.height);
          ctx.restore();
        } else {
          const srcX = Math.max(0, -sp.x),
            srcY = Math.max(0, -sp.y);
          ctx.drawImage(bm, srcX, srcY, rw, rh, 0, 0, rw, rh);
        }
        bm.close();

        imgData.push({ imgIdx: sp.imgIdx, x0, y0, x1, y1, rw, data: ctx.getImageData(0, 0, rw, rh).data });
      }

      const imgDataByIdx = new Map();
      for (const id of imgData) {
        if (id) imgDataByIdx.set(id.imgIdx, id);
      }
      const sampleOwner = (o, ox, oy) => {
        if (o < 0) return null;
        const id = imgDataByIdx.get(o);
        return id ? _sample(id, ox, oy) : null;
      };

      const fillTransparent = fillColor === null;
      const fr = fillTransparent ? 0 : parseInt(fillColor.slice(1, 3), 16);
      const fg = fillTransparent ? 0 : parseInt(fillColor.slice(3, 5), 16);
      const fb = fillTransparent ? 0 : parseInt(fillColor.slice(5, 7), 16);

      const scaleX = W / PW,
        scaleY = H / PH;
      const out = new Uint8ClampedArray(PW * PH * 4);

      for (let oy = 0; oy < PH; oy++) {
        for (let ox = 0; ox < PW; ox++) {
          const oi = oy * PW + ox;
          const out4 = oi * 4;
          const fullOx = Math.min(W - 1, Math.round(ox * scaleX));
          const fullOy = Math.min(H - 1, Math.round(oy * scaleY));
          const mi = fullOy * W + fullOx;

          let pixel = null;
          if (gradient) {
            const pa = sampleOwner(ownerA[mi], ox, oy);
            const b = ownerB[mi];
            const wB = b >= 0 ? blend[mi] / 255 : 0;
            const pb = wB > 0 ? sampleOwner(b, ox, oy) : null;
            pixel = pa && pb ? [lin2srgb(S2L[pa[0]] * (1 - wB) + S2L[pb[0]] * wB), lin2srgb(S2L[pa[1]] * (1 - wB) + S2L[pb[1]] * wB), lin2srgb(S2L[pa[2]] * (1 - wB) + S2L[pb[2]] * wB)] : pa || pb;
          } else {
            pixel = sampleOwner(owner ? owner[mi] : -1, ox, oy);
          }
          if (!pixel) {
            for (const id of imgData) {
              if (!id) continue;
              pixel = _sample(id, ox, oy);
              if (pixel) break;
            }
          }

          if (pixel) {
            out[out4] = pixel[0];
            out[out4 + 1] = pixel[1];
            out[out4 + 2] = pixel[2];
            out[out4 + 3] = 255;
          } else {
            out[out4] = fr;
            out[out4 + 1] = fg;
            out[out4 + 2] = fb;
            out[out4 + 3] = fillTransparent ? 0 : 255;
          }
        }
      }

      if (msg.returnBlob) {
        const oc = new OffscreenCanvas(PW, PH);
        oc.getContext("2d").putImageData(new ImageData(out, PW, PH), 0, 0);
        const blob = await oc.convertToBlob({ type: "image/png" });
        self.postMessage({ type: "done", blob, PW, PH });
      } else {
        self.postMessage({ type: "done", pixels: out.buffer, PW, PH }, [out.buffer]);
      }
    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }
  };

  function _sample(id, ox, oy) {
    if (ox < id.x0 || ox >= id.x1 || oy < id.y0 || oy >= id.y1) return null;
    const base = ((oy - id.y0) * id.rw + (ox - id.x0)) * 4;
    if (id.data[base + 3] === 0) return null;
    return [id.data[base], id.data[base + 1], id.data[base + 2]];
  }
}

function _makePixelWorker() {
  if (!_pixelWorkerBlobUrl) {
    const src = "(" + _pixelWorkerBody.toString() + ")();";
    _pixelWorkerBlobUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  }
  return new Worker(_pixelWorkerBlobUrl);
}

// Renders placements off-thread.
// previewScale=0.25 for fast preview; 1.0 for full-res download.
// returnBlob=true: worker encodes PNG and resolves with { blob, PW, PH }.
// returnBlob=false (default): resolves with { pixels: ArrayBuffer, PW, PH }.
// Async map with bounded concurrency. Firefox rejects createImageBitmap with an
// InvalidStateError when too many decodes are in flight at once (an internal decode
// limit, not a memory ceiling), so issuing all images in one Promise.all fails the
// whole render. Cap how many decode concurrently to stay under that limit.
async function _mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

async function _renderPixels(placements, ownership, previewScale, returnBlob = false) {
  const ps = previewScale;
  const PW = Math.max(1, Math.round(state.outW * ps));
  const PH = Math.max(1, Math.round(state.outH * ps));

  // Pre-scale each image bitmap to its final pixel size so the worker
  // only needs to composite, not scale.
  const imageBitmaps = await _mapLimit(placements, 6, (p) => {
    const entry = state.images[p.imgIdx]; // merge placements are positional
    const bw = Math.max(1, Math.round(entry.w * p.scale * ps));
    const bh = Math.max(1, Math.round(entry.h * p.scale * ps));
    // Decode straight to the final pixel size from the compressed bytes (full-res
    // bitmap never materialised). A single failed decode -> null, so one bad image
    // is skipped rather than failing the whole merge.
    return decodeEntry(entry, { resizeWidth: bw, resizeHeight: bh, resizeQuality: ps < 1 ? "medium" : "high" }).catch(() => null);
  });

  // Scale all position coords into preview canvas space.
  const scaledPlacements = placements.map((p) => ({
    imgIdx: p.imgIdx,
    x: Math.round(p.x * ps),
    y: Math.round(p.y * ps),
    angle: p.angle || 0,
    pivotX: (p.pivotX || 0) * ps,
    pivotY: (p.pivotY || 0) * ps,
    imgCentroidX: (p.imgCentroidX || 0) * ps,
    imgCentroidY: (p.imgCentroidY || 0) * ps,
  }));

  if (_activePixelWorker) {
    _activePixelWorker.terminate();
    _activePixelWorker = null;
  }
  const worker = _makePixelWorker();
  _activePixelWorker = worker;

  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data: msg }) => {
      _activePixelWorker = null;
      worker.terminate();
      if (msg.type === "done") resolve({ pixels: msg.pixels, blob: msg.blob, PW: msg.PW, PH: msg.PH });
      else reject(new Error(msg.message || "Pixel worker error"));
    };
    worker.onerror = (err) => {
      _activePixelWorker = null;
      worker.terminate();
      reject(new Error(err.message || "Pixel worker error"));
    };
    worker.postMessage(
      { imageBitmaps, placements: scaledPlacements, ownership, W: state.outW, H: state.outH, PW, PH, fillColor: state.fillColor, returnBlob },
      imageBitmaps.filter(Boolean), // never transfer a null (missing-blob safety)
    );
  });
}

function _applyMergePreview(pixels, PW, PH, placements) {
  resetMergeUI();
  btnMerge.classList.add("im-hidden");

  const imgData = new ImageData(new Uint8ClampedArray(pixels), PW, PH);
  mergeCanvas = document.createElement("canvas");
  mergeCanvas.width = PW;
  mergeCanvas.height = PH;
  mergeCanvas.getContext("2d").putImageData(imgData, 0, 0);
  simMergedImageData = imgData;
  simLastPlacements = placements;
  mergeX1 = simX1;
  mergeY1 = simY1;
  _simViewDirty = true;

  const placed = placements.length,
    total = state.images.length;
  updateSimStatus(placed === total ? "Merged - drag" : "Merged " + placed + "/" + total + " - drag");
  btnDownload.classList.remove("im-hidden");
}

// ── Download ──────────────────────────────────────────────────────────────────
btnDownload.addEventListener("click", async () => {
  if (!simLastPlacements || !simLastOwnership) return;
  const n = slidesN();
  btnDownload.disabled = true;
  try {
    if (n > 1) {
      updateSimStatus("Slicing " + n + "...");
      const { pixels, PW, PH } = await _renderPixels(simLastPlacements, simLastOwnership, 1.0, false);
      await _downloadSlices(pixels, PW, PH, n);
      updateSimStatus("Saved " + n + " slides");
    } else {
      updateSimStatus("Saving...");
      const { blob } = await _renderPixels(simLastPlacements, simLastOwnership, 1.0, true);
      _triggerDownload(blob, "merged.png");
      updateSimStatus("Merged - drag");
    }
  } catch (err) {
    updateSimStatus("Download error: " + err.message);
  } finally {
    btnDownload.disabled = false;
  }
});

function _triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = name;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Slice the full-res render into N equal columns and download them as a zip.
async function _downloadSlices(pixels, PW, PH, n) {
  const fullCanvas = document.createElement("canvas");
  fullCanvas.width = PW;
  fullCanvas.height = PH;
  fullCanvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(pixels), PW, PH), 0, 0);

  const JSZip = await _loadJSZip();
  const zip = new JSZip();
  const sliceW = Math.round(PW / n);
  for (let k = 0; k < n; k++) {
    const x = k * sliceW;
    const w = k === n - 1 ? PW - x : sliceW; // last slice takes the remainder
    const c = document.createElement("canvas");
    c.width = w;
    c.height = PH;
    c.getContext("2d").drawImage(fullCanvas, x, 0, w, PH, 0, 0, w, PH);
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    zip.file("slide-" + String(k + 1).padStart(2, "0") + ".png", blob);
  }
  _triggerDownload(await zip.generateAsync({ type: "blob" }), "carousel.zip");
}

let _jszipPromise = null;
function _loadJSZip() {
  if (self.JSZip) return Promise.resolve(self.JSZip);
  if (!_jszipPromise)
    _jszipPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      s.onload = () => resolve(self.JSZip);
      s.onerror = () => reject(new Error("Failed to load JSZip"));
      document.head.appendChild(s);
    });
  return _jszipPromise;
}

// ── Accordion controller ──────────────────────────────────────────────────────

function openStep(stepId) {
  document.querySelectorAll(".im-step").forEach((s) => {
    s.classList.toggle("im-step-open", s.id === stepId);
  });
  const target = document.getElementById(stepId);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function unlockStep(stepId) {
  const el = document.getElementById(stepId);
  if (el) el.classList.remove("im-step-locked");
}

function lockStep(stepId) {
  const el = document.getElementById(stepId);
  if (el) el.classList.add("im-step-locked");
}

function updateStepMeta(stepId, text, isOk) {
  const el = document.getElementById(stepId);
  if (!el) return;
  const meta = el.querySelector(".im-smeta");
  if (meta) {
    meta.textContent = text;
    meta.classList.toggle("im-ok", !!isOk);
  }
}

document.querySelectorAll(".im-step-hd").forEach((hd) => {
  hd.addEventListener("click", () => {
    const step = hd.closest(".im-step");
    if (!step || step.classList.contains("im-step-locked")) return;
    const isOpen = step.classList.contains("im-step-open");
    document.querySelectorAll(".im-step").forEach((s) => s.classList.remove("im-step-open"));
    if (!isOpen) step.classList.add("im-step-open");
  });
});

const btnAdvToggle = document.getElementById("btn-adv-toggle");
const advPanel = document.getElementById("adv-panel");
if (btnAdvToggle && advPanel) {
  btnAdvToggle.addEventListener("click", () => {
    const open = !advPanel.classList.toggle("im-hidden"); // toggle() returns true when now hidden
    btnAdvToggle.setAttribute("aria-expanded", String(open));
    btnAdvToggle.textContent = open ? "Hide" : "Show more";
  });
}

// A rim pointer (fades in/out) aimed at the output artboard, shown only while it
// is off-screen -- easy to lose on the big canvas.
const simRecenterRim = document.getElementById("sim-recenter-rim");
if (simRecenterRim) {
  simRecenterRim.addEventListener("click", () => {
    if (simRafId !== null) viewport.centerOnArtboard({ animate: true });
  });
}

function _artboardInView() {
  const ts = viewport.totalScale;
  const vL = viewport.offsetX,
    vT = viewport.offsetY;
  const vR = vL + simCanvas.width / ts,
    vB = vT + simCanvas.height / ts;
  return simX1 < vR && simX2 > vL && simY1 < vB && simY2 > vT;
}

let _recenterShown = false;
function _updateRecenterUI() {
  if (!simRecenterRim) return;
  const show = simRafId !== null && !_artboardInView();
  if (show !== _recenterShown) {
    _recenterShown = show;
    simRecenterRim.classList.toggle("im-shown", show);
  }
  if (!show) return;
  // Aim from the viewport centre toward the artboard centre (FPV damage-direction
  // style), clamped to an inset box that keeps it clear of the HUD and toggle.
  const rect = simCanvas.getBoundingClientRect();
  const cx = rect.left + rect.width / 2,
    cy = rect.top + rect.height / 2;
  const ac = viewport.worldToClient((simX1 + simX2) / 2, (simY1 + simY2) / 2);
  const ang = Math.atan2(ac.y - cy, ac.x - cx);
  const dx = Math.cos(ang),
    dy = Math.sin(ang);
  const L = rect.left + 28,
    R = rect.right - 28,
    T = rect.top + 64,
    B = rect.bottom - 84;
  let t = Infinity;
  if (dx > 1e-6) t = Math.min(t, (R - cx) / dx);
  else if (dx < -1e-6) t = Math.min(t, (L - cx) / dx);
  if (dy > 1e-6) t = Math.min(t, (B - cy) / dy);
  else if (dy < -1e-6) t = Math.min(t, (T - cy) / dy);
  const ex = cx + dx * t,
    ey = cy + dy * t;
  simRecenterRim.style.transform = `translate(${ex}px, ${ey}px) translate(-50%, -50%) rotate(${ang}rad)`;
}

openStep("step-images");

// Re-init sim canvas on window resize so it stays fullscreen
function _onSimCanvasResize() {
  if (simRafId === null) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvasW = Math.round(window.innerWidth * dpr);
  const canvasH = Math.round(window.innerHeight * dpr);
  simCanvas.width = canvasW;
  simCanvas.height = canvasH;
  const oldDisp = viewport.dispScale;
  const newDisp = Math.min(canvasW / WORLD_SPAN, canvasH / WORLD_SPAN);
  viewport.setDispScale(newDisp);
  // Keep visual zoom constant across the disp-scale change (offset unchanged).
  viewport._set((viewport.scale * oldDisp) / newDisp, viewport.offsetX, viewport.offsetY);
}

let _windowResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(_windowResizeTimer);
  _windowResizeTimer = setTimeout(_onSimCanvasResize, 200);
});

// ── Mouse interaction: drag (translate), Ctrl+drag (scale+rotate), corner resize
(function () {
  simCanvas.addEventListener("mousemove", (e) => {
    if (simRafId === null || simCornerDrag || _mouseDrag || _ctrlDrag || _groupMove || _marquee || _pan || _spaceDown) return;
    const canvasPx = viewport.clientToCanvasPx(e.clientX, e.clientY);
    const corner = nearestCornerHandle(canvasPx);
    if (corner) {
      simCanvas.style.cursor = corner.dir + "-resize";
      return;
    }
    const g = nearestGroup(viewport.canvasToWorld(e.clientX, e.clientY));
    if (g && !_remoteGrabs.has(g.imgIdx)) {
      simCanvas.style.cursor = e.ctrlKey ? "crosshair" : "grab";
    } else {
      simCanvas.style.cursor = "";
    }
  });

  let _mouseDrag = null; // { pointerId, group, offsetX, offsetY }
  let _ctrlDrag = null; // { pointerId, group, grabPhys, initScale, initAngle, initDist, initCursorAngle }

  // Suppress the native middle-click autoscroll so middle-drag can pan instead.
  simCanvas.addEventListener("mousedown", (e) => {
    if (e.button === 1) e.preventDefault();
  });

  simCanvas.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType !== "mouse" || simRafId === null) return;

      // Middle-mouse, or Space + left button -> pan the viewport (no select/move).
      if (e.button === 1 || (e.button === 0 && _spaceDown)) {
        e.preventDefault();
        simCanvas.setPointerCapture(e.pointerId);
        _pan = { pointerId: e.pointerId, lastPx: viewport.clientToCanvasPx(e.clientX, e.clientY) };
        simCanvas.style.cursor = "grabbing";
        return;
      }

      const canvasPx = viewport.clientToCanvasPx(e.clientX, e.clientY);
      const corner = nearestCornerHandle(canvasPx);
      if (corner) {
        e.preventDefault();
        e.stopPropagation();
        simCanvas.setPointerCapture(e.pointerId);
        simCanvas.style.cursor = corner.dir + "-resize";
        simCornerDrag = {
          dir: corner.dir,
          id: e.pointerId,
          startPx: canvasPx,
          startX1: simX1,
          startY1: simY1,
          startX2: simX2,
          startY2: simY2,
        };
        _clearMergedImage();
        return;
      }
      const phys = viewport.canvasToWorld(e.clientX, e.clientY);
      const g = nearestGroup(phys);

      // Shift/Cmd-click a mask -> toggle it in the selection (Figma-style; no move).
      if (g && (e.shiftKey || e.metaKey) && !e.ctrlKey) {
        e.preventDefault();
        toggleSelect(g.imgIdx);
        return;
      }

      // Empty space -> marquee drag-select (Shift/Cmd extends the current set).
      if (!g || _remoteGrabs.has(g.imgIdx)) {
        if (!g) {
          e.preventDefault();
          simCanvas.setPointerCapture(e.pointerId);
          _marquee = {
            pointerId: e.pointerId,
            x0: phys.x,
            y0: phys.y,
            x1: phys.x,
            y1: phys.y,
            sx: e.clientX,
            sy: e.clientY,
            add: e.shiftKey || e.metaKey,
            moved: false,
          };
        }
        return;
      }

      e.preventDefault();
      simCanvas.setPointerCapture(e.pointerId);

      if (e.ctrlKey) {
        const autoScale = computeAutoScales()[g.imgIdx].scale;
        const cx = g.x,
          cy = g.y;
        const dx0 = phys.x - cx,
          dy0 = phys.y - cy;
        const d0 = Math.hypot(dx0, dy0);
        const minPhys = 8 / viewport.totalScale;
        _ctrlDrag = {
          pointerId: e.pointerId,
          group: g,
          center: { x: cx, y: cy },
          initScale: imgById(g.imgIdx).scale ?? autoScale,
          initAngle: g.angle,
          initDist: d0 > minPhys ? d0 : null,
          initCursorAngle: d0 > minPhys ? Math.atan2(dy0, dx0) : null,
        };
        simBodyDragging = true;
        simCanvas.style.cursor = "crosshair";
        _clearMergedImage();
        dispatchBodyLift(g);
        _activeDragIdx = g.imgIdx;
        window.dispatchEvent(new CustomEvent("collab:body-grabbing", { detail: { imgIdx: g.imgIdx } }));
        return;
      }

      // Plain drag: move the whole selection if this mask is part of a multi-select;
      // otherwise drop the selection and drag this one alone.
      if (selectedIds.has(g.imgIdx) && selectedIds.size > 1) {
        beginGroupMove([...selectedIds], phys, e.pointerId);
        return;
      }
      clearSelection();
      _mouseDrag = { pointerId: e.pointerId, group: g, offsetX: g.x - phys.x, offsetY: g.y - phys.y };
      simBodyDragging = true;
      simCanvas.style.cursor = "grabbing";
      _clearMergedImage();
      dispatchBodyLift(g);
      _activeDragIdx = g.imgIdx;
      window.dispatchEvent(new CustomEvent("collab:body-grabbing", { detail: { imgIdx: g.imgIdx } }));
    },
    { passive: false },
  );

  simCanvas.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse") return;
      if (_pan && e.pointerId === _pan.pointerId) {
        const px = viewport.clientToCanvasPx(e.clientX, e.clientY);
        viewport.panByCanvasPx(-(px.x - _pan.lastPx.x), -(px.y - _pan.lastPx.y));
        _pan.lastPx = px;
        return;
      }
      if (_groupMove && e.pointerId === _groupMove.pointerId) {
        updateGroupMove(viewport.canvasToWorld(e.clientX, e.clientY));
        return;
      }
      if (_marquee && e.pointerId === _marquee.pointerId) {
        const p = viewport.canvasToWorld(e.clientX, e.clientY);
        _marquee.x1 = p.x;
        _marquee.y1 = p.y;
        if (!_marquee.moved && Math.hypot(e.clientX - _marquee.sx, e.clientY - _marquee.sy) > 4) _marquee.moved = true;
        _simViewDirty = true;
        return;
      }
      if (simCornerDrag && e.pointerId === simCornerDrag.id) {
        updateCornerResize(viewport.clientToCanvasPx(e.clientX, e.clientY));
        return;
      }
      if (_mouseDrag && e.pointerId === _mouseDrag.pointerId) {
        const phys = viewport.canvasToWorld(e.clientX, e.clientY);
        _mouseDrag.group.x = phys.x + _mouseDrag.offsetX;
        _mouseDrag.group.y = phys.y + _mouseDrag.offsetY;
        _simViewDirty = true;
        return;
      }
      if (_ctrlDrag && e.pointerId === _ctrlDrag.pointerId) {
        const phys = viewport.canvasToWorld(e.clientX, e.clientY);
        const dx = phys.x - _ctrlDrag.center.x;
        const dy = phys.y - _ctrlDrag.center.y;
        const dist = Math.hypot(dx, dy);
        const curAngle = Math.atan2(dy, dx);

        if (_ctrlDrag.initDist === null) {
          const minPhys = 8 / viewport.totalScale;
          if (dist < minPhys) return;
          _ctrlDrag.initDist = dist;
          _ctrlDrag.initCursorAngle = curAngle;
        }

        let newScale = Math.max(0.05, Math.min(20, _ctrlDrag.initScale * Math.pow(dist / _ctrlDrag.initDist, 0.5)));
        let delta = curAngle - _ctrlDrag.initCursorAngle;
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        let newAngle = _ctrlDrag.initAngle + delta;

        if (e.shiftKey) {
          newScale = Math.max(0.1, Math.round(newScale / 0.1) * 0.1);
          newAngle = Math.round(newAngle / ((15 * Math.PI) / 180)) * ((15 * Math.PI) / 180);
        }

        _ctrlDrag.group.angle = newAngle;
        pinchPreview = { imgIdx: _ctrlDrag.group.imgIdx, scale: newScale };
        updateSimStatus(newScale.toFixed(2) + "\xd7  " + Math.round((newAngle * 180) / Math.PI) + "\xb0");
        _simViewDirty = true;
      }
    },
    { passive: false },
  );

  function _finishMarquee() {
    if (_marquee.moved) {
      const minX = Math.min(_marquee.x0, _marquee.x1),
        maxX = Math.max(_marquee.x0, _marquee.x1);
      const minY = Math.min(_marquee.y0, _marquee.y1),
        maxY = Math.max(_marquee.y0, _marquee.y1);
      const picked = [...simGroups.values()].filter((g) => g.inWorld && g.x >= minX && g.x <= maxX && g.y >= minY && g.y <= maxY).map((g) => g.imgIdx);
      if (_marquee.add) {
        // Shift held: toggle each enclosed mask (like shift-clicking each one),
        // leaving masks outside the box untouched.
        const next = new Set(selectedIds);
        for (const id of picked) next.has(id) ? next.delete(id) : next.add(id);
        setSelection([...next]);
      } else {
        setSelection(picked); // plain marquee replaces the selection
      }
    } else if (!_marquee.add) {
      clearSelection(); // click on empty space clears
    }
    _marquee = null;
    _simViewDirty = true;
  }

  function _endMouseDrag() {
    if (!_mouseDrag) return;
    simBodyDragging = false;
    _activeDragIdx = null;
    simCanvas.style.cursor = "";
    dispatchBodyMoved(_mouseDrag.group);
    window.dispatchEvent(new CustomEvent("collab:body-releasing", { detail: { imgIdx: _mouseDrag.group.imgIdx } }));
    _mouseDrag = null;
  }

  function _endCtrlDrag() {
    if (!_ctrlDrag) return;
    const g = _ctrlDrag.group;
    if (pinchPreview && pinchPreview.imgIdx === g.imgIdx) {
      // Commit the scale (and sync it) before the final position goes out.
      setScale(g.imgIdx, pinchPreview.scale);
      pinchPreview = null;
      const ri = state.rankOrder.indexOf(g.imgIdx);
      if (ri === state.paintIdx) {
        painterScaleAuto.checked = false;
        painterScaleInp.disabled = false;
        painterScaleInp.value = imgById(g.imgIdx).scale.toFixed(2);
        updatePainterZoom(g.imgIdx);
      }
    } else {
      simRefreshGroup(g.imgIdx);
    }
    simBodyDragging = false;
    _activeDragIdx = null;
    simCanvas.style.cursor = "";
    dispatchBodyMoved(g);
    window.dispatchEvent(new CustomEvent("collab:body-releasing", { detail: { imgIdx: g.imgIdx } }));
    updateSimStatus("");
    _ctrlDrag = null;
  }

  function _endPan(e) {
    if (!_pan || e.pointerId !== _pan.pointerId) return false;
    _pan = null;
    simCanvas.style.cursor = _spaceDown ? "grab" : "";
    return true;
  }

  simCanvas.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "mouse") return;
    if (_endPan(e)) return;
    if (_groupMove && e.pointerId === _groupMove.pointerId) {
      endGroupMove();
      return;
    }
    if (_marquee && e.pointerId === _marquee.pointerId) {
      _finishMarquee();
      return;
    }
    if (simCornerDrag && e.pointerId === simCornerDrag.id) {
      simCanvas.style.cursor = "";
      finishCornerResize();
      return;
    }
    if (_mouseDrag && e.pointerId === _mouseDrag.pointerId) _endMouseDrag();
    if (_ctrlDrag && e.pointerId === _ctrlDrag.pointerId) _endCtrlDrag();
  });

  simCanvas.addEventListener("pointercancel", (e) => {
    if (e.pointerType !== "mouse") return;
    if (_endPan(e)) return;
    if (_groupMove && e.pointerId === _groupMove.pointerId) {
      endGroupMove();
      return;
    }
    if (_marquee && e.pointerId === _marquee.pointerId) {
      _marquee = null;
      _simViewDirty = true;
      return;
    }
    if (simCornerDrag && e.pointerId === simCornerDrag.id) {
      simCanvas.style.cursor = "";
      finishCornerResize();
      return;
    }
    if (_mouseDrag && e.pointerId === _mouseDrag.pointerId) _endMouseDrag();
    if (_ctrlDrag && e.pointerId === _ctrlDrag.pointerId) _endCtrlDrag();
  });
})();

// ── Touch interaction on sim canvas ───────────────────────────────────────────
// Long press (1 finger, ~380ms stationary) -> lifts nearest sim group.
//   Lifted + 2nd finger -> scale/rotate that group (pinch/twist).
// Two fingers simultaneously (no long press) -> viewport zoom/pan.
(function () {
  const LP_MS = 380; // long-press threshold ms
  const CANCEL_PX = 9; // cancel long-press if finger drifts this far

  let mode = "idle"; // 'idle'|'lp'|'corner-lp'|'pan'|'lifted'|'group'|'view'|'resize'
  let lpTimer = null;
  let lpTouch = null; // Touch at long-press start
  let lpStartX = 0,
    lpStartY = 0;
  let lpCorner = null; // corner captured during 'corner-lp'
  let lpStartCPx = null; // canvas px at corner-lp start
  let panLastPx = null; // canvas px for single-finger pan delta
  let liftedGroup = null; // simGroup being manipulated
  let liftedOffset = { x: 0, y: 0 }; // body-center minus finger in world coords
  let liftedId = -1; // identifier of primary finger
  let selPressGroup = null; // group under finger at select-mode press (tap/drag decision)

  let grpStart = null; // { dist, scale, angle, bodyAngle } for group pinch
  let viewStart = null; // { dist, scale, offset, mid } for viewport pinch

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
      x: (((t1.clientX + t2.clientX) / 2 - rect.left) / rect.width) * simCanvas.width,
      y: (((t1.clientY + t2.clientY) / 2 - rect.top) / rect.height) * simCanvas.height,
    };
  }

  function triggerLift() {
    lpTimer = null;
    if (simRafId === null || !lpTouch) return;
    const fingerPhys = viewport.canvasToWorld(lpTouch.clientX, lpTouch.clientY);
    const g = nearestGroup(fingerPhys, 40);
    if (!g) return;
    liftedGroup = g;
    liftedOffset = { x: g.x - fingerPhys.x, y: g.y - fingerPhys.y };
    mode = "lifted";
    _clearMergedImage();
    dispatchBodyLift(g);
    _activeDragIdx = g.imgIdx;
    window.dispatchEvent(new CustomEvent("collab:body-grabbing", { detail: { imgIdx: g.imgIdx } }));
    if (navigator.vibrate) navigator.vibrate(28);
    const autoScale = computeAutoScales()[g.imgIdx].scale;
    pinchPreview = { imgIdx: g.imgIdx, scale: imgById(g.imgIdx).scale ?? autoScale };
  }

  function triggerCornerResize() {
    lpTimer = null;
    if (simRafId === null || !lpCorner || !lpStartCPx) return;
    simCornerDrag = {
      dir: lpCorner.dir,
      id: liftedId,
      startPx: lpStartCPx,
      startX1: simX1,
      startY1: simY1,
      startX2: simX2,
      startY2: simY2,
    };
    _clearMergedImage();
    mode = "resize";
    if (navigator.vibrate) navigator.vibrate(28);
  }

  function initGroupPinch(t1, t2) {
    const autoScale = computeAutoScales()[liftedGroup.imgIdx].scale;
    const scale = imgById(liftedGroup.imgIdx).scale ?? autoScale;
    grpStart = {
      dist: twoTouchDist(t1, t2),
      scale,
      angle: Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX),
      bodyAngle: liftedGroup.angle,
    };
    pinchPreview = { imgIdx: liftedGroup.imgIdx, scale };
    _clearMergedImage();
  }

  function updateGroupPinch(t1, t2) {
    const dist = twoTouchDist(t1, t2);
    const newScale = Math.round(Math.max(0.05, Math.min(20, (grpStart.scale * dist) / grpStart.dist)) * 100) / 100;
    pinchPreview = { imgIdx: liftedGroup.imgIdx, scale: newScale };

    const curAngle = Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX);
    let angleDelta = curAngle - grpStart.angle;
    if (angleDelta > Math.PI) angleDelta -= 2 * Math.PI;
    if (angleDelta < -Math.PI) angleDelta += 2 * Math.PI;
    let newBodyAngle = grpStart.bodyAngle + angleDelta;

    // Snap to 0, 90, 180, 270 deg within +/-20
    const SNAP = (20 * Math.PI) / 180;
    const TWO_PI = 2 * Math.PI;
    const norm = ((newBodyAngle % TWO_PI) + TWO_PI) % TWO_PI;
    for (const s of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      let diff = norm - s;
      if (diff > Math.PI) diff -= TWO_PI;
      if (diff < -Math.PI) diff += TWO_PI;
      if (Math.abs(diff) < SNAP) {
        newBodyAngle -= diff;
        break;
      }
    }

    liftedGroup.angle = newBodyAngle;
    updateSimStatus(newScale.toFixed(2) + "\xd7  " + Math.round((newBodyAngle * 180) / Math.PI) + "\xb0");
  }

  function commitScale() {
    // Only after a real pinch. A plain lift+drag seeds pinchPreview with the
    // current scale but never changes it -- committing then would needlessly
    // fix an auto-scaled image and broadcast a scales message that wipes peers'
    // merged previews (simRefreshGroup -> _clearMergedImage).
    if (!liftedGroup || !pinchPreview || !grpStart) return;
    setScale(liftedGroup.imgIdx, pinchPreview.scale);
    const ri = state.rankOrder.indexOf(liftedGroup.imgIdx);
    if (ri === state.paintIdx) {
      painterScaleAuto.checked = false;
      painterScaleInp.disabled = false;
      painterScaleInp.value = imgById(liftedGroup.imgIdx).scale.toFixed(2);
      updatePainterZoom(liftedGroup.imgIdx);
    }
  }

  function releaseGroup() {
    commitScale();
    if (liftedGroup) {
      simRefreshGroup(liftedGroup.imgIdx);
      dispatchBodyMoved(liftedGroup);
      window.dispatchEvent(new CustomEvent("collab:body-releasing", { detail: { imgIdx: liftedGroup.imgIdx } }));
    }
    _activeDragIdx = null;
    liftedGroup = null;
    liftedOffset = { x: 0, y: 0 };
    pinchPreview = null;
    grpStart = null;
  }

  function initViewPinch(t1, t2) {
    viewStart = {
      dist: twoTouchDist(t1, t2),
      scale: viewport.scale,
      offset: { x: viewport.offsetX, y: viewport.offsetY },
      mid: viewport.canvasToWorld((t1.clientX + t2.clientX) / 2, (t1.clientY + t2.clientY) / 2),
    };
  }

  function updateViewPinch(t1, t2) {
    const dist = twoTouchDist(t1, t2);
    const newScale = Math.max(0.1, Math.min(10, (viewStart.scale * dist) / viewStart.dist));
    const midPx = twoTouchMidPx(t1, t2);
    viewport._apply(newScale, viewStart.mid.x - midPx.x / (viewport.dispScale * newScale), viewStart.mid.y - midPx.y / (viewport.dispScale * newScale));
  }

  function reset() {
    if (lpTimer) {
      clearTimeout(lpTimer);
      lpTimer = null;
    }
    if (mode === "resize") finishCornerResize();
    if (_groupMove) endGroupMove();
    releaseGroup();
    selPressGroup = null;
    viewStart = null;
    lpCorner = null;
    lpStartCPx = null;
    panLastPx = null;
    mode = "idle";
    liftedId = -1;
    lpTouch = null;
  }

  simCanvas.addEventListener(
    "touchstart",
    (e) => {
      if (simRafId === null) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const all = e.touches;

      if (all.length === 1 && mode === "idle") {
        const t = all[0];
        const canvasPx = viewport.clientToCanvasPx(t.clientX, t.clientY);
        const corner = nearestCornerHandle(canvasPx);
        if (corner) {
          mode = "corner-lp";
          lpTouch = t;
          lpStartX = t.clientX;
          lpStartY = t.clientY;
          liftedId = t.identifier;
          lpCorner = corner;
          lpStartCPx = canvasPx;
          lpTimer = setTimeout(triggerCornerResize, LP_MS);
        } else if (selectMode) {
          mode = "sel-press";
          lpTouch = t;
          lpStartX = t.clientX;
          lpStartY = t.clientY;
          liftedId = t.identifier;
          selPressGroup = nearestGroup(viewport.canvasToWorld(t.clientX, t.clientY), 40);
        } else {
          mode = "lp";
          lpTouch = t;
          lpStartX = t.clientX;
          lpStartY = t.clientY;
          liftedId = t.identifier;
          lpTimer = setTimeout(triggerLift, LP_MS);
        }
      } else if (all.length === 2) {
        if (mode === "lp") {
          clearTimeout(lpTimer);
          lpTimer = null;
          mode = "view";
          initViewPinch(all[0], all[1]);
        } else if (mode === "sel-press") {
          mode = "view";
          initViewPinch(all[0], all[1]);
        } else if (mode === "idle") {
          mode = "view";
          initViewPinch(all[0], all[1]);
        } else if (mode === "lifted") {
          mode = "group";
          const t1 = findTouch(all, liftedId) || all[0];
          const t2 = t1 === all[0] ? all[1] : all[0];
          initGroupPinch(t1, t2);
        }
      } else if (all.length > 2) {
        reset();
      }
    },
    { passive: false, capture: true },
  );

  simCanvas.addEventListener(
    "touchmove",
    (e) => {
      if (simRafId === null) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const all = e.touches;

      if (mode === "resize" && simCornerDrag) {
        const t = findTouch(all, simCornerDrag.id);
        if (t) updateCornerResize(viewport.clientToCanvasPx(t.clientX, t.clientY));
      } else if (mode === "lp") {
        const t = findTouch(all, liftedId);
        if (t && Math.hypot(t.clientX - lpStartX, t.clientY - lpStartY) > CANCEL_PX) {
          clearTimeout(lpTimer);
          lpTimer = null;
          mode = "pan";
          panLastPx = viewport.clientToCanvasPx(t.clientX, t.clientY);
        }
      } else if (mode === "corner-lp") {
        const t = findTouch(all, liftedId);
        if (t && Math.hypot(t.clientX - lpStartX, t.clientY - lpStartY) > CANCEL_PX) {
          clearTimeout(lpTimer);
          lpTimer = null;
          lpCorner = null;
          lpStartCPx = null;
          mode = "pan";
          panLastPx = viewport.clientToCanvasPx(t.clientX, t.clientY);
        }
      } else if (mode === "pan") {
        const t = findTouch(all, liftedId);
        if (t) {
          const px = viewport.clientToCanvasPx(t.clientX, t.clientY);
          viewport.panByCanvasPx(-(px.x - panLastPx.x), -(px.y - panLastPx.y));
          panLastPx = px;
        }
      } else if (mode === "sel-press") {
        const t = findTouch(all, liftedId);
        if (t && Math.hypot(t.clientX - lpStartX, t.clientY - lpStartY) > CANCEL_PX) {
          if (selPressGroup) {
            if (!selectedIds.has(selPressGroup.imgIdx)) setSelection([selPressGroup.imgIdx]);
            const ids = selectedIds.has(selPressGroup.imgIdx) ? [...selectedIds] : [selPressGroup.imgIdx];
            const startPhys = viewport.canvasToWorld(lpStartX, lpStartY);
            if (beginGroupMove(ids, startPhys, liftedId)) {
              mode = "sel-move";
            } else {
              mode = "pan";
              panLastPx = viewport.clientToCanvasPx(t.clientX, t.clientY);
            }
          } else {
            mode = "pan";
            panLastPx = viewport.clientToCanvasPx(t.clientX, t.clientY);
          }
        }
      } else if (mode === "sel-move") {
        const t = findTouch(all, liftedId);
        if (t) updateGroupMove(viewport.canvasToWorld(t.clientX, t.clientY));
      } else if (mode === "lifted") {
        const t = findTouch(all, liftedId);
        if (t && liftedGroup) {
          const phys = viewport.canvasToWorld(t.clientX, t.clientY);
          liftedGroup.x = phys.x + liftedOffset.x;
          liftedGroup.y = phys.y + liftedOffset.y;
          simMergedImageData = null;
          simLastPlacements = null;
          btnDownload.classList.add("im-hidden");
          _showMergeBtn();
        }
      } else if (mode === "group" && grpStart && all.length >= 2) {
        const t1 = findTouch(all, liftedId) || all[0];
        const t2 = t1 === all[0] ? all[1] : all[0];
        updateGroupPinch(t1, t2);
      } else if (mode === "view" && viewStart && all.length >= 2) {
        updateViewPinch(all[0], all[1]);
      }
    },
    { passive: false, capture: true },
  );

  simCanvas.addEventListener(
    "touchend",
    (e) => {
      const all = e.touches;

      if (mode === "resize") {
        if (all.length === 0) {
          finishCornerResize();
          mode = "idle";
        }
      } else if (mode === "lp") {
        if (lpTimer) {
          clearTimeout(lpTimer);
          lpTimer = null;
        }
        mode = "idle";
      } else if (mode === "corner-lp") {
        if (lpTimer) {
          clearTimeout(lpTimer);
          lpTimer = null;
        }
        lpCorner = null;
        lpStartCPx = null;
        mode = "idle";
      } else if (mode === "pan") {
        if (all.length === 0) {
          panLastPx = null;
          mode = "idle";
        }
      } else if (mode === "sel-press") {
        if (selPressGroup) toggleSelect(selPressGroup.imgIdx); // tap (no drag) toggles
        selPressGroup = null;
        mode = "idle";
      } else if (mode === "sel-move") {
        if (all.length === 0) {
          endGroupMove();
          selPressGroup = null;
          mode = "idle";
        }
      } else if (mode === "lifted") {
        if (all.length === 0) {
          releaseGroup();
          mode = "idle";
        }
      } else if (mode === "group") {
        if (all.length < 2) {
          commitScale();
          grpStart = null;
          if (all.length === 1 && findTouch(all, liftedId)) {
            // one finger remains -- back to drag mode
            mode = "lifted";
          } else {
            releaseGroup();
            mode = "idle";
          }
        }
      } else if (mode === "view") {
        if (all.length < 2) {
          viewStart = null;
          mode = "idle";
        }
      }
    },
    { passive: true },
  );

  simCanvas.addEventListener("touchcancel", () => reset(), { passive: true });
})();

// ── Mouse wheel: viewport pan + Ctrl+scroll zoom ─────────────────────────────
simCanvas.addEventListener(
  "wheel",
  (e) => {
    if (simRafId === null) return;
    e.preventDefault();
    const rect = simCanvas.getBoundingClientRect();
    const cssToCanvas = simCanvas.width / rect.width;
    if (e.ctrlKey) {
      const zoomFactor = Math.exp(-e.deltaY * 0.01);
      viewport.zoomAtCanvasPx(viewport.clientToCanvasPx(e.clientX, e.clientY), viewport.scale * zoomFactor);
    } else {
      viewport.panByCanvasPx(e.deltaX * cssToCanvas, e.deltaY * cssToCanvas);
    }
  },
  { passive: false },
);

// ── Keyboard: Ctrl/Cmd+A select-all, Esc clears (desktop) ─────────────────────
window.addEventListener("keydown", (e) => {
  if (simRafId === null) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (e.code === "Space" && !(t && t.tagName === "BUTTON")) {
    e.preventDefault(); // hold Space to pan; also stops the page scrolling
    if (!_spaceDown) {
      _spaceDown = true;
      if (!_pan) simCanvas.style.cursor = "grab";
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    setSelection([...simGroups.values()].filter((g) => g.inWorld && !imgById(g.imgIdx).simHidden).map((g) => g.imgIdx));
  } else if (e.key === "Escape" && selectedIds.size) {
    clearSelection();
  }
});

// Leave pan mode (reset the cursor unless a pan drag is mid-flight) on Space-up or
// window blur (so a missed keyup can't leave the cursor stuck).
function _exitSpacePan() {
  if (!_spaceDown) return;
  _spaceDown = false;
  if (!_pan && simRafId !== null) simCanvas.style.cursor = "";
}
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") _exitSpacePan();
});
window.addEventListener("blur", _exitSpacePan);

// ── Touch drag-to-reorder filmstrip ───────────────────────────────────────────
// Long-press (380ms without movement) lifts the card; dragging horizontally
// reorders it live; lifting the finger commits the new order.
(function () {
  const LONG_PRESS_MS = 380;
  const MOVE_CANCEL = 9; // px — cancel long-press if finger moves this far
  let timer = null,
    drag = null,
    savedOrder = null;
  let pressX = 0,
    pressY = 0;

  rankList.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      const li = e.target.closest(".im-rank-item");
      if (!li) return;
      // Don't start drag when tapping the hide/remove buttons
      if (e.target.closest(".im-film-hide, .im-film-rm")) return;

      const t = e.touches[0];
      pressX = t.clientX;
      pressY = t.clientY;

      timer = setTimeout(() => {
        timer = null;
        savedOrder = [...state.rankOrder];
        drag = { li };
        li.classList.add("dragging");
        if (navigator.vibrate) navigator.vibrate(28);
      }, LONG_PRESS_MS);
    },
    { passive: true },
  );

  rankList.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];

      // Cancel pending long-press if finger moved too much
      if (timer) {
        if (Math.abs(t.clientX - pressX) > MOVE_CANCEL || Math.abs(t.clientY - pressY) > MOVE_CANCEL) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }

      if (!drag) return;
      e.preventDefault(); // stop page scroll while reordering

      const over = document.elementFromPoint(t.clientX, t.clientY)?.closest(".im-rank-item");
      if (over && over !== drag.li) {
        const children = Array.from(rankList.children);
        const overIdx = children.indexOf(over);
        const dragIdx = children.indexOf(drag.li);
        if (overIdx < dragIdx) rankList.insertBefore(drag.li, over);
        else rankList.insertBefore(drag.li, over.nextSibling);
      }
    },
    { passive: false },
  );

  function finish(commit) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!drag) return;
    drag.li.classList.remove("dragging");

    if (commit) {
      setRankOrder(Array.from(rankList.children).map((li) => li.dataset.imgIdx));
    } else {
      setRankOrder(savedOrder, { broadcast: false });
    }
    drag = null;
    savedOrder = null;
  }

  rankList.addEventListener("touchend", () => finish(true), { passive: true });
  rankList.addEventListener("touchcancel", () => finish(false), { passive: true });
})();

// ── Session export / import ───────────────────────────────────────────────────

function _sessionStatus(text) {
  sessionStatusEl.textContent = text;
  sessionStatusEl.classList.toggle("im-hidden", !text);
}

// Build exported session blob and trigger download.
btnExportSession.addEventListener("click", async () => {
  if (state.images.length === 0) return;
  btnExportSession.disabled = true;
  _sessionStatus("Exporting 0%");
  try {
    await SessionIO.export(
      {
        state,
        simGroups,
        yoloPool,
        cfg: {
          blendMode: cfgBlendMode.value,
          seed: parseInt(cfgSeed.value) || 42,
          ditherExp: parseInt(cfgDitherExp.value) || 4,
          slides: slidesN(),
          useYolo: state.useYolo,
          simViewScale: viewport.scale,
          simViewOffset: viewport.offset,
          simX1,
          simY1,
          simX2,
          simY2,
        },
      },
      (pct, text) => _sessionStatus(text),
    );
    _sessionStatus("Exported");
    setTimeout(() => _sessionStatus(""), 3000);
  } catch (e) {
    _sessionStatus("Export failed: " + e.message);
  } finally {
    btnExportSession.disabled = state.images.length === 0;
  }
});

// File selected — show confirm if session active, else replace immediately.
let _pendingImportFile = null;

inpImportSession.addEventListener("change", () => {
  const file = inpImportSession.files[0];
  inpImportSession.value = "";
  if (!file) return;
  _pendingImportFile = file;
  sessionConfirm.classList.add("im-hidden");
  if (state.images.length > 0) {
    sessionConfirm.classList.remove("im-hidden");
  } else {
    _doImportReplace(file);
    _pendingImportFile = null;
  }
});

btnSessReplace.addEventListener("click", () => {
  sessionConfirm.classList.add("im-hidden");
  if (_pendingImportFile) _doImportReplace(_pendingImportFile);
  _pendingImportFile = null;
});

btnSessAdd.addEventListener("click", () => {
  sessionConfirm.classList.add("im-hidden");
  if (_pendingImportFile) _doImportAdd(_pendingImportFile);
  _pendingImportFile = null;
});

btnSessCancel.addEventListener("click", () => {
  sessionConfirm.classList.add("im-hidden");
  _pendingImportFile = null;
});

// Streaming import driver. makeMeta builds state from the session header (masks +
// filmstrip render at once), then each decoded image streams in -- so the count is
// truthful and "Imported" only shows after the last image lands.
async function _runImport(file, makeMeta) {
  _sessionStatus("Importing...");
  try {
    let ctx = null,
      total = 0,
      done = 0;
    await SessionIO.importStream(file, {
      onMeta: (session) => {
        ctx = makeMeta(session);
        total = ctx.ids.length;
        _sessionStatus(total ? "Loading 0/" + total : "Imported");
      },
      onImage: (i, msg) => {
        implog("imp " + i + (msg.retry ? " retry" : "") + " bytes:" + (msg.jpegBuf ? "ok" : "MISSING") + " thumb:" + (msg.thumbBuf ? "ok" : "none") + " enc:" + (msg.encoding ? "y" : "n"));
        _importImage(i, msg, ctx);
        if (!msg.retry) _sessionStatus("Loading " + ++done + "/" + total);
      },
      onLog: (m) => implog("wk " + m),
      onThumb: (i, msg) => {
        const entry = imgById(ctx.ids[i]);
        if (!entry) return;
        if (!entry.w && msg.w) entry.w = msg.w;
        if (!entry.h && msg.h) entry.h = msg.h;
        if (!entry.thumbUrl) {
          entry.thumbUrl = _bufToDataUrl(msg.thumbBuf, "image/jpeg");
          _updateFilmstripThumb(entry.id);
        }
      },
    });
    if (ctx) {
      if (!ctx.painted) loadPainterImage(state.paintIdx);
      ensureYoloEncoding();
    }
    // Publish the imported settings through the same event the live edits use
    // (_settingsPayload stays the single source of the synced key set).
    window.dispatchEvent(new CustomEvent("collab:settings-changed", { detail: _settingsPayload() }));
    window.dispatchEvent(new CustomEvent("collab:session-loaded"));
    _sessionStatus(total ? "Imported" : "");
    if (total) setTimeout(() => _sessionStatus(""), 1500);
  } catch (e) {
    implog("import FATAL: " + e.message);
    _sessionStatus("Import failed: " + e.message);
  }
}

function _doImportReplace(file) {
  return _runImport(file, _importMetaReplace);
}
function _doImportAdd(file) {
  return _runImport(file, _importMetaAdd);
}

// Placeholder image entry from a session/meta record `si`. The thumbnail and
// pixels (entry.blob) stream in later; the bitmap is decoded on demand.
function _sessionEntry(si, id) {
  return {
    id,
    file: null,
    blob: null,
    bytes: null,
    assetHash: si.assetHash || null, // content key; bytes pulled on demand
    thumbHash: si.thumbHash || null, // tiny preview, pulled first
    name: si.name,
    thumbUrl: null,
    w: si.w,
    h: si.h,
    polygons: si.polygons || [],
    currentPoly: si.currentPoly || [],
    scale: si.scale,
    scaleFixed: si.scaleFixed || false,
    simHidden: si.simHidden || false,
  };
}

// Build the whole app shell from the session header before any pixels arrive:
// config, placeholder image entries (img null), filmstrip, and the sim groups +
// positions -- so masks + the filmstrip render immediately. Returns { ids }.
function _importMetaReplace(session) {
  teardownSim();

  // Wipe existing state
  state.images = [];
  state.rankOrder = [];
  state.undoStack = new Map();
  yoloPool.embeddingCache.clear();
  yoloPool.dots.clear();
  rankList.innerHTML = "";
  // Old session's content-addressed bytes are unreachable after a replace; keeping
  // them leaked a whole session of blobs per import (and blob storage is quota'd).
  assetStore.clear();

  // Restore config to DOM + state
  state.outW = session.outW;
  cfgWidth.value = session.outW;
  state.outH = session.outH;
  cfgHeight.value = session.outH;
  cfgSlides.value = session.slides || 1;
  _syncCarouselUI();
  state.fillColor = session.fillColor !== undefined ? session.fillColor : "#ff69b4";
  if (state.fillColor === null) {
    cfgFillTransparent.classList.add("im-active");
  } else {
    cfgFill.value = state.fillColor;
    cfgFillTransparent.classList.remove("im-active");
  }
  cfgBlendMode.value = session.blendMode || "gradient";
  cfgBlendMode.dispatchEvent(new Event("change"));
  cfgSeed.value = session.seed || 42;
  cfgDitherExp.value = session.ditherExp || 4;

  // Restore the auto-segment preference; ensureYoloEncoding (on done) acts on it.
  state.useYolo = !!session.useYolo;
  cfgUseYolo.checked = state.useYolo;
  yoloControls.classList.toggle("im-hidden", !state.useYolo);
  _syncYoloMobile();

  // Stable id per image (stored, or generated for old sessions). Placeholder
  // entries (no pixels yet) -- the blob + thumbnail stream in via _importImage.
  const imgs = session.images || [];
  const ids = imgs.map((si) => si.id || newImgId());
  imgs.forEach((si, i) => {
    state.images[i] = _sessionEntry(si, ids[i]);
    state.undoStack.set(ids[i], []);
  });

  // rankOrder supports old (numeric index) and new (id) formats.
  const order = (session.rankOrder || ids.map((_, i) => i)).map((r) => (typeof r === "number" ? ids[r] : r));
  state.rankOrder = order.filter((id) => imgById(id));
  state.paintIdx = Math.min(session.paintIdx || 0, Math.max(0, state.rankOrder.length - 1));

  paintArea.classList.remove("im-hidden");
  buildRankList();
  unlockStep("step-paint");
  panelSetOpen(true);
  updateStepMeta("step-images", imageCountLabel(state.images.length), true);

  // Saved positions (keyed by id) + init sim -> masks render now (no pixels needed).
  const savedPositions = {};
  imgs.forEach((si, i) => {
    if (si.simPos) savedPositions[ids[i]] = { pos: si.simPos, angle: si.simAngle || 0 };
  });
  initSim(savedPositions);

  // Restore viewport and output position after initSim resets them
  if (session.simViewScale) {
    viewport.setView(session.simViewScale, session.simViewOffset.x, session.simViewOffset.y);
  }
  if (session.simX1 != null) {
    simX1 = session.simX1;
    simY1 = session.simY1;
    simX2 = session.simX2;
    simY2 = session.simY2;
  } else if (session.simOutX != null) {
    simX1 = session.simOutX;
    simY1 = session.simOutY;
    simX2 = simX1 + state.outW;
    simY2 = simY1 + state.outH;
  }

  return { ids };
}

// Append a session's images (fresh ids) as placeholder entries + sim groups; pixels
// stream in via _importImage. Returns { ids } aligned to session.images order.
function _importMetaAdd(session) {
  const imgs = session.images || [];
  const ids = imgs.map(() => newImgId()); // always fresh ids when appending

  imgs.forEach((si, i) => {
    state.images.push(_sessionEntry(si, ids[i]));
    state.undoStack.set(ids[i], []);
  });

  // Append to rankOrder in the imported session's order (old=index, new=id).
  const orderPos = (session.rankOrder || imgs.map((_, i) => i)).map((r) => (typeof r === "number" ? r : imgs.findIndex((si) => si.id === r))).filter((i) => i >= 0);
  for (const i of orderPos) state.rankOrder.push(ids[i]);

  buildRankList();
  updateStepMeta("step-images", imageCountLabel(state.images.length), true);

  // Add the new groups to the running sim at their saved positions (masks now).
  if (simRafId !== null) {
    imgs.forEach((si, i) => {
      simRefreshGroup(ids[i]);
      const g = simGroups.get(ids[i]);
      if (si.simPos && g) placeGroup(g, si.simPos.x, si.simPos.y, si.simAngle || 0);
    });
  }

  return { ids };
}

// One streamed image: attach its decoded bitmap + worker-built thumbnail + (if any)
// SAM encoding to the placeholder entry the meta pass created. The sim group already
// exists (built from polygons), so the mask is already on screen -- this just fills
// pixels, patches the filmstrip thumb, and loads the painter if it's the open image.
function _importImage(i, msg, ctx) {
  const id = ctx.ids[i];
  const entry = imgById(id);
  if (!entry) return;

  if (msg.jpegBuf) {
    // Keep the compressed bytes in JS memory as the source of truth. Android
    // Chrome pages constructed Blobs into browser-managed storage whose backing
    // can go unreadable (NotReadableError on every later use) -- entry.bytes is
    // immune, and decodeEntry mints a transient Blob from it per decode.
    entry.bytes = msg.jpegBuf;
    entry.blob = new Blob([msg.jpegBuf], { type: "image/jpeg" });
    if (!entry.w && msg.w) entry.w = msg.w;
    if (!entry.h && msg.h) entry.h = msg.h;
  }
  if (msg.thumbBuf) {
    // Data URL (not a blob: URL) so it stays valid when streamed to a collab guest.
    entry.thumbUrl = _bufToDataUrl(msg.thumbBuf, "image/jpeg");
    _updateFilmstripThumb(id);
  } else if (entry.blob) {
    // Worker could not decode a thumb (memory pressure on big photos); retry here.
    _thumbFallback(entry);
  }
  if (msg.encoding) {
    _restoreEncodings([msg.encoding], [id]);
    markDotEncoded(id);
  }
  if (entry.blob && state.rankOrder[state.paintIdx] === id) {
    loadPainterImage(state.paintIdx);
    ctx.painted = true;
  }
  _showMergeBtn(); // offer merge only once every placed image has its pixels
}

// Build a filmstrip thumb on the main thread from an entry's compressed bytes.
// Decodes straight to thumb size; failures back off and retry (memory-pressure
// decodes recover once transient allocations are released).
async function _thumbFallback(entry, attempt = 0) {
  if ((!entry.blob && !entry.bytes) || entry.thumbUrl || !entry.w || !entry.h || imgById(entry.id) !== entry) return;
  try {
    const ts = Math.min(1, 256 / Math.max(entry.w, entry.h));
    const tW = Math.max(1, Math.round(entry.w * ts));
    const tH = Math.max(1, Math.round(entry.h * ts));
    const bm = await decodeEntry(entry, { resizeWidth: tW, resizeHeight: tH, resizeQuality: "medium" });
    entry.thumbUrl = buildThumb(bm, entry.w, entry.h);
    bm.close();
    _updateFilmstripThumb(entry.id);
  } catch (err) {
    implog("thumb fail " + (entry.name || entry.id) + " a" + attempt + ": " + (err && err.message));
    if (attempt < 4) setTimeout(() => _thumbFallback(entry, attempt + 1), 2000 << attempt);
  }
}

// ── Content-addressed asset store ─────────────────────────────────────────────
// Image *bytes* are keyed by a content hash and fetched on demand (pull), decoupled
// from metadata sync. A peer that knows an image exists (from metadata carrying its
// assetHash) but lacks the bytes requests them and retries until they arrive -- so a
// stalled byte payload (the small header still got through) self-heals instead of
// leaving a stuck skeleton. crypto.subtle is deliberately avoided: it is undefined on
// plain-http LAN origins, a common collab setup here.
const assetStore = new Map(); // assetHash -> Blob (compressed bytes)

async function _assetHash(src) {
  const bytes = new Uint8Array(src instanceof Blob ? await src.arrayBuffer() : src);
  let h1 = 0x811c9dc5,
    h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[i], 0x85ebca6b) >>> 0;
  }
  return bytes.length.toString(16) + "-" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// Ensure an entry's bytes are hashed + registered; returns the hash.
async function ensureAssetHash(entry) {
  if (!entry.blob && !entry.bytes) return entry.assetHash || null;
  if (!entry.assetHash) entry.assetHash = await _assetHash(entry.bytes || entry.blob);
  assetStore.set(entry.assetHash, entry.blob || new Blob([entry.bytes], { type: "image/jpeg" }));
  return entry.assetHash;
}

window.hasAsset = (hash) => assetStore.has(hash);
window.getAssetBuffer = async (hash) => {
  // Serve from a live entry's JS-memory bytes when possible (blob backing can
  // go unreadable on Android); copy so chunked sends can't detach the resident.
  const e = state.images.find((x) => x.assetHash === hash && x.bytes);
  if (e) return e.bytes.slice(0);
  const b = assetStore.get(hash);
  return b ? await b.arrayBuffer() : null;
};

// Populate a skeleton entry from bytes already in the local store (decode -> thumb).
async function _fillEntryFromStore(entry) {
  const blob = assetStore.get(entry.assetHash);
  if (!blob || entry.blob) return false;
  entry.blob = blob;
  try {
    entry.bytes = await blob.arrayBuffer(); // rescue into JS memory while readable
  } catch (err) {
    implog("store read fail " + (entry.name || entry.id) + ": " + (err && err.message));
  }
  await _thumbFallback(entry); // thumb-size decode (never full-res); retries under pressure
  simRefreshGroup(entry.id);
  _simViewDirty = true;
  _showMergeBtn(); // this image's bytes landed -> may complete "all transferred"
  // If the painter is showing this image's loading placeholder, render it now.
  if (state.rankOrder[state.paintIdx] === entry.id) loadPainterImage(state.paintIdx);
  return true;
}

// Content-address the thumbnail too, so peers can pull the tiny preview by hash before
// the heavy full image arrives. The thumb blob lives in the same assetStore, keyed by
// thumbHash. Only the producer of a thumbnail computes its hash (a re-encode elsewhere
// would differ); other peers carry thumbHash from the doc and pull the bytes.
async function ensureThumbHash(entry) {
  if (!entry.thumbUrl) return entry.thumbHash || null;
  const blob = await (await fetch(entry.thumbUrl)).blob();
  if (!entry.thumbHash) entry.thumbHash = await _assetHash(blob);
  assetStore.set(entry.thumbHash, blob);
  return entry.thumbHash;
}

// Show the pulled thumbnail preview -- does not need the full image bytes.
async function _fillThumbFromStore(entry) {
  const blob = assetStore.get(entry.thumbHash);
  if (!blob || entry.thumbUrl) return false;
  entry.thumbUrl = _bufToDataUrl(await blob.arrayBuffer(), "image/jpeg");
  _updateFilmstripThumb(entry.id);
  return true;
}

// Pull missing bytes by hash with BOUNDED CONCURRENCY. Requesting every missing hash at
// once let the receiver re-ask for transfers that were merely queued on the sender (which
// serializes serves) once they outlasted the retry window on a slow link -- piling up
// duplicate serves that saturated the channel long after everything had synced (seen on a
// phone refresh re-pulling all images). Instead we keep only ASSET_CONCURRENCY pulls in
// flight; as each lands we top up. The sender transfers one at a time anyway, so this just
// caps its queue and makes the stampede impossible regardless of link speed.
const ASSET_CONCURRENCY = 2; // max pulls in flight; the sender serializes anyway, so a
// shallow queue (no gap) lets a newly-viewed image be served within ~1 transfer
const ASSET_STALL_MS = 15000; // request quiet AND channel idle this long -> retry (resume)
const _assetReqAt = new Map(); // hash -> last request time

// Serialize reconciles. This function awaits (image decode) and is called from the 4s
// timer, membership updates, AND every asset arrival -- so overlapping runs would each
// compute their own `active` and dispatch a full window, blowing past the concurrency cap
// (the "18-30 at once" over-request). Run one at a time; if triggered mid-run, run again.
let _reconcileBusy = false;
let _reconcileAgain = false;
async function reconcileAssets() {
  if (_reconcileBusy) {
    _reconcileAgain = true;
    return;
  }
  _reconcileBusy = true;
  try {
    do {
      _reconcileAgain = false;
      await _reconcileOnce();
    } while (_reconcileAgain);
  } finally {
    _reconcileBusy = false;
  }
}

async function _reconcileOnce() {
  let filled = false;
  const rankOf = (id) => {
    const r = state.rankOrder.indexOf(id);
    return r === -1 ? Infinity : r;
  };
  const ordered = [...state.images].sort((a, b) => rankOf(a.id) - rankOf(b.id));
  const now = Date.now();
  // A requested pull stays "in flight" (counted toward the window, not re-requested) while
  // its own bytes are arriving OR the channel is busy serving anything -- in that case it's
  // just queued on the (serial) sender, not lost. Only a request that has gone quiet while
  // the WHOLE channel is idle for the stall window is retried (resume offset). This is what
  // stops queued/slow transfers from being re-requested into duplicate serves.
  const sliceAt = (hash) => (window.collabAssetSliceAt ? window.collabAssetSliceAt(hash) : 0);
  const channelActive = window.collabAssetActive ? window.collabAssetActive() : false;
  const inFlight = (hash) => {
    const req = _assetReqAt.get(hash) || 0;
    if (!req) return false;
    if (channelActive) return true;
    return now - Math.max(req, sliceAt(hash)) < ASSET_STALL_MS;
  };

  const viewedId = state.images.length ? state.rankOrder[state.paintIdx] : null;

  // Fill anything already local, and count how many pulls are currently in flight.
  let active = 0;
  for (const e of ordered) {
    if (e.thumbHash && !e.thumbUrl) {
      if (assetStore.has(e.thumbHash)) filled = (await _fillThumbFromStore(e)) || filled;
      else if (inFlight(e.thumbHash)) active++;
    }
    if (e.assetHash && !e.blob) {
      if (assetStore.has(e.assetHash)) filled = (await _fillEntryFromStore(e)) || filled;
      else if (inFlight(e.assetHash)) active++;
    }
  }

  const want = (hash) => {
    if (active >= ASSET_CONCURRENCY || inFlight(hash) || assetStore.has(hash)) return;
    _assetReqAt.set(hash, now);
    active++;
    window.dispatchEvent(new CustomEvent("collab:asset-needed", { detail: { hash } }));
  };
  // Priority: the viewed image's thumb then its full (so navigating to an image fetches IT
  // next, ahead of other images), then everyone else's thumbnails, then their full bytes.
  const viewed = viewedId ? imgById(viewedId) : null;
  if (viewed) {
    if (viewed.thumbHash && !viewed.thumbUrl) want(viewed.thumbHash);
    if (viewed.assetHash && !viewed.blob) want(viewed.assetHash);
  }
  for (const e of ordered) if (e.id !== viewedId && e.thumbHash && !e.thumbUrl) want(e.thumbHash);
  for (const e of ordered) if (e.id !== viewedId && e.assetHash && !e.blob) want(e.assetHash);

  if (filled) _updateLoadingStatus();
}
setInterval(reconcileAssets, 4000);

// Bytes arrived for an asset: store, free its window slot, then reconcile (fills the
// matching entries from the store and pulls the next hash in the window).
window.addEventListener("collab:remote-asset", async ({ detail: { hash, jpegBase64 } }) => {
  const blob = await (await fetch(jpegBase64)).blob();
  if (jpegBase64.startsWith("blob:")) URL.revokeObjectURL(jpegBase64);
  assetStore.set(hash, blob);
  _assetReqAt.delete(hash); // arrived -> free its window slot
  reconcileAssets(); // fill matching entries from the store + pull the next in the window
});

// ── Collaboration remote-event handlers ───────────────────────────────────────

let _collabJoinTotal = 0;
let _collabJoinFullsDone = 0;

// Collab live-sync progress (e.g. uploading added images to peers). Shown on the
// sim-status pill so it's visible while the collab modal is closed. Terminal "Synced"
// messages self-clear; an empty string clears immediately.
window.addEventListener("collab:sync-status", ({ detail: { text } }) => {
  updateSimStatus(text || "");
  // Terminal messages (anything but the live "Syncing k/N" progress) self-clear.
  if (text && !text.startsWith("Syncing")) {
    setTimeout(() => {
      if (simStatusEl.textContent === text) updateSimStatus("");
    }, 4000);
  }
});

window.addEventListener("collab:remote-session", async (e) => {
  await _doImportReplace(e.detail.blob);
});

window.addEventListener("collab:remote-image", async (e) => {
  const { id, name, w, h, jpegBase64, encoding, polygons, simPos, simAngle } = e.detail;
  const buf = await (await fetch(jpegBase64)).arrayBuffer();
  if (jpegBase64.startsWith("blob:")) URL.revokeObjectURL(jpegBase64); // live-add binary path

  const newId = id || newImgId();
  if (imgById(newId)) return; // already have this image (duplicate / echo)
  const newEntry = { id: newId, file: null, bytes: buf, blob: new Blob([buf], { type: "image/jpeg" }), assetHash: null, name, thumbUrl: null, w, h, polygons: polygons || [], currentPoly: [], scale: null, simHidden: false };
  ensureAssetHash(newEntry); // register bytes so this peer can serve them on request
  registerImages([newEntry], { broadcast: false });
  _thumbFallback(newEntry); // thumb-size decode; patches the filmstrip when done

  if (encoding) _restoreEncodings([encoding], [newId]);

  simRefreshGroup(newId);
  if (simPos && simGroups.get(newId)) placeGroup(simGroups.get(newId), simPos.x, simPos.y, simAngle || 0);
  const n = state.images.length;
  updateStepMeta("step-images", imageCountLabel(n), true);
  paintArea.classList.remove("im-hidden");
  unlockStep("step-paint");
});

window.addEventListener("collab:remote-image-removed", ({ detail: { imgIdx } }) => {
  removeImage(imgIdx, { broadcast: false });
});

window.addEventListener("collab:remote-image-meta", ({ detail: { imgIdx, meta } }) => {
  if (meta.simHidden !== undefined) setSimHidden(imgIdx, !!meta.simHidden, { broadcast: false });
});

window.addEventListener("collab:remote-positions", (e) => {
  if (simRafId === null) return;
  const { positions, simX1: rx1, simY1: ry1, simX2: rx2, simY2: ry2 } = e.detail;
  if (rx1 != null) {
    simX1 = rx1;
    simY1 = ry1;
    simX2 = rx2;
    simY2 = ry2;
    _simOutExplicit = true;
    _simViewDirty = true;
  }
  for (const [id, { x, y, angle }] of Object.entries(positions)) {
    const g = simGroups.get(id);
    if (g) placeGroup(g, x, y, angle);
  }
});

window.addEventListener("collab:remote-scales", ({ detail: { scales } }) => {
  setScales(scales, { broadcast: false, keepPreview: true });
  for (const id of Object.keys(scales)) _remoteScalePreview.delete(id); // committed -> drop the live preview
  buildRankList();
});

// ── Sim undo snapshots ──────────────────────────────────────────────────────────
// A snapshot is scoped to what an action changed: the affected images' transforms
// plus, for a resize, the artboard bounds -- so undo in a collab session reverts
// only the object(s) you touched. The stacks live in collaborate.js.
function captureSimSnapshot(imgIdxs, withBounds) {
  const groups = [];
  for (const i of imgIdxs) {
    const g = simGroups.get(i);
    if (g) groups.push({ imgIdx: i, x: g.x, y: g.y, angle: g.angle, scale: imgById(i).scale });
  }
  const snap = { groups };
  if (withBounds) snap.bounds = { x1: simX1, y1: simY1, x2: simX2, y2: simY2 };
  return snap;
}

function recordSimUndo(snap) {
  window.dispatchEvent(new CustomEvent("collab:undo-record", { detail: snap }));
}

// Bounds restore the artboard (auto-scale re-derives, positions preserved);
// listed groups restore their transform exactly.
function applySimSnapshot(snap) {
  if (simRafId === null) return;
  if (snap.bounds) {
    const b = snap.bounds;
    simX1 = b.x1;
    simY1 = b.y1;
    simX2 = b.x2;
    simY2 = b.y2;
    state.outW = Math.round(b.x2 - b.x1);
    state.outH = Math.round(b.y2 - b.y1);
    cfgWidth.value = state.outW;
    cfgHeight.value = state.outH;
    _syncCarouselUI();
    _simOutExplicit = true; // keep these exact bounds; resizeSim refreshes groups
    resizeSim();
  }
  const scales = {};
  for (const s of snap.groups || []) if (imgById(s.imgIdx)) scales[s.imgIdx] = s.scale;
  if (Object.keys(scales).length) setScales(scales); // broadcast: keeps yScales converged after an undo
  for (const s of snap.groups || []) {
    const g = simGroups.get(s.imgIdx);
    if (g) {
      g.x = s.x;
      g.y = s.y;
      g.angle = s.angle;
    }
  }
  _clearMergedImage();
  _simViewDirty = true;
  buildRankList();
}

window.captureSimSnapshot = captureSimSnapshot;
window.applySimSnapshot = applySimSnapshot;
// Live remote scale preview for an image (read-only; for diagnostics / tests).
window.getRemoteScalePreview = (id) => (_remoteScalePreview.has(id) ? _remoteScalePreview.get(id) : null);

window.addEventListener("collab:remote-drag", ({ detail: { imgIdx, x, y, angle, scale } }) => {
  if (simRafId === null) return;
  const g = simGroups.get(imgIdx);
  if (g) placeGroup(g, x, y, angle);
  if (scale != null) {
    _remoteScalePreview.set(imgIdx, scale);
    _simViewDirty = true;
  }
});

window.addEventListener("collab:remote-grab", ({ detail: { imgIdx, color } }) => {
  _remoteGrabs.set(imgIdx, { color });
  _simViewDirty = true;
});

window.addEventListener("collab:remote-release", ({ detail: { imgIdx } }) => {
  _remoteGrabs.delete(imgIdx);
  _remoteScalePreview.delete(imgIdx);
  _simViewDirty = true;
});

window.addEventListener("collab:remote-polygon", ({ detail: { imgIdx, polygons } }) => {
  setPolygons(imgIdx, polygons, { broadcast: false, keepPreview: true });
});

// A presenter's viewport — smoothly track it until the user interacts (any manual
// pan/zoom routes through viewport._apply, which cancels the follow).
window.addEventListener("collab:remote-viewport", ({ detail: { scale, centerX, centerY } }) => {
  if (simRafId === null) return;
  viewport.follow(scale, centerX, centerY);
});

function _restoreEncodings(encodings, ids) {
  if (!encodings) return;
  encodings.forEach((enc, i) => {
    if (!enc) return;
    const id = ids[i];
    if (id == null) return;
    yoloPool.embeddingCache.set(id, {
      origW: enc.origW,
      origH: enc.origH,
      segments: enc.segments.map((s) => ({
        classId: s.classId,
        className: s.className,
        score: s.score,
        bbox: s.bbox,
        maskW: s.maskW,
        maskH: s.maskH,
        mask: Uint8Array.from(atob(s.mask), (c) => c.charCodeAt(0)),
      })),
    });
  });
}

// ── Streaming collab join handlers ────────────────────────────────────────────

function _updateFilmstripThumb(imgIdx) {
  const li = rankList.querySelector('[data-img-idx="' + imgIdx + '"]');
  if (!li) return;
  const imgEl = li.querySelector(".im-rank-thumb");
  if (!imgEl) return;
  const entry = imgById(imgIdx);
  if (entry?.thumbUrl) {
    imgEl.src = entry.thumbUrl;
    imgEl.classList.remove("im-rank-thumb-pending");
  }
}

// Reconnect / late join with local images present: append only the images we don't
// already have (by id) and leave everything we hold untouched. The image-full stream
// that follows populates the new skeletons; already-loaded entries are protected in
// the remote-image-full handler so a re-stream can't clobber local edits.
function _mergeRemoteSessionMeta(meta) {
  const have = new Set(state.images.map((e) => e.id));
  const entries = [];
  const added = [];
  meta.images.forEach((si) => {
    const id = si.id || newImgId();
    if (have.has(id)) return;
    entries.push(_sessionEntry(si, id));
    added.push({ id, simPos: si.simPos, simAngle: si.simAngle || 0 });
  });

  // (Reconnect convergence is handled by the shared membership doc + asset pull now:
  // each peer exchanges full doc state on connect, and missing bytes are pulled by
  // assetHash. No "resend missing images" hack -- that caused a re-stream storm.)
  if (added.length === 0) return; // host's session is a subset of ours -- nothing new to render

  registerImages(entries, { broadcast: false });
  updateStepMeta("step-images", imageCountLabel(state.images.length), true);
  paintArea.classList.remove("im-hidden");
  unlockStep("step-paint");

  for (const { id, simPos, simAngle } of added) {
    simRefreshGroup(id);
    const g = simGroups.get(id);
    if (simPos && g) placeGroup(g, simPos.x, simPos.y, simAngle);
  }
  _simViewDirty = true;

  _collabJoinTotal = meta.imageCount; // host re-streams full images for all of its ids
  _collabJoinFullsDone = 0;
  updateSimStatus("Waiting...");
}

// Reconcile the local image list to the shared membership doc. Builds skeletons for new
// ids (applying each one's polygons + scale from the doc at build time, so a mask that
// arrived before its image is no longer dropped), removes images the doc no longer has,
// and sets rank order. Bytes are pulled by assetHash (reconcileAssets), never streamed.
// Idempotent + order-independent -- safe to run on any remote membership change.
window.applyRemoteMembership = function (snap) {
  const { images, order, polygons, scales } = snap;
  const incoming = new Set(Object.keys(images));

  for (const e of [...state.images]) {
    if (!incoming.has(e.id)) removeImage(e.id, { broadcast: false });
  }

  const fresh = [];
  for (const id of Object.keys(images)) {
    if (imgById(id)) continue;
    const m = images[id];
    fresh.push(_sessionEntry({ ...m, polygons: polygons[id] || [], scale: scales[id] ?? null, scaleFixed: scales[id] != null }, id));
  }
  registerImages(fresh, { broadcast: false });

  // Re-apply masks + scale for every doc image (covers an edit to one we already held,
  // and re-applies a mask that landed before its image).
  // refresh:false -- the placement loop below rebuilds each group once.
  for (const id of Object.keys(images)) {
    if (!imgById(id)) continue;
    if (polygons[id]) setPolygons(id, polygons[id], { broadcast: false, refresh: false });
    if (scales[id] !== undefined) setScale(id, scales[id], { broadcast: false, refresh: false });
    if (images[id].simHidden !== undefined) setSimHidden(id, !!images[id].simHidden, { broadcast: false });
  }

  // registerImages already appended any missing ids; a complete doc order replaces
  // wholesale. Direct assign, not setRankOrder: its keep-the-viewed-image tracking
  // would latch onto whatever id transiently sits at paintIdx mid-reconcile.
  const valid = (order || []).filter((id) => imgById(id));
  if (valid.length === state.images.length) state.rankOrder = valid;

  const n = state.images.length;
  buildRankList();
  updateStepMeta("step-images", n > 0 ? imageCountLabel(n) : "Upload to start", n > 0);
  if (n > 0) {
    paintArea.classList.remove("im-hidden");
    unlockStep("step-paint");
  } else {
    paintArea.classList.add("im-hidden");
    lockStep("step-paint");
  }

  if (simRafId === null && n > 0) initSim();
  if (simRafId !== null) {
    for (const id of Object.keys(images)) {
      simRefreshGroup(id);
      const g = simGroups.get(id);
      const m = images[id];
      if (m.simPos && g) placeGroup(g, m.simPos.x, m.simPos.y, m.simAngle || 0);
    }
  }
  _simViewDirty = true;
  _updateLoadingStatus();
  reconcileAssets(); // pull bytes for any new skeletons now, not on the next 4s tick
};

// Status pill while bytes pull in: "Loading k/N" until every image has its blob.
function _updateLoadingStatus() {
  const total = state.images.length;
  if (total === 0) return;
  const loaded = state.images.filter((e) => e.blob).length;
  if (loaded >= total) {
    const msg = imageCountLabel(total);
    updateSimStatus(msg);
    setTimeout(() => {
      if (simStatusEl.textContent === msg) updateSimStatus("");
    }, 2000);
  } else {
    updateSimStatus("Loading " + loaded + "/" + total);
  }
}

// A join snapshot. `meta.replace` is set only when the host explicitly re-streams an
// imported session; otherwise (first join, reconnect) we must NOT wipe local state --
// a reconnecting guest often holds more/newer images than the host's snapshot.
window.addEventListener("collab:remote-session-meta", ({ detail: meta }) => {
  if (!meta.replace && state.images.length > 0) {
    _mergeRemoteSessionMeta(meta);
    return;
  }
  const n = meta.imageCount;

  state.images = meta.images.map((si) => _sessionEntry(si, si.id || newImgId()));
  state.undoStack = new Map(state.images.map((e) => [e.id, []]));
  state.rankOrder = meta.rankOrder && meta.rankOrder.length ? meta.rankOrder.slice() : state.images.map((e) => e.id);
  state.paintIdx = Math.min(meta.paintIdx || 0, Math.max(0, state.rankOrder.length - 1));

  yoloPool.embeddingCache.clear();
  yoloPool.dots.clear();

  if (window.applyRemoteSettings) window.applyRemoteSettings(meta);

  buildRankList();
  updateStepMeta("step-images", imageCountLabel(n), true);
  if (n > 0) {
    paintArea.classList.remove("im-hidden");
    unlockStep("step-paint");
  }

  const savedPositions = {};
  meta.images.forEach((si, i) => {
    if (si.simPos) savedPositions[state.images[i].id] = { pos: si.simPos, angle: si.simAngle || 0 };
  });
  if (simRafId !== null) teardownSim();
  if (n > 0) initSim(savedPositions);

  // Restore host viewport so guest sees the same view immediately
  if (meta.simViewScale && simRafId !== null) {
    viewport.setView(meta.simViewScale, meta.simViewOffset.x, meta.simViewOffset.y);
  }
  if (meta.simX1 != null) {
    simX1 = meta.simX1;
    simY1 = meta.simY1;
    simX2 = meta.simX2;
    simY2 = meta.simY2;
  }

  _collabJoinTotal = n;
  _collabJoinFullsDone = 0;
  if (n > 0) updateSimStatus("Waiting..."); // masks are up; pixels stream in next
});

window.addEventListener("collab:remote-image-thumb", ({ detail: { imgIdx, thumb } }) => {
  const entry = imgById(imgIdx);
  if (!entry) return;
  entry.thumbUrl = thumb;
  _updateFilmstripThumb(imgIdx);
});

// Fill a skeleton entry (blob:null) with its pixels. Shared by the join re-stream and
// the live-add binary fill. Idempotent: an entry that already has a blob is left alone
// (a re-stream after reconnect must not clobber newer local edits).
async function _populateImageEntry(detail) {
  const { imgIdx, w, h, jpegBase64, assetHash, polygons, currentPoly, scale, simHidden } = detail;
  const entry = imgById(imgIdx);
  if (!entry || entry.blob) {
    if (jpegBase64.startsWith("blob:")) URL.revokeObjectURL(jpegBase64);
    return;
  }
  const buf = await (await fetch(jpegBase64)).arrayBuffer();
  if (jpegBase64.startsWith("blob:")) URL.revokeObjectURL(jpegBase64);
  entry.bytes = buf; // JS-memory source of truth (blob backing can go bad on Android)
  entry.blob = new Blob([buf], { type: "image/jpeg" });
  if (!entry.w && w) entry.w = w;
  if (!entry.h && h) entry.h = h;
  await _thumbFallback(entry); // thumb-size decode (never full-res); retries under pressure
  if (assetHash) entry.assetHash = assetHash;
  ensureAssetHash(entry); // register bytes so this peer can serve them on request
  if (polygons) setPolygons(imgIdx, polygons, { broadcast: false, refresh: false });
  if (currentPoly) entry.currentPoly = currentPoly;
  if (scale != null) setScale(imgIdx, scale, { broadcast: false, refresh: false });
  if (simHidden != null) setSimHidden(imgIdx, !!simHidden, { broadcast: false });
  _updateFilmstripThumb(imgIdx);
  simRefreshGroup(imgIdx); // re-checks merge readiness (via _showMergeBtn)
  _simViewDirty = true;
}

// Live-add skeleton: the image-binary header arrives just before its bytes, so we show
// a pending filmstrip row + sim group immediately (named, correct aspect) instead of a
// blank wait while a large image streams in. remote-image-binary fills it shortly after.
window.addEventListener("collab:remote-image-skeleton", ({ detail }) => {
  const { id, simPos, simAngle } = detail;
  if (!id || imgById(id)) return; // dedup: already have this image (skeleton or full)
  registerImages([_sessionEntry(detail, id)], { broadcast: false });
  updateStepMeta("step-images", imageCountLabel(state.images.length), true);
  paintArea.classList.remove("im-hidden");
  unlockStep("step-paint");
  simRefreshGroup(id);
  const g = simGroups.get(id);
  if (simPos && g) placeGroup(g, simPos.x, simPos.y, simAngle || 0);
  _simViewDirty = true;
});

// Live-add fill: the bytes for an image whose skeleton already landed (see
// remote-image-skeleton). No join-counter / status -- progress is shown sender-side.
window.addEventListener("collab:remote-image-binary", ({ detail }) => _populateImageEntry(detail));

window.addEventListener("collab:remote-image-full", async ({ detail }) => {
  if (!imgById(detail.imgIdx)) return;
  await _populateImageEntry(detail);
  // Status sequence on the guest: Waiting... -> Importing k/N -> the imported count.
  if (++_collabJoinFullsDone >= _collabJoinTotal) {
    loadPainterImage(state.paintIdx);
    const msg = imageCountLabel(_collabJoinTotal);
    updateSimStatus(msg);
    setTimeout(() => {
      if (simStatusEl.textContent === msg) updateSimStatus("");
    }, 3000);
  } else {
    updateSimStatus("Importing " + _collabJoinFullsDone + "/" + _collabJoinTotal);
  }
});

initSim();

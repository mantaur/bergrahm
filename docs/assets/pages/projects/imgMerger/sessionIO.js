/* sessionIO.js — session export / import via ZIP + web worker */

const JSZIP_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

// ── Inline worker ─────────────────────────────────────────────────────────────

function _sessionWorkerBody() {
  const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

  function maskToBase64(mask) {
    let str = '';
    for (let i = 0; i < mask.length; i += 8192)
      str += String.fromCharCode(...mask.subarray(i, i + 8192));
    return btoa(str);
  }

  self.onmessage = async ({ data: msg }) => {
    try {
      if (!self.JSZip) importScripts(CDN);
      if (msg.type === 'export') await doExport(msg);
      if (msg.type === 'import') await doImport(msg);
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  };

  async function doExport({ session, imageBitmaps, encodings }) {
    const zip = new JSZip();

    // Encode all images to JPEG in parallel via OffscreenCanvas (ImageBitmap avoids GPU readback)
    let done = 0;
    const blobBufs = await Promise.all(imageBitmaps.map(async bm => {
      const oc = new OffscreenCanvas(bm.width, bm.height);
      oc.getContext('2d').drawImage(bm, 0, 0);
      bm.close();
      const blob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
      const buf = await blob.arrayBuffer();
      self.postMessage({ type: 'progress', pct: Math.round(++done / imageBitmaps.length * 65) });
      return buf;
    }));
    for (let i = 0; i < blobBufs.length; i++) zip.file('images/' + i + '.jpg', blobBufs[i]);

    // Encode encodings
    for (let i = 0; i < encodings.length; i++) {
      if (!encodings[i]) continue;
      const enc = encodings[i];
      const out = {
        origW: enc.origW, origH: enc.origH,
        segments: enc.segments.map(s => ({
          classId: s.classId, className: s.className, score: s.score, bbox: s.bbox,
          maskW: s.maskW, maskH: s.maskH, mask: maskToBase64(s.mask),
        })),
      };
      zip.file('encodings/' + i + '.json', JSON.stringify(out));
      session.images[i].hasEncoding = true;
    }
    self.postMessage({ type: 'progress', pct: 72 });

    zip.file('session.json', JSON.stringify(session));

    const buf = await zip.generateAsync(
      { type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      meta => self.postMessage({ type: 'progress', pct: 72 + Math.round(meta.percent * 0.28) })
    );
    self.postMessage({ type: 'done', buffer: buf }, [buf]);
  }

  // Stream the session: emit `meta` (config + masks + positions) first so the app
  // can render masks and the filmstrip immediately, then decode + thumbnail each
  // image off the main thread and post them one at a time (`image`), then `done`.
  async function doImport({ buffer }) {
    const zip = await JSZip.loadAsync(buffer);
    const session = JSON.parse(await zip.file('session.json').async('string'));
    const n = session.images.length;
    self.postMessage({ type: 'meta', session });

    for (let i = 0; i < n; i++) {
      const si = session.images[i] || {};
      let bitmap = null, thumbBuf = null, encoding = null;

      const imgFile = zip.file('images/' + i + '.jpg');
      if (imgFile) {
        const blob = new Blob([await imgFile.async('arraybuffer')], { type: 'image/jpeg' });
        bitmap = await createImageBitmap(blob);
        // Thumbnail here (OffscreenCanvas) so the main thread never JPEG-encodes.
        const w  = si.w || bitmap.width, h = si.h || bitmap.height;
        const ts = Math.min(1, 256 / Math.max(w, h));
        const tW = Math.max(1, Math.round(w * ts)), tH = Math.max(1, Math.round(h * ts));
        const oc = new OffscreenCanvas(tW, tH);
        oc.getContext('2d').drawImage(bitmap, 0, 0, tW, tH);
        thumbBuf = await (await oc.convertToBlob({ type: 'image/jpeg', quality: 0.82 })).arrayBuffer();
      }

      const encFile = zip.file('encodings/' + i + '.json');
      if (encFile) encoding = JSON.parse(await encFile.async('string'));

      const transfer = [];
      if (bitmap)   transfer.push(bitmap);
      if (thumbBuf) transfer.push(thumbBuf);
      self.postMessage({ type: 'image', i, bitmap, thumbBuf, encoding }, transfer);
      self.postMessage({ type: 'progress', pct: Math.round((i + 1) / n * 100) });
    }

    self.postMessage({ type: 'done' });
  }
}

let _workerBlobUrl = null;
function _makeSessionWorker() {
  if (!_workerBlobUrl) {
    const src = '(' + _sessionWorkerBody.toString() + ')();';
    _workerBlobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  }
  return new Worker(_workerBlobUrl);
}

// ── Public API ────────────────────────────────────────────────────────────────

const SessionIO = {

  // exportData: { state, simGroups, yoloPool, cfg: { blendMode, seed, ditherExp, slides, useYolo } }
  // onProgress: (pct, text) => void
  export(exportData, onProgress) {
    return this.exportBlob(exportData, onProgress).then(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'merger-session.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    });
  },

  // Same as export() but resolves with Blob instead of triggering a download.
  async exportBlob(exportData, onProgress) {
    const { state, simGroups, yoloPool, cfg } = exportData;

    // createImageBitmap is fast (wraps the already-decoded GPU texture) and transferable,
    // avoiding a synchronous GPU->CPU readback for each image on the main thread.
    const imageBitmaps = await Promise.all(
      state.images.map(entry => createImageBitmap(entry.img))
    );

    const session = {
      version: 2,
      outW: state.outW, outH: state.outH,
      fillColor: state.fillColor,
      blendMode: cfg.blendMode,
      seed: cfg.seed, ditherExp: cfg.ditherExp, slides: cfg.slides, useYolo: cfg.useYolo,

      rankOrder: state.rankOrder.slice(),
      paintIdx: state.paintIdx,
      simViewScale: cfg.simViewScale,
      simViewOffset: { x: cfg.simViewOffset.x, y: cfg.simViewOffset.y },
      simX1: cfg.simX1, simY1: cfg.simY1,
      simX2: cfg.simX2, simY2: cfg.simY2,
      images: state.images.map((entry, i) => {
        const g = simGroups.get(entry.id);
        return {
          id: entry.id,
          name: entry.name, w: entry.w, h: entry.h,
          scale: entry.scale, scaleFixed: entry.scaleFixed || false,
          simHidden: entry.simHidden || false,
          polygons: entry.polygons, currentPoly: entry.currentPoly || [],
          simPos: g ? { x: g.x, y: g.y } : null,
          simAngle: g ? g.angle : 0,
          hasEncoding: false,
        };
      }),
    };

    const encodings = state.images.map((entry) => {
      const cached = yoloPool.embeddingCache.get(entry.id);
      if (!cached) return null;
      return {
        origW: cached.origW, origH: cached.origH,
        segments: cached.segments.map(s => ({
          classId: s.classId, className: s.className, score: s.score,
          bbox: s.bbox, maskW: s.maskW, maskH: s.maskH, mask: s.mask,
        })),
      };
    });

    return new Promise((resolve, reject) => {
      const worker = _makeSessionWorker();
      worker.onmessage = ({ data: msg }) => {
        if (msg.type === 'progress') onProgress(msg.pct, 'Exporting... ' + msg.pct + '%');
        if (msg.type === 'done') {
          worker.terminate();
          resolve(new Blob([msg.buffer], { type: 'application/zip' }));
        }
        if (msg.type === 'error') { worker.terminate(); reject(new Error(msg.message)); }
      };
      worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'Worker error')); };
      worker.postMessage({ type: 'export', session, imageBitmaps, encodings }, imageBitmaps);
    });
  },

  // Streaming import. Fires onMeta(session) once (config + masks + positions),
  // then onImage(i, { bitmap, thumbBuf, encoding }) per image as each is decoded
  // off-thread, then resolves on done. onProgress(pct) is the per-image count.
  importStream(file, { onMeta, onImage, onProgress } = {}) {
    return file.arrayBuffer().then(buffer => new Promise((resolve, reject) => {
      const worker = _makeSessionWorker();
      worker.onmessage = ({ data: msg }) => {
        if (msg.type === 'meta')     { if (onMeta) onMeta(msg.session); }
        else if (msg.type === 'image')    { if (onImage) onImage(msg.i, msg); }
        else if (msg.type === 'progress') { if (onProgress) onProgress(msg.pct); }
        else if (msg.type === 'done')     { worker.terminate(); resolve(); }
        else if (msg.type === 'error')    { worker.terminate(); reject(new Error(msg.message)); }
      };
      worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'Worker error')); };
      worker.postMessage({ type: 'import', buffer }, [buffer]);
    }));
  },
};

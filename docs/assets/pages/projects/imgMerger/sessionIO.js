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

  async function doImport({ buffer }) {
    const zip = await JSZip.loadAsync(buffer);
    const session = JSON.parse(await zip.file('session.json').async('string'));
    const n = session.images.length;

    let done = 0;
    const [imageBuffers, encodings] = await Promise.all([
      Promise.all(Array.from({ length: n }, (_, i) => {
        const f = zip.file('images/' + i + '.jpg');
        if (!f) return Promise.resolve(null);
        return f.async('arraybuffer').then(buf => {
          self.postMessage({ type: 'progress', pct: Math.round(++done / n * 75) });
          return buf;
        });
      })),
      Promise.all(Array.from({ length: n }, (_, i) => {
        const f = zip.file('encodings/' + i + '.json');
        return f ? f.async('string').then(s => JSON.parse(s)) : Promise.resolve(null);
      })),
    ]);
    self.postMessage({ type: 'progress', pct: 95 });

    const transfers = imageBuffers.filter(Boolean);
    self.postMessage({ type: 'done', session, imageBuffers, encodings }, transfers);
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function _base64ToMask(b64) {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ── Public API ────────────────────────────────────────────────────────────────

const SessionIO = {

  // exportData: { state, simGroups, yoloPool, cfg: { blendMode, seed, ditherExp, useScaleRange } }
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
      seed: cfg.seed, ditherExp: cfg.ditherExp,
      useScaleRange: cfg.useScaleRange,
      minScale: state.minScale, maxScale: state.maxScale,

      rankOrder: state.rankOrder.slice(),
      paintIdx: state.paintIdx,
      simViewScale: cfg.simViewScale,
      simViewOffset: { x: cfg.simViewOffset.x, y: cfg.simViewOffset.y },
      simX1: cfg.simX1, simY1: cfg.simY1,
      simX2: cfg.simX2, simY2: cfg.simY2,
      images: state.images.map((entry, i) => {
        const g = simGroups[i];
        return {
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

    const encodings = state.images.map((_, i) => {
      const cached = yoloPool.embeddingCache.get(i);
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

  // Returns Promise<{ session, imgs: HTMLImageElement[], encodings: Array<Object|null> }>
  import(file, onProgress) {
    return file.arrayBuffer().then(buffer => new Promise((resolve, reject) => {
      const worker = _makeSessionWorker();
      worker.onmessage = ({ data: msg }) => {
        if (msg.type === 'progress') onProgress(msg.pct, 'Importing... ' + msg.pct + '%');
        if (msg.type === 'done') {
          worker.terminate();
          const { session, imageBuffers, encodings } = msg;
          const imgPromises = imageBuffers.map(buf => {
            if (!buf) return Promise.resolve(null);
            return new Promise(res => {
              const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
              const img = new Image();
              img.onload = () => { URL.revokeObjectURL(url); res(img); };
              img.onerror = () => { URL.revokeObjectURL(url); res(null); };
              img.src = url;
            });
          });
          Promise.all(imgPromises).then(imgs => {
            onProgress(100, 'Done');
            resolve({ session, imgs, encodings });
          });
        }
        if (msg.type === 'error') { worker.terminate(); reject(new Error(msg.message)); }
      };
      worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'Worker error')); };
      worker.postMessage({ type: 'import', buffer }, [buffer]);
    }));
  },
};

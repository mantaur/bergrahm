/* sessionIO.js — session export / import via ZIP + web worker */

const JSZIP_CDN = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

// ── Inline worker ─────────────────────────────────────────────────────────────

function _sessionWorkerBody() {
  const CDN = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

  function maskToBase64(mask) {
    let str = "";
    for (let i = 0; i < mask.length; i += 8192) str += String.fromCharCode(...mask.subarray(i, i + 8192));
    return btoa(str);
  }

  self.onmessage = async ({ data: msg }) => {
    try {
      if (!self.JSZip) importScripts(CDN);
      if (msg.type === "export") await doExport(msg);
      if (msg.type === "import") await doImport(msg);
    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }
  };

  async function doExport({ session, imageBufs, encodings }) {
    const zip = new JSZip();

    // Decode + re-encode one image at a time so export never holds all decoded at once.
    for (let i = 0; i < imageBufs.length; i++) {
      const bm = await createImageBitmap(new Blob([imageBufs[i]]));
      const oc = new OffscreenCanvas(bm.width, bm.height);
      oc.getContext("2d").drawImage(bm, 0, 0);
      bm.close();
      const blob = await oc.convertToBlob({ type: "image/jpeg", quality: 0.92 });
      zip.file("images/" + i + ".jpg", await blob.arrayBuffer());
      self.postMessage({ type: "progress", pct: Math.round(((i + 1) / imageBufs.length) * 65) });
    }

    // Encode encodings
    for (let i = 0; i < encodings.length; i++) {
      if (!encodings[i]) continue;
      const enc = encodings[i];
      const out = {
        origW: enc.origW,
        origH: enc.origH,
        segments: enc.segments.map((s) => ({
          classId: s.classId,
          className: s.className,
          score: s.score,
          bbox: s.bbox,
          maskW: s.maskW,
          maskH: s.maskH,
          mask: maskToBase64(s.mask),
        })),
      };
      zip.file("encodings/" + i + ".json", JSON.stringify(out));
      session.images[i].hasEncoding = true;
    }
    self.postMessage({ type: "progress", pct: 72 });

    zip.file("session.json", JSON.stringify(session));

    const buf = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }, (meta) => self.postMessage({ type: "progress", pct: 72 + Math.round(meta.percent * 0.28) }));
    self.postMessage({ type: "done", buffer: buf }, [buf]);
  }

  // Stream the session: emit `meta` (config + masks + positions) first so the app
  // can render masks and the filmstrip immediately, then decode + thumbnail each
  // image off the main thread and post them one at a time (`image`), then `done`.
  async function doImport({ buffer }) {
    const zip = await JSZip.loadAsync(buffer);
    const session = JSON.parse(await zip.file("session.json").async("string"));
    const n = session.images.length;
    self.postMessage({ type: "meta", session });

    for (let i = 0; i < n; i++) {
      const si = session.images[i] || {};
      let jpegBuf = null,
        thumbBuf = null,
        encoding = null,
        w = si.w,
        h = si.h;

      const imgFile = zip.file("images/" + i + ".jpg");
      if (imgFile) {
        jpegBuf = await imgFile.async("arraybuffer"); // kept compressed; decoded on demand
        const blob = new Blob([jpegBuf], { type: "image/jpeg" });
        if (!w || !h) {
          const full = await createImageBitmap(blob);
          w = full.width;
          h = full.height;
          full.close();
        }
        // Thumbnail decoded straight to target size off-thread (no full-res bitmap kept).
        const ts = Math.min(1, 256 / Math.max(w, h));
        const tW = Math.max(1, Math.round(w * ts)),
          tH = Math.max(1, Math.round(h * ts));
        const tbm = await createImageBitmap(blob, { resizeWidth: tW, resizeHeight: tH, resizeQuality: "medium" });
        const oc = new OffscreenCanvas(tW, tH);
        oc.getContext("2d").drawImage(tbm, 0, 0);
        tbm.close();
        thumbBuf = await (await oc.convertToBlob({ type: "image/jpeg", quality: 0.82 })).arrayBuffer();
      }

      const encFile = zip.file("encodings/" + i + ".json");
      if (encFile) encoding = JSON.parse(await encFile.async("string"));

      const transfer = [];
      if (jpegBuf) transfer.push(jpegBuf);
      if (thumbBuf) transfer.push(thumbBuf);
      self.postMessage({ type: "image", i, jpegBuf, thumbBuf, encoding, w, h }, transfer);
      self.postMessage({ type: "progress", pct: Math.round(((i + 1) / n) * 100) });
    }

    self.postMessage({ type: "done" });
  }
}

let _workerBlobUrl = null;
function _makeSessionWorker() {
  if (!_workerBlobUrl) {
    const src = "(" + _sessionWorkerBody.toString() + ")();";
    _workerBlobUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  }
  return new Worker(_workerBlobUrl);
}

// ── Public API ────────────────────────────────────────────────────────────────

const SessionIO = {
  // exportData: { state, simGroups, yoloPool, cfg: { blendMode, seed, ditherExp, slides, useYolo } }
  // onProgress: (pct, text) => void
  export(exportData, onProgress) {
    return this.exportBlob(exportData, onProgress).then((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "merger-session.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    });
  },

  // Same as export() but resolves with Blob instead of triggering a download.
  async exportBlob(exportData, onProgress) {
    const { state, simGroups, yoloPool, cfg } = exportData;

    // Hand the worker the compressed bytes (transferred, zero-copy); it decodes +
    // re-encodes them sequentially, so export never holds all images decoded at once.
    const imageBufs = await Promise.all(state.images.map((e) => e.blob.arrayBuffer()));

    const session = {
      version: 2,
      outW: state.outW,
      outH: state.outH,
      fillColor: state.fillColor,
      blendMode: cfg.blendMode,
      seed: cfg.seed,
      ditherExp: cfg.ditherExp,
      slides: cfg.slides,
      useYolo: cfg.useYolo,

      rankOrder: state.rankOrder.slice(),
      paintIdx: state.paintIdx,
      simViewScale: cfg.simViewScale,
      simViewOffset: { x: cfg.simViewOffset.x, y: cfg.simViewOffset.y },
      simX1: cfg.simX1,
      simY1: cfg.simY1,
      simX2: cfg.simX2,
      simY2: cfg.simY2,
      images: state.images.map((entry, i) => {
        const g = simGroups.get(entry.id);
        return {
          id: entry.id,
          name: entry.name,
          w: entry.w,
          h: entry.h,
          scale: entry.scale,
          scaleFixed: entry.scaleFixed || false,
          simHidden: entry.simHidden || false,
          polygons: entry.polygons,
          currentPoly: entry.currentPoly || [],
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
        origW: cached.origW,
        origH: cached.origH,
        segments: cached.segments.map((s) => ({
          classId: s.classId,
          className: s.className,
          score: s.score,
          bbox: s.bbox,
          maskW: s.maskW,
          maskH: s.maskH,
          mask: s.mask,
        })),
      };
    });

    return new Promise((resolve, reject) => {
      const worker = _makeSessionWorker();
      worker.onmessage = ({ data: msg }) => {
        if (msg.type === "progress") onProgress(msg.pct, "Exporting... " + msg.pct + "%");
        if (msg.type === "done") {
          worker.terminate();
          resolve(new Blob([msg.buffer], { type: "application/zip" }));
        }
        if (msg.type === "error") {
          worker.terminate();
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (e) => {
        worker.terminate();
        reject(new Error(e.message || "Worker error"));
      };
      worker.postMessage({ type: "export", session, imageBufs, encodings }, imageBufs);
    });
  },

  // Streaming import. Fires onMeta(session) once (config + masks + positions),
  // then onImage(i, { bitmap, thumbBuf, encoding }) per image as each is decoded
  // off-thread, then resolves on done. onProgress(pct) is the per-image count.
  importStream(file, { onMeta, onImage, onProgress } = {}) {
    return file.arrayBuffer().then(
      (buffer) =>
        new Promise((resolve, reject) => {
          const worker = _makeSessionWorker();
          worker.onmessage = ({ data: msg }) => {
            if (msg.type === "meta") {
              if (onMeta) onMeta(msg.session);
            } else if (msg.type === "image") {
              if (onImage) onImage(msg.i, msg);
            } else if (msg.type === "progress") {
              if (onProgress) onProgress(msg.pct);
            } else if (msg.type === "done") {
              worker.terminate();
              resolve();
            } else if (msg.type === "error") {
              worker.terminate();
              reject(new Error(msg.message));
            }
          };
          worker.onerror = (e) => {
            worker.terminate();
            reject(new Error(e.message || "Worker error"));
          };
          worker.postMessage({ type: "import", buffer }, [buffer]);
        }),
    );
  },
};

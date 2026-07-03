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

  // JPEG/PNG bytes zip as-is: no re-encode quality loss, no 32MP decode spike.
  function isPassthroughImage(buf) {
    const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    return (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47);
  }

  async function doExport({ session, imageBufs, encodings }) {
    const zip = new JSZip();

    // One image at a time; STORE (DEFLATE over JPEG wastes CPU and memory).
    for (let i = 0; i < imageBufs.length; i++) {
      let out = imageBufs[i];
      if (!isPassthroughImage(out)) {
        const bm = await createImageBitmap(new Blob([out]));
        const oc = new OffscreenCanvas(bm.width, bm.height);
        oc.getContext("2d").drawImage(bm, 0, 0);
        bm.close();
        out = await (await oc.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer();
      }
      zip.file("images/" + i + ".jpg", out, { compression: "STORE" });
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

  // ImageDecoder first (no Blob, dodges Android's unreliable blob storage),
  // transient Blob + createImageBitmap where unavailable.
  async function decodeScaled(buf, tW, tH) {
    const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    const type = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "image/jpeg" : b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? "image/png" : null;
    if (type && typeof ImageDecoder !== "undefined") {
      try {
        const dec = new ImageDecoder({ data: buf, type, desiredWidth: tW, desiredHeight: tH });
        try {
          const { image } = await dec.decode();
          try {
            return await createImageBitmap(image, { resizeWidth: tW, resizeHeight: tH, resizeQuality: "medium" });
          } finally {
            image.close();
          }
        } finally {
          dec.close();
        }
      } catch (err) {
        /* fall through to the blob path */
      }
    }
    return createImageBitmap(new Blob([buf], { type: "image/jpeg" }), { resizeWidth: tW, resizeHeight: tH, resizeQuality: "medium" });
  }

  // Thumbnail decoded straight to target size (no full-res bitmap kept).
  async function thumbFromBuf(buf, w, h) {
    const ts = Math.min(1, 256 / Math.max(w, h));
    const tW = Math.max(1, Math.round(w * ts)),
      tH = Math.max(1, Math.round(h * ts));
    const tbm = await decodeScaled(buf, tW, tH);
    const oc = new OffscreenCanvas(tW, tH);
    oc.getContext("2d").drawImage(tbm, 0, 0);
    tbm.close();
    return (await oc.convertToBlob({ type: "image/jpeg", quality: 0.82 })).arrayBuffer();
  }

  // Stream the session: emit `meta` (config + masks + positions) first so the app
  // can render masks and the filmstrip immediately, then decode + thumbnail each
  // image off the main thread and post them one at a time (`image`), then `done`.
  async function doImport({ buffer }) {
    const zip = await JSZip.loadAsync(buffer);
    const session = JSON.parse(await zip.file("session.json").async("string"));
    const n = session.images.length;
    self.postMessage({ type: "meta", session });

    const retryThumbs = [];
    const retryBytes = [];
    for (let i = 0; i < n; i++) {
      const si = session.images[i] || {};
      let jpegBuf = null,
        thumbBuf = null,
        encoding = null,
        w = si.w,
        h = si.h;

      const imgFile = zip.file("images/" + i + ".jpg");
      if (imgFile) {
        try {
          jpegBuf = await imgFile.async("arraybuffer"); // kept compressed; decoded on demand
        } catch (err) {
          jpegBuf = null; // OOM inflate or corrupt entry; retried after the stream
          retryBytes.push(i);
          self.postMessage({ type: "log", msg: "inflate " + i + ": " + err.message });
        }
      }
      if (jpegBuf) {
        // A failed decode must not abort the import: ship the bytes thumb-less
        // and retry after the stream.
        try {
          if (!w || !h) {
            const full = await createImageBitmap(new Blob([jpegBuf], { type: "image/jpeg" }));
            w = full.width;
            h = full.height;
            full.close();
          }
          thumbBuf = await thumbFromBuf(jpegBuf, w, h);
        } catch (err) {
          thumbBuf = null;
          retryThumbs.push(i);
          self.postMessage({ type: "log", msg: "thumb " + i + ": " + err.message });
        }
      }

      const encFile = zip.file("encodings/" + i + ".json");
      if (encFile) {
        try {
          encoding = JSON.parse(await encFile.async("string"));
        } catch (err) {
          encoding = null; // a broken encoding is recomputable; never abort for it
        }
      }

      const transfer = [];
      if (jpegBuf) transfer.push(jpegBuf);
      if (thumbBuf) transfer.push(thumbBuf);
      self.postMessage({ type: "image", i, jpegBuf, thumbBuf, encoding, w, h }, transfer);
      self.postMessage({ type: "progress", pct: Math.round(((i + 1) / n) * 100) });
    }

    // Second pass: per-image transients are gone, so starved inflates/decodes
    // usually succeed now.
    for (const i of retryBytes) {
      try {
        const jpegBuf = await zip.file("images/" + i + ".jpg").async("arraybuffer");
        const si = session.images[i] || {};
        let w = si.w,
          h = si.h,
          thumbBuf = null;
        try {
          if (!w || !h) {
            const full = await createImageBitmap(new Blob([jpegBuf], { type: "image/jpeg" }));
            w = full.width;
            h = full.height;
            full.close();
          }
          thumbBuf = await thumbFromBuf(jpegBuf, w, h);
        } catch (err) {
          thumbBuf = null; // bytes still land; the app thumbs later
        }
        const transfer = [jpegBuf];
        if (thumbBuf) transfer.push(thumbBuf);
        self.postMessage({ type: "image", i, jpegBuf, thumbBuf, encoding: null, w, h, retry: true }, transfer);
      } catch (err) {
        self.postMessage({ type: "log", msg: "retry-bytes " + i + ": " + err.message }); // genuinely unreadable
      }
    }
    for (const i of retryThumbs) {
      try {
        const buf = await zip.file("images/" + i + ".jpg").async("arraybuffer");
        let { w, h } = session.images[i] || {};
        if (!w || !h) {
          const full = await createImageBitmap(new Blob([buf], { type: "image/jpeg" }));
          w = full.width;
          h = full.height;
          full.close();
        }
        const thumbBuf = await thumbFromBuf(buf, w, h);
        self.postMessage({ type: "thumb", i, thumbBuf, w, h }, [thumbBuf]);
      } catch (err) {
        self.postMessage({ type: "log", msg: "retry-thumb " + i + ": " + err.message }); // _thumbFallback keeps trying
      }
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

    // Still-transferring entries cannot be exported; fail with names, not a crash.
    const missing = state.images.filter((e) => !e.blob && !e.bytes).map((e) => e.name || e.id);
    if (missing.length) {
      throw new Error(missing.length + " image(s) still transferring: " + missing.slice(0, 3).join(", ") + (missing.length > 3 ? ", ..." : ""));
    }

    // bytes preferred (blob backing can go unreadable on Android), copied because
    // the postMessage transfer would otherwise detach the resident buffer.
    const imageBufs = await Promise.all(state.images.map((e) => (e.bytes ? e.bytes.slice(0) : e.blob.arrayBuffer())));

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
  importStream(file, { onMeta, onImage, onThumb, onLog, onProgress } = {}) {
    return file.arrayBuffer().then(
      (buffer) =>
        new Promise((resolve, reject) => {
          const worker = _makeSessionWorker();
          worker.onmessage = ({ data: msg }) => {
            if (msg.type === "meta") {
              if (onMeta) onMeta(msg.session);
            } else if (msg.type === "image") {
              if (onImage) onImage(msg.i, msg);
            } else if (msg.type === "thumb") {
              if (onThumb) onThumb(msg.i, msg);
            } else if (msg.type === "log") {
              if (onLog) onLog(msg.msg);
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

/* samWorker.js — YOLO11n-seg encode worker (stateless)
 * Runs YOLO segmentation on each image and returns all detected segments.
 * Decode (click-to-mask lookup) is handled on the main thread — no decode
 * message is sent to this worker.
 */

const ORT_CDN   = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js';
const ORT_WASM  = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
const MODEL_URL = 'https://huggingface.co/mantaur/yolo11n-seg/resolve/main/yolo11n-seg.onnx';

const CONF_THRESH = 0.25;
const IOU_THRESH  = 0.45;
const MAX_DET     = 20;
const COCO_NAMES  = [
  'person','bicycle','car','motorcycle','airplane','bus','train','truck','boat',
  'traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat',
  'dog','horse','sheep','cow','elephant','bear','zebra','giraffe','backpack',
  'umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball',
  'kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket',
  'bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple',
  'sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair',
  'couch','potted plant','bed','dining table','toilet','tv','laptop','mouse',
  'remote','keyboard','cell phone','microwave','oven','toaster','sink',
  'refrigerator','book','clock','vase','scissors','teddy bear','hair drier',
  'toothbrush',
];

let session = null;

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'init')   await doInit();
  if (msg.type === 'encode') await doEncode(msg);
};

async function doInit() {
  try {
    if (!self.ort) importScripts(ORT_CDN);
    const ort = self.ort;
    ort.env.wasm.wasmPaths  = ORT_WASM;
    ort.env.wasm.numThreads = 1;

    const useWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;

    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error('Model fetch failed: ' + res.status);
    const total  = parseInt(res.headers.get('content-length') || '0');
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total > 0)
        self.postMessage({ type: 'progress', text: 'YOLO model ' + Math.round(received / total * 100) + '%' });
    }
    const buf = new Uint8Array(received);
    let pos = 0;
    for (const c of chunks) { buf.set(c, pos); pos += c.length; }

    session = await ort.InferenceSession.create(buf.buffer, {
      executionProviders: useWebGPU ? ['webgpu', 'wasm'] : ['wasm'],
    });

    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
}

// Letterbox resize to 640x640, normalize 0-1, RGBA HWC -> RGB CHW.
function preprocessImage(pixels, width, height) {
  const scale = Math.min(640 / width, 640 / height);
  const newW  = Math.round(width  * scale);
  const newH  = Math.round(height * scale);
  const padX  = Math.floor((640 - newW) / 2);
  const padY  = Math.floor((640 - newH) / 2);

  const canvas = new OffscreenCanvas(640, 640);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, 640, 640);
  const src = new OffscreenCanvas(width, height);
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  ctx.drawImage(src, padX, padY, newW, newH);

  const rgba = ctx.getImageData(0, 0, 640, 640).data;
  const N = 640 * 640;
  const chw = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    chw[i]         = rgba[i * 4]     / 255;
    chw[N + i]     = rgba[i * 4 + 1] / 255;
    chw[2 * N + i] = rgba[i * 4 + 2] / 255;
  }
  return { chw, scale, padX, padY };
}

function boxIou([ax1, ay1, ax2, ay2], [bx1, by1, bx2, by2]) {
  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (!inter) return 0;
  return inter / ((ax2-ax1)*(ay2-ay1) + (bx2-bx1)*(by2-by1) - inter);
}

// Per-class NMS, returns top MAX_DET detections sorted by score.
function nms(candidates) {
  const byClass = {};
  for (const d of candidates)
    (byClass[d.classId] = byClass[d.classId] || []).push(d);

  const keep = [];
  for (const cls of Object.values(byClass)) {
    cls.sort((a, b) => b.score - a.score);
    const suppressed = new Uint8Array(cls.length);
    for (let i = 0; i < cls.length; i++) {
      if (suppressed[i]) continue;
      keep.push(cls[i]);
      for (let j = i + 1; j < cls.length; j++)
        if (!suppressed[j] && boxIou(cls[i].box640, cls[j].box640) > IOU_THRESH)
          suppressed[j] = 1;
    }
  }
  return keep.sort((a, b) => b.score - a.score).slice(0, MAX_DET);
}

async function doEncode({ imgIdx, pixels, width, height }) {
  try {
    const ort = self.ort;
    const { chw, scale, padX, padY } = preprocessImage(pixels, width, height);

    const results = await session.run({
      images: new ort.Tensor('float32', chw, [1, 3, 640, 640]),
    });

    // output0: [1,116,8400]  — 4 box + 80 cls + 32 mask coeffs per detection
    // output1: [1,32,160,160] — prototype masks
    const det   = results.output0.data;
    const proto = results.output1.data;

    // Parse candidates
    const candidates = [];
    for (let i = 0; i < 8400; i++) {
      let maxScore = 0, classId = 0;
      for (let c = 0; c < 80; c++) {
        const s = det[(4 + c) * 8400 + i];
        if (s > maxScore) { maxScore = s; classId = c; }
      }
      if (maxScore < CONF_THRESH) continue;

      const cx = det[0 * 8400 + i], cy = det[1 * 8400 + i];
      const bw = det[2 * 8400 + i], bh = det[3 * 8400 + i];
      const box640 = [
        Math.max(0, cx - bw / 2), Math.max(0, cy - bh / 2),
        Math.min(640, cx + bw / 2), Math.min(640, cy + bh / 2),
      ];
      const coeffs = new Float32Array(32);
      for (let k = 0; k < 32; k++) coeffs[k] = det[(84 + k) * 8400 + i];
      candidates.push({ classId, score: maxScore, box640, coeffs });
    }

    const dets = nms(candidates);

    const DECODE_SIZE = 512;
    const capScale = Math.min(1, DECODE_SIZE / Math.max(height, width));
    const outW = Math.round(width  * capScale);
    const outH = Math.round(height * capScale);
    const PROTO_SZ = 160 * 160;

    const segments  = [];
    const transfers = [];

    for (const d of dets) {
      // Dot product with proto at 160x160 (cache-friendly: outer loop over k)
      const dot = new Float32Array(PROTO_SZ);
      for (let k = 0; k < 32; k++) {
        const c = d.coeffs[k];
        if (c === 0) continue;
        const off = k * PROTO_SZ;
        for (let p = 0; p < PROTO_SZ; p++) dot[p] += c * proto[off + p];
      }

      const [bx1, by1, bx2, by2] = d.box640;
      const mask = new Uint8Array(outW * outH);

      for (let oy = 0; oy < outH; oy++) {
        for (let ox = 0; ox < outW; ox++) {
          // Output pixel → original image → letterbox input → proto coords
          const lx = (ox / capScale) * scale + padX;
          const ly = (oy / capScale) * scale + padY;
          if (lx < bx1 || lx > bx2 || ly < by1 || ly > by2) continue;
          const px = Math.min(159, Math.floor(lx / 4));
          const py = Math.min(159, Math.floor(ly / 4));
          if (dot[py * 160 + px] > 0) mask[oy * outW + ox] = 1;
        }
      }

      // Convert box to original image coords
      const bbox = [
        Math.max(0,      Math.round((bx1 - padX) / scale)),
        Math.max(0,      Math.round((by1 - padY) / scale)),
        Math.min(width,  Math.round((bx2 - padX) / scale)),
        Math.min(height, Math.round((by2 - padY) / scale)),
      ];

      segments.push({ classId: d.classId, className: COCO_NAMES[d.classId],
                      score: d.score, bbox, mask, maskW: outW, maskH: outH });
      transfers.push(mask.buffer);
    }

    self.postMessage({ type: 'encoded', imgIdx, segments, origW: width, origH: height }, transfers);
  } catch (err) {
    self.postMessage({ type: 'error', message: 'Encode: ' + err.message });
  }
}

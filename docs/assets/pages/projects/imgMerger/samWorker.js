/* samWorker.js — MobileSAM via onnxruntime-web (stateless)
 * Uses Qualcomm's ONNX export of MobileSAM hosted on HuggingFace.
 * Workers are stateless between jobs. Encode serializes embeddings back to
 * the main thread for caching; any worker can decode any cached image.
 */

const ORT_CDN    = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js';
const ORT_WASM   = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
const MODEL_BASE = 'https://huggingface.co/mantaur/mobile-sam-onnx/resolve/main/';

let encoderSession = null, decoderSession = null;

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'init')   await doInit();
  if (msg.type === 'encode') await doEncode(msg);
  if (msg.type === 'decode') await doDecode(msg);
};

async function fetchWithProgress(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(label + ' fetch failed: HTTP ' + res.status);
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
      self.postMessage({ type: 'progress', text: label + ' ' + Math.round(received / total * 100) + '%' });
  }
  const out = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out.buffer;
}

async function doInit() {
  try {
    if (!self.ort) importScripts(ORT_CDN);
    const ort = self.ort;
    ort.env.wasm.wasmPaths  = ORT_WASM;
    ort.env.wasm.numThreads = 1;

    const [encOnnx, encData, decOnnx, decData] = await Promise.all([
      fetchWithProgress(MODEL_BASE + 'encoder.onnx', 'encoder graph'),
      fetchWithProgress(MODEL_BASE + 'encoder.data', 'encoder weights'),
      fetchWithProgress(MODEL_BASE + 'decoder.onnx', 'decoder graph'),
      fetchWithProgress(MODEL_BASE + 'decoder.data', 'decoder weights'),
    ]);

    encoderSession = await ort.InferenceSession.create(encOnnx, {
      executionProviders: ['wasm'],
      externalData: [{ path: 'encoder.data', data: encData }],
    });
    decoderSession = await ort.InferenceSession.create(decOnnx, {
      executionProviders: ['wasm'],
      externalData: [{ path: 'decoder.data', data: decData }],
    });

    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
}

// SAM preprocessing: resize longest edge to 1024, pad to 1024x1024 (top-left),
// normalise with ImageNet mean/std, convert RGBA HWC -> RGB CHW float32.
function preprocessImage(pixels, width, height) {
  const scale = 1024 / Math.max(width, height);
  const newW  = Math.round(width  * scale);
  const newH  = Math.round(height * scale);

  const padded = new OffscreenCanvas(1024, 1024);
  const pCtx   = padded.getContext('2d');
  const src    = new OffscreenCanvas(width, height);
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  pCtx.drawImage(src, 0, 0, newW, newH);

  const rgba = pCtx.getImageData(0, 0, 1024, 1024).data;
  const mean = [123.675, 116.28,  103.53];
  const std  = [58.395,  57.12,   57.375];
  const N    = 1024 * 1024;
  const chw  = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    chw[i]         = (rgba[i * 4]     - mean[0]) / std[0];
    chw[N + i]     = (rgba[i * 4 + 1] - mean[1]) / std[1];
    chw[2 * N + i] = (rgba[i * 4 + 2] - mean[2]) / std[2];
  }
  return { chw, scale, newW, newH };
}

async function doEncode({ imgIdx, pixels, width, height }) {
  try {
    const ort = self.ort;
    const { chw, scale, newW, newH } = preprocessImage(pixels, width, height);

    const { image_embeddings } = await encoderSession.run({
      image: new ort.Tensor('float32', chw, [1, 3, 1024, 1024]),
    });

    const buf = image_embeddings.data.buffer.slice(0);
    self.postMessage({
      type: 'encoded', imgIdx,
      embeddings: { data: buf, dims: Array.from(image_embeddings.dims) },
      scale, newW, newH, origW: width, origH: height,
    }, [buf]);
  } catch (err) {
    self.postMessage({ type: 'error', message: 'Encode: ' + err.message });
  }
}

async function doDecode({ imgIdx, x, y, decodeSize, embeddings, scale, origW, origH }) {
  try {
    const ort = self.ort;

    const { masks } = await decoderSession.run({
      image_embeddings: new ort.Tensor('float32', new Float32Array(embeddings.data), embeddings.dims),
      point_coords:     new ort.Tensor('float32', new Float32Array([x * scale, y * scale]), [1, 1, 2]),
      point_labels:     new ort.Tensor('float32', new Float32Array([1]),                    [1, 1]),
    });

    // masks: Float32 logits [1,1,256,256] in 1024x1024 encoder space (stride 4).
    // Sample into a capped-resolution output in original image coords.
    const rawMask  = masks.data;
    const capScale = Math.min(1, decodeSize / Math.max(origH, origW));
    const outW     = Math.round(origW * capScale);
    const outH     = Math.round(origH * capScale);
    const out      = new Uint8Array(outW * outH);

    for (let oy = 0; oy < outH; oy++) {
      for (let ox = 0; ox < outW; ox++) {
        const encX = (ox * origW / outW) * scale;
        const encY = (oy * origH / outH) * scale;
        const mx   = Math.min(255, Math.floor(encX / 4));
        const my   = Math.min(255, Math.floor(encY / 4));
        out[oy * outW + ox] = rawMask[my * 256 + mx] > 0 ? 1 : 0;
      }
    }

    self.postMessage({ type: 'mask', imgIdx, mask: out, width: outW, height: outH }, [out.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: 'Decode: ' + err.message });
  }
}

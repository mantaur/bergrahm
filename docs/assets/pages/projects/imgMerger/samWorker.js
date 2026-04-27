/* samWorker.js — SAM encode/decode worker (stateless)
 * Workers are stateless between jobs. Encode serializes embeddings and returns
 * them to the main thread for caching. Decode receives embeddings with each
 * request so any worker can decode any image without re-encoding.
 *
 * Execution strategy:
 *   WebGPU available → fp32 model on GPU (fast, avoids WASM heap)
 *   WebGPU absent   → quantized int8 model on WASM CPU (half memory)
 */

const SAM_CDN      = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';
const SAM_MODEL_ID = 'Xenova/slimsam-50-uniform';

let lib = null, processor = null, model = null;

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'init')   await doInit();
  if (msg.type === 'encode') await doEncode(msg);
  if (msg.type === 'decode') await doDecode(msg);
};

async function doInit() {
  try {
    lib = await import(SAM_CDN);
    lib.env.allowLocalModels  = false;
    lib.env.allowRemoteModels = true;
    lib.env.useBrowserCache   = typeof caches !== 'undefined';
    lib.env.backends.onnx.wasm.wasmPaths = SAM_CDN.replace('transformers.min.js', '');

    const prog = p => {
      if (p.status === 'progress')
        self.postMessage({ type: 'progress', text: p.file + ' ' + Math.round(p.progress || 0) + '%' });
    };

    const useWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
    const opts = useWebGPU
      ? { device: 'webgpu',                    progress_callback: prog }
      : { quantized: true,  device: 'wasm',    progress_callback: prog };

    processor = await lib.AutoProcessor.from_pretrained(SAM_MODEL_ID, { progress_callback: prog });
    model     = await lib.SamModel.from_pretrained(SAM_MODEL_ID, opts);

    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
}

async function doEncode({ imgIdx, pixels, width, height }) {
  try {
    const raw       = new lib.RawImage(new Uint8ClampedArray(pixels), width, height, 4);
    const processed = await processor(raw);
    const embeddings = await model.get_image_embeddings(processed);

    const serialized = {};
    const transfers  = [];
    for (const [key, tensor] of Object.entries(embeddings)) {
      const buf = tensor.data.buffer.slice(0);
      serialized[key] = { type: tensor.type, dims: Array.from(tensor.dims), data: buf };
      transfers.push(buf);
    }

    self.postMessage({
      type:          'encoded',
      imgIdx,
      embeddings:    serialized,
      originalSizes: processed.original_sizes,
      reshapedSizes: processed.reshaped_input_sizes,
    }, transfers);
  } catch (err) {
    self.postMessage({ type: 'error', message: 'Encode: ' + err.message });
  }
}

async function doDecode({ imgIdx, x, y, decodeSize, embeddings, originalSizes, reshapedSizes }) {
  try {
    const { Tensor } = lib;

    const typeMap = {
      float32: Float32Array, float64: Float64Array,
      int32: Int32Array, int64: BigInt64Array, uint8: Uint8Array,
    };
    const reconstructed = {};
    for (const [key, { type, dims, data }] of Object.entries(embeddings)) {
      const TypedArray = typeMap[type];
      if (!TypedArray) throw new Error('Unsupported tensor type: ' + type);
      reconstructed[key] = new Tensor(type, new TypedArray(data), dims);
    }

    const [origH, origW] = originalSizes[0];
    const [reshH, reshW] = reshapedSizes[0];
    const px = (x / origW) * reshW;
    const py = (y / origH) * reshH;

    const input_points = new Tensor('float32', [px, py], [1, 1, 1, 2]);
    const input_labels = new Tensor('int64',   [1n],     [1, 1, 1]);

    const outputs = await model({ ...reconstructed, input_points, input_labels });

    const capScale        = Math.min(1, decodeSize / Math.max(origH, origW));
    const capH            = Math.round(origH * capScale);
    const capW            = Math.round(origW * capScale);
    const cappedOrigSizes = [[capH, capW]];

    const masks = await processor.post_process_masks(
      outputs.pred_masks, cappedOrigSizes, reshapedSizes
    );

    const scores  = Array.from(outputs.iou_scores.data);
    const bestIdx = scores.indexOf(Math.max(...scores));
    const t       = masks[0];
    const dims    = t.dims;
    const H = dims[dims.length - 2], W = dims[dims.length - 1];
    const stride  = H * W;
    const out     = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) out[i] = t.data[bestIdx * stride + i] ? 1 : 0;

    self.postMessage({ type: 'mask', imgIdx, mask: out, width: W, height: H }, [out.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: 'Decode: ' + err.message });
  }
}

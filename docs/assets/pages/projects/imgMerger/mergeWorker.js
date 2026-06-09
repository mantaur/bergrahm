// ── Image Merger — merge worker ───────────────────────────────────────────────
// Resolves per-pixel ownership for the chosen blend mode (functions in
// blendModes.js, imported below). Chamfer distance transforms are delegated to
// the main thread (requestChamfer) -- this worker doesn't nest workers.
importScripts('blendModes.js?v=1');

// Chamfer jobs run in a pool the main thread owns -- this worker can't nest
// workers reliably on Firefox -- so we ship each job out and await it.
const _chamferPending = new Map();
let _chamferSeq = 0;
function requestChamfer(mask, W, H) {
  return new Promise((resolve) => {
    const id = ++_chamferSeq;
    _chamferPending.set(id, resolve);
    self.postMessage({ type: 'chamfer-req', id, mask: mask.buffer, W, H }, [mask.buffer]);
  });
}

self.onmessage = async function (e) {
  if (e.data && e.data.type === 'chamfer-res') {
    const resolve = _chamferPending.get(e.data.id);
    if (resolve) { _chamferPending.delete(e.data.id); resolve(e.data.dist ? new Float32Array(e.data.dist) : null); }
    return;
  }

  // Images are composited at their current positions; we only resolve per-pixel
  // ownership for the chosen blend mode.
  const { images, outW, outH, blendMode, seed, ditherExp, precomputedPlacements } = e.data;
  try {
    const ownership = await computeOwnershipMap(images, precomputedPlacements, outW, outH, blendMode, seed | 0, ditherExp);
    postDone(precomputedPlacements, ownership);
  } catch (err) {
    self.postMessage({ type: 'error', text: err.message });
  }
};

// Post the merge result; transfer whatever ownership buffers it carries.
function postDone(placements, ownership) {
  const transfer = [];
  for (const key of ['owner', 'ownerA', 'ownerB', 'blend']) if (ownership[key]) transfer.push(ownership[key].buffer);
  self.postMessage({ type: 'done', placements, ownership }, transfer);
}

function postProgress(pct) {
  self.postMessage({ type: 'progress', pct: Math.round(pct) });
}

// Throttle chamfer jobs to 8 in flight (each runs in the main thread's pool).
// getEntry(j) -> { mask } whose buffer is transferred out; onResult(j, dist) gets
// a Float32Array or null on error; onDone(done, total) reports progress.
async function parallelChamfer(count, W, H, getEntry, onResult, onDone) {
  const CONCURRENCY = Math.min(8, count);
  let completed = 0;
  let nextIdx = CONCURRENCY;

  async function runOne(j) {
    const { mask } = getEntry(j);
    const dist = await requestChamfer(mask, W, H);
    if (onDone) onDone(++completed, count);
    onResult(j, dist);
  }

  async function lane(j) {
    while (j < count) { await runOne(j); j = nextIdx++; }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => lane(i)));
}


// ── Image Merger — blend modes ────────────────────────────────────────────────
// Per-pixel ownership for each merge mode, pulled into mergeWorker.js via
// importScripts (so these share the worker's parallelChamfer / postProgress).
// Each mode returns the payload the pixel render worker keys off: hard modes
// give { owner }, gradient gives { ownerA, ownerB, blend }.

// ── Ownership map dispatcher ───────────────────────────────────────────────────
async function computeOwnershipMap(images, placements, W, H, blendMode, seed, ditherExp) {
  const exp = Math.max(1, ditherExp | 0) || 4;
  if (blendMode === 'gradient') return computeGradientMap(images, placements, W, H, exp);
  if (blendMode === 'dither')   return { owner: await computeDitherMap(images, placements, W, H, seed | 0, exp) };
  return { owner: await computeVoronoiMap(images, placements, W, H) };
}

// Transform a single vertex from image space to output space,
// applying scale, rotation around pivot, and placement.
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

// ── Voronoi ownership map ──────────────────────────────────────────────────────
// Returns Int16Array(W*H): each cell holds the imgIdx of the nearest essential region,
// or -1 if no image has any polygons.
async function computeVoronoiMap(images, placements, W, H) {
  const M = W * H;
  const ownerMap = new Int16Array(M).fill(-1);
  const minDist  = new Float32Array(M).fill(Infinity);

  const activePs = placements.filter(p => {
    const e = images[p.imgIdx]; return e.polygons && e.polygons.length > 0;
  });
  if (activePs.length === 0) return ownerMap;
  postProgress(20);

  await parallelChamfer(activePs.length, W, H,
    j => {
      const p = activePs[j], entry = images[p.imgIdx];
      const outPolys = entry.polygons.map(poly => poly.map(v => transformPolyVert(v, p)));
      const mask = new Uint8Array(M);
      rasterizePolygons(outPolys, W, H, mask);
      return { mask };
    },
    (j, dist) => {
      if (!dist) return;
      const imgIdx = activePs[j].imgIdx;
      for (let i = 0; i < M; i++) {
        if (dist[i] < minDist[i]) { minDist[i] = dist[i]; ownerMap[i] = imgIdx; }
      }
    },
    (done, total) => postProgress(20 + Math.round(done / total * 80))
  );

  return ownerMap;
}

// Per-pixel two nearest placements by chamfer distance (shared by dither +
// gradient). Returns { top0Dist, top1Dist, top0K, top1K } in placement-index
// space (k = -1 where unreached), or null if no placement has polygons.
async function _computeTop2(images, placements, W, H) {
  const N = placements.length, M = W * H;
  const bboxes   = new Array(N).fill(null);
  const activeKs = [];

  for (let k = 0; k < N; k++) {
    const p     = placements[k];
    const entry = images[p.imgIdx];
    if (!entry.polygons || entry.polygons.length === 0) continue;
    activeKs.push(k);
    const corners = [
      { x: 0, y: 0 }, { x: entry.w, y: 0 },
      { x: entry.w, y: entry.h }, { x: 0, y: entry.h },
    ].map(c => transformPolyVert(c, p));
    const cxs = corners.map(c => c.x), cys = corners.map(c => c.y);
    bboxes[k] = {
      x0: Math.max(0,     Math.floor(Math.min(...cxs))),
      y0: Math.max(0,     Math.floor(Math.min(...cys))),
      x1: Math.min(W - 1, Math.ceil(Math.max(...cxs))),
      y1: Math.min(H - 1, Math.ceil(Math.max(...cys))),
    };
  }

  if (activeKs.length === 0) return null;
  postProgress(15);

  const top0Dist = new Float32Array(M).fill(Infinity);
  const top1Dist = new Float32Array(M).fill(Infinity);
  const top0K    = new Int16Array(M).fill(-1);
  const top1K    = new Int16Array(M).fill(-1);

  await parallelChamfer(activeKs.length, W, H,
    j => {
      const k = activeKs[j], p = placements[k], entry = images[p.imgIdx];
      const outPolys = entry.polygons.map(poly => poly.map(v => transformPolyVert(v, p)));
      const mask = new Uint8Array(M);
      rasterizePolygons(outPolys, W, H, mask);
      return { mask };
    },
    (j, dist) => {
      if (!dist) return;
      const k = activeKs[j], bb = bboxes[k];
      for (let y = bb.y0; y <= bb.y1; y++) {
        for (let x = bb.x0; x <= bb.x1; x++) {
          const i = y * W + x, d = dist[i];
          if (d < top0Dist[i]) {
            top1Dist[i] = top0Dist[i]; top1K[i] = top0K[i];
            top0Dist[i] = d;           top0K[i]  = k;
          } else if (d < top1Dist[i]) {
            top1Dist[i] = d; top1K[i] = k;
          }
        }
      }
    },
    (done, total) => postProgress(15 + Math.round(done / total * 50))
  );

  return { top0Dist, top1Dist, top0K, top1K };
}

// ── Dither ownership map ───────────────────────────────────────────────────────
// Int16Array(W*H) of imgIdx: each pixel picks one of its two nearest images by
// weighted random sampling (weight = dist^exp). Essential pixels (dist=0) win.
async function computeDitherMap(images, placements, W, H, seed, exp) {
  const M = W * H;
  const ownerMap = new Int16Array(M).fill(-1);
  const t = await _computeTop2(images, placements, W, H);
  if (!t) return ownerMap;
  const { top0Dist, top1Dist, top0K, top1K } = t;

  postProgress(65);
  const reportStep = Math.max(1, Math.round(H / 20));
  for (let y = 0; y < H; y++) {
    if (y % reportStep === 0) postProgress(65 + Math.round(y / H * 35));
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const k0 = top0K[i];
      if (k0 < 0) continue;
      const k1 = top1K[i];
      if (k1 < 0 || top0Dist[i] === 0) { ownerMap[i] = placements[k0].imgIdx; continue; }
      const w0 = Math.pow(top1Dist[i], exp);
      const w1 = Math.pow(top0Dist[i], exp);
      ownerMap[i] = placements[pixelRand(seed, i) < w0 / (w0 + w1) ? k0 : k1].imgIdx;
    }
  }
  return ownerMap;
}

// ── Gradient ownership ─────────────────────────────────────────────────────────
// Like dither, but instead of picking one owner it stores a continuous blend of
// the two nearest images (averaged at render time). blend = weight of the
// farther image B in 0..255 (small near A, ~128 at the seam).
async function computeGradientMap(images, placements, W, H, exp) {
  const M = W * H;
  const ownerA = new Int16Array(M).fill(-1);
  const ownerB = new Int16Array(M).fill(-1);
  const blend  = new Uint8Array(M);
  const t = await _computeTop2(images, placements, W, H);
  if (!t) return { ownerA, ownerB, blend };
  const { top0Dist, top1Dist, top0K, top1K } = t;

  postProgress(65);
  const reportStep = Math.max(1, Math.round(H / 20));
  for (let y = 0; y < H; y++) {
    if (y % reportStep === 0) postProgress(65 + Math.round(y / H * 35));
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const k0 = top0K[i];
      if (k0 < 0) continue;
      ownerA[i] = placements[k0].imgIdx;
      const k1 = top1K[i];
      if (k1 < 0 || top0Dist[i] === 0) continue; // pure nearest
      ownerB[i] = placements[k1].imgIdx;
      const dA = Math.pow(top0Dist[i], exp);
      const dB = Math.pow(top1Dist[i], exp);
      blend[i] = Math.round(dA / (dA + dB) * 255);
    }
  }
  return { ownerA, ownerB, blend };
}

// Wang hash — deterministic float in [0, 1) from seed + pixel index.
function pixelRand(seed, idx) {
  let h = ((seed >>> 0) ^ (idx >>> 0)) >>> 0;
  h = ((h ^ 61) ^ (h >>> 16)) >>> 0;
  h = (h + (h << 3))          >>> 0;
  h = (h ^ (h >>> 4))         >>> 0;
  h = Math.imul(h, 0x27d4eb2d) >>> 0;
  h = (h ^ (h >>> 15))        >>> 0;
  return h / 4294967296;
}

// Scanline-fill all polygons into mask (1 = inside, output space).
function rasterizePolygons(polygons, W, H, mask) {
  for (const poly of polygons) {
    if (poly.length < 3) continue;
    let minY = Infinity, maxY = -Infinity;
    for (const v of poly) { if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y; }
    minY = Math.max(0, Math.floor(minY));
    maxY = Math.min(H - 1, Math.ceil(maxY));
    const n = poly.length;
    for (let y = minY; y <= maxY; y++) {
      const xs = [];
      for (let i = 0; i < n; i++) {
        const a = poly[i], b = poly[(i + 1) % n];
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
          xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.ceil(xs[k]));
        const x1 = Math.min(W - 1, Math.floor(xs[k + 1]));
        for (let x = x0; x <= x1; x++) mask[y * W + x] = 1;
      }
    }
  }
}

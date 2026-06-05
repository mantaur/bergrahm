// ── Image Merger — merge worker ───────────────────────────────────────────────
// Placement solver + ownership dispatch. The blend-mode functions live in
// blendModes.js (imported below). Chamfer distance transforms are delegated to
// the main thread (requestChamfer) -- this worker doesn't nest workers.
importScripts('blendModes.js?v=1');

const COARSE_STEP  = 400;
const FINE_STEP    = 20;
const FINE_RADIUS  = 200;
const TOP_K        = 10;

// Mutable overrides — set per-message so preview runs can use scaled constants.
let gCoarseStep = COARSE_STEP;
let gFineStep   = FINE_STEP;
let gFineRadius = FINE_RADIUS;
let gTopK       = TOP_K;
let gSilent     = false;

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

  const { images, rankOrder, outW, outH, minScale, maxScale, useScaleRange, blendMode, seed, ditherExp,
          coarseStep, fineStep, fineRadius, topK, silent, precomputedPlacements } = e.data;

  // Shortcut: skip placement search, compute ownership only.
  if (precomputedPlacements) {
    try {
      const ownership = await computeOwnershipMap(images, precomputedPlacements, outW, outH, blendMode, seed | 0, ditherExp);
      postDone(precomputedPlacements, ownership);
    } catch (err) {
      self.postMessage({ type: 'error', text: err.message });
    }
    return;
  }

  gCoarseStep = coarseStep  || COARSE_STEP;
  gFineStep   = fineStep    || FINE_STEP;
  gFineRadius = fineRadius  || FINE_RADIUS;
  gTopK       = topK        || TOP_K;
  gSilent     = !!silent;
  try {
    const { placements, ownership } = await runMerge(images, rankOrder, outW, outH, minScale, maxScale, useScaleRange, blendMode, seed, ditherExp);
    postDone(placements, ownership);
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

function postLog(text, cls) {
  if (gSilent) return;
  self.postMessage({ type: 'log', text, cls: cls || '' });
}

function postProgress(pct) {
  self.postMessage({ type: 'progress', pct: Math.round(pct) });
}

async function runMerge(images, rankOrder, W, H, minScale, maxScale, useScaleRange, blendMode, seed, ditherExp) {
  const forbiddenTris = [];
  const placements    = [];

  for (let ri = 0; ri < rankOrder.length; ri++) {
    const imgIdx = rankOrder[ri];
    const entry  = images[imgIdx];
    postLog('Placing [' + entry.name + '] (rank ' + (ri + 1) + ') scale=' + entry.scale.toFixed(2) + 'x...');

    entry.triangles = [];
    for (const poly of entry.polygons) {
      const tris = triangulate(poly);
      for (const t of tris) entry.triangles.push(t);
    }

    if (entry.triangles.length === 0) {
      postLog('  -> No essential polygons - placed at (0,0) scale=' + entry.scale.toFixed(2) + 'x.');
      placements.push({ imgIdx, x: 0, y: 0, scale: entry.scale });
      continue;
    }

    entry.bbox = trianglesBbox(entry.triangles);

    // For manually-scaled images, or when scale-range search is off, use the
    // single resolved scale. Otherwise search min/default/max and keep the best.
    const scales = (entry.scaleFixed || !useScaleRange)
      ? [entry.scale]
      : [...new Set([minScale, entry.scale, maxScale])];
    let bestScore = -Infinity, bestPlacement = null;
    const origScale = entry.scale;
    try {
      for (const s of scales) {
        entry.scale = s;
        const { bestScore: sc, bestPlacement: pl } = findBestPlacement(entry, forbiddenTris, W, H);
        if (sc > bestScore) { bestScore = sc; bestPlacement = pl; }
      }
    } finally {
      entry.scale = origScale;
    }

    if (bestPlacement === null || bestScore < 0) {
      postLog('  -> Could not find a valid placement - skipped.', 'im-log-warn');
      continue;
    }

    const { tx: x, ty: y, s: scale } = bestPlacement;
    postLog('  -> Placed at (' + x + ', ' + y + ') scale=' + scale.toFixed(2) + 'x  score=' + bestScore, 'im-log-ok');
    placements.push({ imgIdx, x, y, scale });
    markEssentials(forbiddenTris, entry.triangles, x, y, scale);
  }

  postLog('Computing ownership map...');
  const ownership = await computeOwnershipMap(images, placements, W, H, blendMode, seed, ditherExp);
  return { placements, ownership };
}

function findBestPlacement(entry, forbiddenTris, W, H) {
  const s       = entry.scale;
  const scaledW = Math.round(entry.w * s);
  const scaledH = Math.round(entry.h * s);
  const xMin    = -(scaledW - 1), xMax = W - 1;
  const yMin    = -(scaledH - 1), yMax = H - 1;
  const forbiddenBbox = forbiddenTris.length > 0 ? bboxUnion(forbiddenTris.map(t => t.bbox)) : null;
  const topK = [];

  for (let tx = xMin; tx <= xMax; tx += gCoarseStep) {
    for (let ty = yMin; ty <= yMax; ty += gCoarseStep) {
      const score = scorePlacement(entry, s, tx, ty, forbiddenTris, forbiddenBbox, W, H);
      if (topK.length < gTopK || score > topK[topK.length - 1].score) {
        topK.push({ tx, ty, score });
        topK.sort((a, b) => b.score - a.score);
        if (topK.length > gTopK) topK.pop();
      }
    }
  }

  if (topK.length === 0) return { bestScore: -Infinity, bestPlacement: null };

  let bestScore = -Infinity, bestPlacement = null;

  for (const { tx: cx, ty: cy } of topK) {
    const xLo = Math.max(xMin, cx - gFineRadius);
    const xHi = Math.min(xMax, cx + gFineRadius);
    const yLo = Math.max(yMin, cy - gFineRadius);
    const yHi = Math.min(yMax, cy + gFineRadius);

    for (let tx = xLo; tx <= xHi; tx += gFineStep) {
      for (let ty = yLo; ty <= yHi; ty += gFineStep) {
        const score = scorePlacement(entry, s, tx, ty, forbiddenTris, forbiddenBbox, W, H);
        if (score > bestScore) { bestScore = score; bestPlacement = { tx, ty, s }; }
      }
    }
  }

  return { bestScore, bestPlacement };
}

function scorePlacement(entry, scale, tx, ty, forbiddenTris, forbiddenBbox, W, H) {
  const s2 = scale * scale; // area weight — larger placements score proportionally more
  const ob = transformBbox(entry.bbox, tx, ty, scale);
  if (ob.maxX < 0 || ob.minX >= W || ob.maxY < 0 || ob.minY >= H) return -entry.triangles.length * s2;
  const skipForbidden = !forbiddenBbox || !bboxOverlap(ob, forbiddenBbox);
  let score = 0;
  for (const srcTri of entry.triangles) {
    const t  = transformTri(srcTri, tx, ty, scale);
    const cx = (t[0].x + t[1].x + t[2].x) / 3;
    const cy = (t[0].y + t[1].y + t[2].y) / 3;
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) { score -= s2; continue; }
    if (skipForbidden) { score += s2; continue; }
    const tb = triBbox(t);
    let hit = false;
    for (const ft of forbiddenTris) {
      if (bboxOverlap(tb, ft.bbox) && trisOverlap(t, ft.verts)) { hit = true; break; }
    }
    score += hit ? -2 * s2 : s2;
  }
  return score;
}

function markEssentials(forbiddenTris, srcTriangles, tx, ty, scale) {
  for (const srcTri of srcTriangles) {
    const verts = transformTri(srcTri, tx, ty, scale);
    forbiddenTris.push({ verts, bbox: triBbox(verts) });
  }
}

function transformTri(tri, tx, ty, scale) {
  return tri.map(v => ({ x: tx + v.x * scale, y: ty + v.y * scale }));
}

function triBbox(tri) {
  return {
    minX: Math.min(tri[0].x, tri[1].x, tri[2].x),
    minY: Math.min(tri[0].y, tri[1].y, tri[2].y),
    maxX: Math.max(tri[0].x, tri[1].x, tri[2].x),
    maxY: Math.max(tri[0].y, tri[1].y, tri[2].y),
  };
}

function trianglesBbox(tris) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const tri of tris) for (const v of tri) {
    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
  }
  return { minX, minY, maxX, maxY };
}

function transformBbox(bbox, tx, ty, scale) {
  return { minX: tx + bbox.minX * scale, minY: ty + bbox.minY * scale,
           maxX: tx + bbox.maxX * scale, maxY: ty + bbox.maxY * scale };
}

function bboxOverlap(a, b) {
  return a.maxX >= b.minX && b.maxX >= a.minX && a.maxY >= b.minY && b.maxY >= a.minY;
}

function bboxUnion(bboxes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bboxes) {
    if (b.minX < minX) minX = b.minX; if (b.maxX > maxX) maxX = b.maxX;
    if (b.minY < minY) minY = b.minY; if (b.maxY > maxY) maxY = b.maxY;
  }
  return { minX, minY, maxX, maxY };
}

function trisOverlap(t1, t2) {
  for (const tri of [t1, t2]) {
    for (let i = 0; i < 3; i++) {
      const a = tri[i], b = tri[(i + 1) % 3];
      const nx = -(b.y - a.y), ny = b.x - a.x;
      let mn1 = Infinity, mx1 = -Infinity, mn2 = Infinity, mx2 = -Infinity;
      for (const v of t1) { const p = v.x*nx + v.y*ny; if (p < mn1) mn1=p; if (p > mx1) mx1=p; }
      for (const v of t2) { const p = v.x*nx + v.y*ny; if (p < mn2) mn2=p; if (p > mx2) mx2=p; }
      if (mx1 < mn2 || mx2 < mn1) return false;
    }
  }
  return true;
}

function triangulate(polygon) {
  if (polygon.length < 3) return [];
  if (polygon.length === 3) return [[polygon[0], polygon[1], polygon[2]]];
  const verts = ensureCW(polygon).map(v => ({ x: v.x, y: v.y }));
  const result = [];
  let safety = verts.length * verts.length + 10;
  while (verts.length > 3 && safety-- > 0) {
    let clipped = false;
    for (let i = 0; i < verts.length; i++) {
      const prev = verts[(i - 1 + verts.length) % verts.length];
      const curr = verts[i];
      const next = verts[(i + 1) % verts.length];
      if (isEar(prev, curr, next, verts)) {
        result.push([prev, curr, next]);
        verts.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) break;
  }
  if (verts.length === 3) result.push([verts[0], verts[1], verts[2]]);
  return result;
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    a += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return a / 2;
}

function ensureCW(poly) { return signedArea(poly) > 0 ? poly : poly.slice().reverse(); }

function cross2d(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function isEar(prev, curr, next, verts) {
  if (cross2d(prev, curr, next) <= 0) return false;
  for (const v of verts) {
    if (v === prev || v === curr || v === next) continue;
    if (pointInTriangle(v, prev, curr, next)) return false;
  }
  return true;
}

function pointInTriangle(p, a, b, c) {
  const ab = cross2d(a, b, p), bc = cross2d(b, c, p), ca = cross2d(c, a, p);
  return (ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0);
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


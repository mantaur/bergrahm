// ── Sim viewport ────────────────────────────────────────────────────────────────
// Owns the sim view: zoom (scale), pan (offset, world coords of the viewport's
// top-left), and the fixed display scale (px per world unit). Also home to the
// world<->screen transforms, pan/zoom gestures, eased animation, and presenter
// follow.
//
// Loaded as a classic script BEFORE imageMerge.js. (It can't be an ES module:
// imageMerge.js is a classic script that runs initSim() at parse time — before
// deferred modules execute — and converting imageMerge.js to a module would break
// the index.html bridge that reads its top-level `let`s. As a classic script the
// top-level `const viewport` lives in the shared script scope, so imageMerge.js
// reads `viewport.scale` / `viewport.offsetX` etc. directly; collaborate.js, a
// module, drives it via window.imViewport.)
//
// State it does NOT own (the document/sim model) is injected via init():
//   canvas       the sim <canvas> (for size + client-rect transforms)
//   markDirty()  flag the sim view as needing a redraw
//   getArtboard()-> { x1, y1, x2, y2 }  the output rect, for centerOnArtboard()
//   getGroup(i)  -> sim group | null    a placed image, for centerOnImage()
const viewport = (function () {
  const VIEW_MIN = 0.1, VIEW_MAX = 10;
  const clamp = s => Math.max(VIEW_MIN, Math.min(VIEW_MAX, s));

  // ── Owned state ──
  let scale     = 1;               // zoom (1 = no zoom)
  let offset    = { x: 0, y: 0 };  // world coords of the viewport's top-left
  let dispScale = 1;               // display px per world unit (fixed; from canvas/world size)

  // ── Injected deps ──
  let canvas      = null;
  let markDirty   = () => {};
  let getArtboard = () => ({ x1: 0, y1: 0, x2: 0, y2: 0 });
  let getGroup    = () => null;

  // ── Presenter / animation ──
  let _present   = false; // true while this client drives followers' views
  let _anim      = null;  // { mode:'tween', from, target, start, dur } | { mode:'follow', target }
  let _following = false; // true while tracking a remote presenter

  function getState() { return { scale, offsetX: offset.x, offsetY: offset.y }; }

  function emit() {
    if (_present) window.dispatchEvent(new CustomEvent('collab:viewport-changed', { detail: getState() }));
  }

  // Low-level write: clamp + store + mark dirty. No emit/cancel.
  function setView(s, ox, oy) { scale = clamp(s); offset = { x: ox, y: oy }; markDirty(); }
  function cancelAnim() { _anim = null; _following = false; }
  // Authoritative change (manual gesture / non-animated API): cancels anim, then
  // emits to followers if presenting.
  function apply(s, ox, oy) { cancelAnim(); setView(s, ox, oy); emit(); }

  // ── Transforms ──
  function worldFromCanvasPx(px, py) {
    const ts = dispScale * scale;
    return { x: px / ts + offset.x, y: py / ts + offset.y };
  }
  function canvasToPhysics(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return worldFromCanvasPx(
      (clientX - rect.left) / rect.width  * canvas.width,
      (clientY - rect.top)  / rect.height * canvas.height);
  }
  function clientToCanvasPx(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width  * canvas.width,
      y: (clientY - rect.top)  / rect.height * canvas.height,
    };
  }
  function physicsToClient(worldX, worldY) {
    const rect = canvas.getBoundingClientRect();
    const ts = dispScale * scale;
    const cx = (worldX - offset.x) * ts;
    const cy = (worldY - offset.y) * ts;
    return {
      x: cx * rect.width  / canvas.width  + rect.left,
      y: cy * rect.height / canvas.height + rect.top,
    };
  }

  // ── World-space API ──
  function centerOn(worldX, worldY, opts = {}) {
    const s  = clamp(opts.scale != null ? opts.scale : scale);
    const ts = dispScale * s;
    const ox = worldX - canvas.width  / 2 / ts;
    const oy = worldY - canvas.height / 2 / ts;
    if (opts.animate) animateTo(s, ox, oy, opts.durationMs);
    else apply(s, ox, oy);
  }

  function fit(b, opts = {}) {
    const pad = opts.padding != null ? opts.padding : 0.12;
    const bw  = Math.max(1, b.x2 - b.x1), bh = Math.max(1, b.y2 - b.y1);
    const sx  = canvas.width  * (1 - pad) / (bw * dispScale);
    const sy  = canvas.height * (1 - pad) / (bh * dispScale);
    centerOn((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2,
      { scale: Math.min(sx, sy), animate: opts.animate, durationMs: opts.durationMs });
  }

  function centerOnImage(imgIdx, opts = {}) {
    const g = getGroup(imgIdx);
    if (g) centerOn(g.x, g.y, opts);
  }

  function centerOnArtboard(opts = {}) { fit(getArtboard(), opts); }

  function setZoom(s, opts = {}) {
    const rect = canvas.getBoundingClientRect();
    const c = canvasToPhysics(rect.left + rect.width / 2, rect.top + rect.height / 2);
    centerOn(c.x, c.y, { scale: s, animate: opts.animate, durationMs: opts.durationMs });
  }

  function applyState(st, opts = {}) {
    if (opts.animate) animateTo(st.scale, st.offsetX, st.offsetY, opts.durationMs);
    else apply(st.scale, st.offsetX, st.offsetY);
  }

  // ── Gesture funnels (wheel / pinch / pan) ──
  function panByCanvasPx(dxPx, dyPx) {
    const ts = dispScale * scale;
    apply(scale, offset.x + dxPx / ts, offset.y + dyPx / ts);
  }
  function zoomAtCanvasPx(canvasPx, newScale) {
    const s = clamp(newScale), old = dispScale * scale;
    apply(s,
      offset.x + canvasPx.x / old - canvasPx.x / (dispScale * s),
      offset.y + canvasPx.y / old - canvasPx.y / (dispScale * s));
  }

  // ── Animation / follow ──
  function animateTo(s, ox, oy, dur) {
    _following = false;
    _anim = {
      mode: 'tween',
      from: { scale, ox: offset.x, oy: offset.y },
      target: { scale: clamp(s), ox, oy },
      start: performance.now(),
      dur: dur || 420,
    };
  }

  // Track a remote presenter; subsequent calls just update the target.
  function follow(s, ox, oy) {
    const target = { scale: clamp(s), ox, oy };
    if (_anim && _anim.mode === 'follow') _anim.target = target;
    else _anim = { mode: 'follow', target };
    _following = true;
  }

  function setPresenting(on) {
    _present = !!on;
    if (_present) emit(); // snap followers to the current view
  }

  // Advance the active animation; called each sim frame.
  function stepAnim(now) {
    const a = _anim;
    if (!a) return;
    if (a.mode === 'tween') {
      const t = Math.min(1, (now - a.start) / a.dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
      setView(
        a.from.scale + (a.target.scale - a.from.scale) * e,
        a.from.ox + (a.target.ox - a.from.ox) * e,
        a.from.oy + (a.target.oy - a.from.oy) * e);
      emit();
      if (t >= 1) _anim = null;
    } else { // follow
      const ds = a.target.scale - scale;
      const dx = a.target.ox - offset.x;
      const dy = a.target.oy - offset.y;
      if (Math.abs(ds) < 1e-4 && Math.hypot(dx, dy) < 0.5) return; // settled — idle until target moves
      setView(scale + ds * 0.2, offset.x + dx * 0.2, offset.y + dy * 0.2);
    }
  }

  return {
    init(deps) {
      canvas      = deps.canvas;
      markDirty   = deps.markDirty   || markDirty;
      getArtboard = deps.getArtboard || getArtboard;
      getGroup    = deps.getGroup    || getGroup;
    },

    // Accessors (read-only views of owned state)
    get scale()      { return scale; },
    get offset()     { return { x: offset.x, y: offset.y }; },
    get offsetX()    { return offset.x; },
    get offsetY()    { return offset.y; },
    get dispScale()  { return dispScale; },
    get totalScale() { return dispScale * scale; },
    get presenting() { return _present; },
    get following()  { return _following; },
    getState,

    // Low-level setters (used by initSim / resize)
    setView,
    setDispScale(d) { dispScale = d; },

    // Transforms
    canvasToPhysics, clientToCanvasPx, physicsToClient, worldFromCanvasPx,

    // Gesture funnels + internal funnel (used by imageMerge handlers)
    panByCanvasPx, zoomAtCanvasPx,
    _apply: apply, _set: setView, _cancelAnim: cancelAnim,

    // World-space API
    centerOn, fit, centerOnImage, centerOnArtboard, setZoom, applyState,

    // Animation / presenter
    animateTo, follow, setPresenting, stepAnim,
  };
})();

window.imViewport = viewport;

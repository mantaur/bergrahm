// Chamfer distance transform (2-pass). Input { mask, W, H }, output a transferred
// Float32Array: 0 at seed pixels, approximate distance elsewhere. Its own file so
// the main thread can pool these -- the blob merge worker can't nest workers on Firefox.

self.onmessage = (e) => {
  const mask = new Uint8Array(e.data.mask);
  const W = e.data.W, H = e.data.H;
  const INF = 1e9, n = W * H;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = mask[i] ? 0 : INF;

  // Forward pass (top-left -> bottom-right)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (x > 0)        v = Math.min(v, d[i - 1]     + 3);
      if (y > 0) {
        if (x > 0)      v = Math.min(v, d[i - W - 1] + 4);
                        v = Math.min(v, d[i - W]     + 3);
        if (x < W - 1)  v = Math.min(v, d[i - W + 1] + 4);
      }
      d[i] = v;
    }
  }

  // Backward pass (bottom-right -> top-left)
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (x < W - 1)    v = Math.min(v, d[i + 1]     + 3);
      if (y < H - 1) {
        if (x < W - 1)  v = Math.min(v, d[i + W + 1] + 4);
                        v = Math.min(v, d[i + W]     + 3);
        if (x > 0)      v = Math.min(v, d[i + W - 1] + 4);
      }
      d[i] = v;
    }
  }

  self.postMessage(d.buffer, [d.buffer]);
};

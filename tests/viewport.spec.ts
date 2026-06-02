// Programmatic viewport control (window.imViewport) + collab presenter/follow.
// The sim loop runs from page load, so no images are needed for the local API.

import { test, expect, emitRemote, collabOut } from './fixtures';

test.describe('Local viewport API', () => {
  test('centerOn places a world point at the canvas centre', async ({ page }) => {
    const r = await page.evaluate(() => {
      (window as any).imViewport.centerOn(5000, 5000, { scale: 1 });
      const st = (window as any).getSimState();
      const cv = document.getElementById('sim-canvas') as HTMLCanvasElement;
      const ts = st.dispScale * st.viewScale;
      return {
        scale: st.viewScale,
        offX: st.viewOffset.x, offY: st.viewOffset.y,
        expOx: 5000 - cv.width / 2 / ts,
        expOy: 5000 - cv.height / 2 / ts,
      };
    });
    expect(r.scale).toBeCloseTo(1, 5);
    expect(r.offX).toBeCloseTo(r.expOx, 2);
    expect(r.offY).toBeCloseTo(r.expOy, 2);
  });

  test('setZoom changes the zoom level', async ({ page }) => {
    await page.evaluate(() => (window as any).imViewport.setZoom(3));
    expect(await page.evaluate(() => (window as any).getSimState().viewScale)).toBeCloseTo(3, 5);
  });

  test('fit frames a world rect (centred + within bounds)', async ({ page }) => {
    const r = await page.evaluate(() => {
      const b = { x1: 4000, y1: 4000, x2: 6000, y2: 5000 };
      (window as any).imViewport.fit(b, { padding: 0 });
      const st = (window as any).getSimState();
      const cv = document.getElementById('sim-canvas') as HTMLCanvasElement;
      const ts = st.dispScale * st.viewScale;
      return {
        cx: (5000 - st.viewOffset.x) * ts, cy: (4500 - st.viewOffset.y) * ts,
        cw: cv.width, ch: cv.height,
        rectW: (b.x2 - b.x1) * ts, rectH: (b.y2 - b.y1) * ts,
      };
    });
    expect(r.cx).toBeCloseTo(r.cw / 2, 0);
    expect(r.cy).toBeCloseTo(r.ch / 2, 0);
    expect(r.rectW).toBeLessThanOrEqual(r.cw + 1);
    expect(r.rectH).toBeLessThanOrEqual(r.ch + 1);
  });

  test('getState / applyState round-trips', async ({ page }) => {
    const ok = await page.evaluate(() => {
      const v = (window as any).imViewport;
      v.centerOn(3000, 3000, { scale: 2 });
      const saved = v.getState();
      v.centerOn(7000, 7000, { scale: 5 });
      v.applyState(saved);
      const now = v.getState();
      return Math.abs(now.scale - saved.scale) < 1e-6
        && Math.abs(now.offsetX - saved.offsetX) < 1e-6
        && Math.abs(now.offsetY - saved.offsetY) < 1e-6;
    });
    expect(ok).toBe(true);
  });
});

test.describe('Presenter / follow', () => {
  test('presenting emits collab:viewport-changed on view changes', async ({ page }) => {
    await page.evaluate(() => (window as any).imViewport.setPresenting(true));
    await page.evaluate(() => (window as any).imViewport.centerOn(5000, 5000, { scale: 2 }));
    const ev = await collabOut(page, 'collab:viewport-changed');
    expect(ev.length).toBeGreaterThanOrEqual(2); // snap on enable + the centerOn
    expect(ev.at(-1).detail).toEqual(expect.objectContaining({
      scale: expect.any(Number), centerX: expect.any(Number), centerY: expect.any(Number),
    }));
    // Centre semantics: the shared point is the centreOn target, not a corner.
    expect(ev.at(-1).detail.centerX).toBeCloseTo(5000, 0);
    expect(ev.at(-1).detail.centerY).toBeCloseTo(5000, 0);
  });

  test('not presenting emits nothing', async ({ page }) => {
    await page.evaluate(() => (window as any).imViewport.centerOn(5000, 5000));
    expect(await collabOut(page, 'collab:viewport-changed')).toHaveLength(0);
  });

  test('a remote viewport is smoothly followed to its target', async ({ page }) => {
    // Presenter shares a centre point; the follower converts it to its own offset.
    const expectedOffset = await page.evaluate(() => {
      const st = (window as any).getSimState();
      const cv = document.getElementById('sim-canvas') as HTMLCanvasElement;
      const ts = st.dispScale * 1;
      return { x: 8000 - cv.width / 2 / ts, y: 2000 - cv.height / 2 / ts };
    });
    await emitRemote(page, 'collab:remote-viewport', { scale: 1, centerX: 8000, centerY: 2000 });

    await expect.poll(async () => {
      const st = await page.evaluate(() => (window as any).getSimState());
      return Math.hypot(st.viewOffset.x - expectedOffset.x, st.viewOffset.y - expectedOffset.y);
    }, { timeout: 5000 }).toBeLessThan(2);
  });

  test('manual interaction breaks the follow', async ({ page }) => {
    await emitRemote(page, 'collab:remote-viewport', { scale: 1, centerX: 8000, centerY: 2000 });
    expect(await page.evaluate(() => (window as any).imViewport.following)).toBe(true);

    // A manual wheel pan routes through viewport._apply, which cancels the follow.
    const cv = page.locator('#sim-canvas');
    const box = await cv.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(30, 30);
    expect(await page.evaluate(() => (window as any).imViewport.following)).toBe(false);
  });
});

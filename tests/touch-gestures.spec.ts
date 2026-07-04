// Mobile touch state machine on the sim canvas: a second finger mid-pan
// escalates into pinch-zoom, lifting one pinch finger drops back to panning,
// and after a mask pinch the remaining finger resumes dragging the mask.
// Synthetic TouchEvents are chromium-only (see fixtures).

import { test, expect, addImage, paintPolygon, openPaintStep, closePanel, simPos, groupClientPos, FIXTURE_IMG } from './fixtures';

const view = (page) => page.evaluate(() => {
  const st = (window as any).getSimState();
  return { scale: st.viewScale, x: st.viewOffset.x, y: st.viewOffset.y };
});

const fire = (page, type, touching, changed?) =>
  page.evaluate(({ type, touching, changed }) => {
    const cv = document.getElementById('sim-canvas');
    (window as any).__fireMultiTouch(cv, type, touching, changed);
  }, { type, touching, changed: changed ?? null });

async function setupOne(page) {
  await addImage(page, FIXTURE_IMG);
  await openPaintStep(page);
  await paintPolygon(page);
  await closePanel(page);
  await expect.poll(() => simPos(page, 0)).not.toBeNull();
}

test('pan escalates to pinch-zoom when a second finger lands, then back to pan', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', 'synthetic TouchEvent constructor is unreliable on Firefox desktop');
  await setupOne(page);

  const box = await page.locator('#sim-canvas').boundingBox();
  const x0 = box!.x + 8, y0 = box!.y + 8;

  // One finger down + drift beyond the long-press cancel -> pan.
  await fire(page, 'touchstart', [{ id: 1, x: x0, y: y0 }]);
  await fire(page, 'touchmove', [{ id: 1, x: x0 + 40, y: y0 + 25 }]);
  const v1 = await view(page);

  // Second finger lands mid-pan -> pinch-zoom without lifting.
  await fire(page, 'touchstart', [{ id: 1, x: x0 + 40, y: y0 + 25 }, { id: 2, x: x0 + 160, y: y0 + 140 }], [{ id: 2, x: x0 + 160, y: y0 + 140 }]);
  await fire(page, 'touchmove', [{ id: 1, x: x0 - 20, y: y0 - 20 }, { id: 2, x: x0 + 240, y: y0 + 220 }]);
  const v2 = await view(page);
  expect(v2.scale).toBeGreaterThan(v1.scale);

  // Lift one finger -> the remaining finger keeps panning.
  await fire(page, 'touchend', [{ id: 1, x: x0 - 20, y: y0 - 20 }], [{ id: 2, x: x0 + 240, y: y0 + 220 }]);
  await fire(page, 'touchmove', [{ id: 1, x: x0 - 90, y: y0 - 20 }]);
  const v3 = await view(page);
  expect(v3.scale).toBeCloseTo(v2.scale, 5);
  expect(Math.hypot(v3.x - v2.x, v3.y - v2.y)).toBeGreaterThan(1);

  await fire(page, 'touchend', [], [{ id: 1, x: x0 - 90, y: y0 - 20 }]);
});

test('after a mask pinch, the remaining finger resumes dragging the mask', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', 'synthetic TouchEvent constructor is unreliable on Firefox desktop');
  await setupOne(page);

  const c = await groupClientPos(page, 0);

  // Long-press to lift the mask.
  await fire(page, 'touchstart', [{ id: 1, x: c.x, y: c.y }]);
  await page.waitForTimeout(450); // past the 380ms long-press threshold
  await fire(page, 'touchmove', [{ id: 1, x: c.x + 20, y: c.y }]);
  const p1 = await simPos(page, 0);

  // Second finger -> rotate/scale pinch; spread to change the scale.
  await fire(page, 'touchstart', [{ id: 1, x: c.x + 20, y: c.y }, { id: 2, x: c.x + 140, y: c.y }], [{ id: 2, x: c.x + 140, y: c.y }]);
  await fire(page, 'touchmove', [{ id: 1, x: c.x + 20, y: c.y }, { id: 2, x: c.x + 200, y: c.y }]);

  // Lift the second finger: scale commits AND the drag resumes on finger 1.
  await fire(page, 'touchend', [{ id: 1, x: c.x + 20, y: c.y }], [{ id: 2, x: c.x + 200, y: c.y }]);
  const committed = await page.evaluate(() => (window as any).getSessionMeta().images[0].scale);
  expect(committed).not.toBeNull(); // pinch fixed the scale

  const p2 = await simPos(page, 0);
  await fire(page, 'touchmove', [{ id: 1, x: c.x + 90, y: c.y }]);
  const p3 = await simPos(page, 0);
  expect(p3!.x - p2!.x).toBeGreaterThan(1); // mask follows the remaining finger

  await fire(page, 'touchend', [], [{ id: 1, x: c.x + 90, y: c.y }]);
});

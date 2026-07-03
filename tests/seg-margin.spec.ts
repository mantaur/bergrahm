// Segmentor polygons are clipped to an edge margin (min(128px, 10%) per axis)
// so merges always have blend room at the frame border. Manual painting is
// unaffected. applyMaskAsPolygon is driven directly with synthetic masks --
// no model download involved.

import { test, expect, addImage, openPaintStep, FIXTURE_IMG } from './fixtures';

test('seg polygon spanning the whole image is clipped to the margin', async ({ page }) => {
  await addImage(page, FIXTURE_IMG);
  await openPaintStep(page);

  const r = await page.evaluate(() => {
    const id = (window as any).getSessionMeta().images[0].id;
    const e = (window as any).imgById(id);
    const mask = new Uint8Array(50 * 50).fill(1); // full-coverage mask
    (window as any).applyMaskAsPolygon(mask, 50, 50, id);
    const poly = e.polygons[e.polygons.length - 1];
    return {
      w: e.w, h: e.h, n: e.polygons.length,
      mx: Math.min(128, e.w * 0.1), my: Math.min(128, e.h * 0.1),
      minX: Math.min(...poly.map((p: any) => p.x)),
      maxX: Math.max(...poly.map((p: any) => p.x)),
      minY: Math.min(...poly.map((p: any) => p.y)),
      maxY: Math.max(...poly.map((p: any) => p.y)),
    };
  });

  expect(r.n).toBe(1);
  expect(r.minX).toBeGreaterThanOrEqual(r.mx - 0.01);
  expect(r.maxX).toBeLessThanOrEqual(r.w - r.mx + 0.01);
  expect(r.minY).toBeGreaterThanOrEqual(r.my - 0.01);
  expect(r.maxY).toBeLessThanOrEqual(r.h - r.my + 0.01);
});

test('a segment entirely inside the margin is rejected', async ({ page }) => {
  await addImage(page, FIXTURE_IMG);
  await openPaintStep(page);

  const r = await page.evaluate(() => {
    const id = (window as any).getSessionMeta().images[0].id;
    const e = (window as any).imgById(id);
    // 2px-wide strip on the far left of mask space -> lands inside the margin.
    const mask = new Uint8Array(50 * 50);
    for (let y = 0; y < 50; y++) {
      mask[y * 50] = 1;
      mask[y * 50 + 1] = 1;
    }
    (window as any).applyMaskAsPolygon(mask, 50, 50, id);
    return { n: e.polygons.length, status: document.getElementById('yolo-status')?.textContent || '' };
  });

  expect(r.n).toBe(0);
});

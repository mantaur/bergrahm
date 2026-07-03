// Segmentor polygons keep out of a 7%-per-axis edge margin so merges have
// blend room at the frame border: vertices inside the margin are dropped and
// the surviving neighbors connect directly. Manual painting is unaffected.
// applyMaskAsPolygon is driven directly with synthetic masks -- no model.

import { test, expect, addImage, openPaintStep, FIXTURE_IMG } from './fixtures';

test('margin vertices are dropped; the rest of the segment survives', async ({ page }) => {
  await addImage(page, FIXTURE_IMG);
  await openPaintStep(page);

  const r = await page.evaluate(() => {
    const id = (window as any).getSessionMeta().images[0].id;
    const e = (window as any).imgById(id);
    // Filled circle spanning the center and bulging into the left margin.
    const mask = new Uint8Array(50 * 50);
    for (let y = 0; y < 50; y++)
      for (let x = 0; x < 50; x++)
        if ((x - 20) ** 2 + (y - 25) ** 2 <= 18 ** 2) mask[y * 50 + x] = 1;
    (window as any).applyMaskAsPolygon(mask, 50, 50, id);
    const poly = e.polygons[e.polygons.length - 1] || [];
    return {
      w: e.w, h: e.h, n: e.polygons.length, pts: poly.length,
      mx: e.w * 0.07, my: e.h * 0.07,
      minX: Math.min(...poly.map((p: any) => p.x)),
      maxX: Math.max(...poly.map((p: any) => p.x)),
      minY: Math.min(...poly.map((p: any) => p.y)),
      maxY: Math.max(...poly.map((p: any) => p.y)),
    };
  });

  expect(r.n).toBe(1);
  expect(r.pts).toBeGreaterThanOrEqual(3);
  expect(r.minX).toBeGreaterThanOrEqual(r.mx);
  expect(r.maxX).toBeLessThanOrEqual(r.w - r.mx);
  expect(r.minY).toBeGreaterThanOrEqual(r.my);
  expect(r.maxY).toBeLessThanOrEqual(r.h - r.my);
});

test('a segment entirely inside the margin is rejected', async ({ page }) => {
  await addImage(page, FIXTURE_IMG);
  await openPaintStep(page);

  const n = await page.evaluate(() => {
    const id = (window as any).getSessionMeta().images[0].id;
    // 2px-wide strip on the far left of mask space -> lands inside the margin.
    const mask = new Uint8Array(50 * 50);
    for (let y = 0; y < 50; y++) {
      mask[y * 50] = 1;
      mask[y * 50 + 1] = 1;
    }
    (window as any).applyMaskAsPolygon(mask, 50, 50, id);
    return (window as any).imgById(id).polygons.length;
  });

  expect(n).toBe(0);
});

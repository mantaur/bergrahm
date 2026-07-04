// Adding images + painting / editing polygon masks.

import {
  test, expect, addImage, paintPolygon, openPaintStep,
  polyCount, collabOut, imgIdAt, FIXTURE_IMG, FIXTURE_IMG2,
} from './fixtures';

test('the made-by credit replaces the app bar and links to the homepage', async ({ page }) => {
  await expect(page.locator('.im-appbar')).toHaveCount(0); // top bar removed
  const link = page.locator('.im-made-by a');
  await expect(link).toHaveText('Bergrahm');
  await expect(link).toHaveAttribute('href', /index\.html$/);
});

test.describe('Add image', () => {
  test('reveals paint area, unlocks paint step, updates meta', async ({ page }) => {
    await addImage(page);
    await expect(page.locator('#paint-area')).not.toHaveClass(/im-hidden/);
    await expect(page.locator('#rank-list > li')).toHaveCount(1);
    await expect(page.locator('#step-paint')).not.toHaveClass(/im-step-locked/);
    await expect(page.locator('#smeta-images')).toHaveText('1 image');
  });

  test('emits collab:images-added with the new image id', async ({ page }) => {
    await addImage(page);
    const events = await collabOut(page, 'collab:images-added');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.at(-1).detail.ids).toContain(await imgIdAt(page, 0));
  });
});

test.describe('Polygon mask', () => {
  test('painting a closed polygon records one polygon + emits change', async ({ page }) => {
    await addImage(page);
    await paintPolygon(page);
    expect(await polyCount(page, 0)).toBe(1);
    const events = await collabOut(page, 'collab:polygon-changed');
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  test('undo button enables after a vertex and reverts the polygon', async ({ page }) => {
    await addImage(page);
    await openPaintStep(page);

    // A single vertex enables undo; undo it back to a clean slate.
    await page.locator('#canvas-wrap').click({ position: { x: 40, y: 40 } });
    await expect(page.locator('#btn-undo')).toBeEnabled();
    await page.locator('#btn-undo').click();
    await expect(page.locator('#btn-undo')).toBeDisabled();

    // Paint a full polygon, then undo the close to drop it.
    await paintPolygon(page, [{ x: 60, y: 60 }, { x: 150, y: 60 }, { x: 100, y: 140 }]);
    expect(await polyCount(page, 0)).toBe(1);
    await page.locator('#btn-undo').click();
    expect(await polyCount(page, 0)).toBe(0);
  });

  test('clear mask empties polygons and broadcasts empty change', async ({ page }) => {
    await addImage(page);
    await paintPolygon(page);
    expect(await polyCount(page, 0)).toBe(1);
    await page.locator('#btn-clear-mask').click();
    expect(await polyCount(page, 0)).toBe(0);
    const events = await collabOut(page, 'collab:polygon-changed');
    expect(events.at(-1).detail.polygons).toHaveLength(0);
  });

  // On a multi-megapixel image the painter caps the canvas backing store (so mobile
  // browsers don't blank a ~50MB canvas), but polygon coordinates MUST stay in
  // image-pixel space -- that's what merge, cross-peer sync and saved sessions use.
  // A regression of that decoupling would clamp coords to the small backing store.
  test('polygon coordinates stay in image-pixel space on a large (capped) canvas', async ({ page }) => {
    const W = 2400, H = 1600;
    const dataUrl = await page.evaluate(({ w, h }) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const x = c.getContext('2d')!;
      x.fillStyle = '#3a6';
      x.fillRect(0, 0, w, h);
      return c.toDataURL('image/png');
    }, { w: W, h: H });
    await page.locator('#cfg-images').setInputFiles({
      name: 'big.png',
      mimeType: 'image/png',
      buffer: Buffer.from(dataUrl.split(',')[1], 'base64'),
    });
    await expect(page.locator('#paint-area')).not.toHaveClass(/im-hidden/);
    await openPaintStep(page);

    const wrap = page.locator('#canvas-wrap');
    const box = (await wrap.boundingBox())!;
    const f = (fx: number, fy: number) => ({ x: box.width * fx, y: box.height * fy });
    const verts = [f(0.25, 0.25), f(0.75, 0.25), f(0.5, 0.75)];
    for (const v of verts) await wrap.click({ position: v });
    await wrap.click({ position: verts[0] }); // close

    expect(await polyCount(page, 0)).toBe(1);
    const poly = await page.evaluate(() => (window as any).getSessionMeta().images[0].polygons[0]);
    const xs = poly.map((p: any) => p.x);
    const ys = poly.map((p: any) => p.y);
    // Right vertex sits near 0.75*W in IMAGE pixels (not clamped to the ~860px store),
    // and nothing escapes the image bounds.
    expect(Math.max(...xs)).toBeGreaterThan(W * 0.5);
    expect(Math.max(...xs)).toBeLessThanOrEqual(W + 1);
    expect(Math.max(...ys)).toBeLessThanOrEqual(H + 1);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1);
  });
});

test.describe('Advanced settings', () => {
  test('disclosure toggles the advanced panel + aria-expanded', async ({ page }) => {
    await addImage(page); // Output row + disclosure live in the now-visible paint area
    const toggle = page.locator('#btn-adv-toggle');
    const panel  = page.locator('#adv-panel');

    await expect(panel).toHaveClass(/im-hidden/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveText('Show more');

    await toggle.click();
    await expect(panel).not.toHaveClass(/im-hidden/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveText('Hide');

    await toggle.click();
    await expect(panel).toHaveClass(/im-hidden/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveText('Show more');
  });
});

test.describe('Image navigation', () => {
  test('prev/next moves through images and updates the index label', async ({ page }) => {
    await addImage(page, [FIXTURE_IMG, FIXTURE_IMG2]);
    await openPaintStep(page);
    await expect(page.locator('#paint-index-label')).toHaveText('1 / 2');
    await expect(page.locator('#btn-prev-img')).toBeDisabled();

    await page.locator('#btn-next-img').click();
    await expect(page.locator('#paint-index-label')).toHaveText('2 / 2');
    await expect(page.locator('#btn-next-img')).toBeDisabled();

    await page.locator('#btn-prev-img').click();
    await expect(page.locator('#paint-index-label')).toHaveText('1 / 2');
  });
});

// Adding images + painting / editing polygon masks.

import {
  test, expect, addImage, paintPolygon, openPaintStep,
  polyCount, collabOut, FIXTURE_IMG, FIXTURE_IMG2,
} from './fixtures';

test.describe('Add image', () => {
  test('reveals paint area, unlocks paint step, updates meta', async ({ page }) => {
    await addImage(page);
    await expect(page.locator('#paint-area')).not.toHaveClass(/im-hidden/);
    await expect(page.locator('#rank-list > li')).toHaveCount(1);
    await expect(page.locator('#step-paint')).not.toHaveClass(/im-step-locked/);
    await expect(page.locator('#smeta-images')).toHaveText('1 image');
  });

  test('emits collab:images-added', async ({ page }) => {
    await addImage(page);
    const events = await collabOut(page, 'collab:images-added');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.at(-1).detail.indices).toContain(0);
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

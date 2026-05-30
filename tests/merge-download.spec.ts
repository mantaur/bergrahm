// Merge -> preview -> download. Merge runs an inline Worker + OffscreenCanvas.

import { test, expect, addImage, paintPolygon, closePanel } from './fixtures';

test('merge button appears after a mask is painted', async ({ page }) => {
  await addImage(page);
  await expect(page.locator('#btn-merge')).toBeHidden();
  await paintPolygon(page);
  await expect(page.locator('#btn-merge')).toBeVisible();
});

test('merge produces a downloadable result', async ({ page }) => {
  await addImage(page);
  await paintPolygon(page);
  await closePanel(page);

  await page.locator('#btn-merge').click();

  // Merge worker + render finishes -> download appears, merge button hides.
  await expect(page.locator('#btn-download')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#btn-merge')).toBeHidden();
  await expect(page.locator('#btn-cancel')).toBeHidden();
  await expect(page.locator('#sim-status')).toHaveText(/Merged/);

  // Full-res download is a PNG named merged.png.
  const dl = page.waitForEvent('download');
  await page.locator('#btn-download').click();
  expect((await dl).suggestedFilename()).toBe('merged.png');
});

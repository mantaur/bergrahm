// Output-size presets + carousel slicing.

import { test, expect, addImage, paintPolygon, closePanel } from './fixtures';

const outW = (page: any) => page.evaluate(() => (window as any).getCollabState().outW);

test('size preset sets the output dimensions', async ({ page }) => {
  await addImage(page);
  await page.locator('#cfg-size-preset').selectOption('1080x1350');
  await expect(page.locator('#cfg-width')).toHaveValue('1080');
  await expect(page.locator('#cfg-height')).toHaveValue('1350');
  expect(await outW(page)).toBe(1080);
});

test('slides multiply the preset width (carousel)', async ({ page }) => {
  await addImage(page);
  await page.locator('#cfg-size-preset').selectOption('1080x1920');
  await page.locator('#cfg-slides').fill('3'); // 1080 * 3
  await expect(page.locator('#cfg-width')).toHaveValue('3240');
  await expect(page.locator('#cfg-height')).toHaveValue('1920');
  expect(await outW(page)).toBe(3240);
});

test('carousel (slides>1) downloads a zip of slices', async ({ page }) => {
  await addImage(page);
  await paintPolygon(page);
  // Small canvas keeps the merge quick; slides>1 still drives the slice+zip path.
  await page.locator('#cfg-width').fill('600');
  await page.locator('#cfg-height').fill('400');
  await page.locator('#cfg-slides').fill('2');
  await closePanel(page);

  await page.locator('#btn-merge').click();
  await expect(page.locator('#btn-download')).toBeVisible({ timeout: 30000 });

  const dl = page.waitForEvent('download');
  await page.locator('#btn-download').click();
  expect((await dl).suggestedFilename()).toBe('carousel.zip');
});

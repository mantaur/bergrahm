// Output-size presets + carousel slicing.

import { test, expect, addImage, paintPolygon, closePanel } from './fixtures';
import path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));

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
  // Preload the vendored JSZip so the download path doesn't depend on the app's
  // CDN <script> injection -- which is slow under load and unroutable on Firefox.
  await page.addScriptTag({ path: path.join(_dir, 'vendor', 'jszip.min.js') });
  await addImage(page);
  await paintPolygon(page);
  // Tiny canvas keeps the merge trivial; slides>1 still drives the slice+zip path.
  await page.locator('#cfg-width').fill('200');
  await page.locator('#cfg-height').fill('200');
  await page.locator('#cfg-slides').fill('2');
  await closePanel(page);

  await page.locator('#btn-merge').click();
  await expect(page.locator('#btn-download')).toBeVisible({ timeout: 30000 });

  // Dispatch the click straight to the download button: in the FAB the Merge
  // button can momentarily overlap it, which trips Playwright's hit-test.
  const dl = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('#btn-download').dispatchEvent('click');
  expect((await dl).suggestedFilename()).toBe('carousel.zip');
});

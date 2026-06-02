// Merge -> preview -> download. Merge runs an inline Worker + OffscreenCanvas.

import { test, expect, addImage, paintPolygon, closePanel, emitRemote, imgIdAt, simPos } from './fixtures';

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

test('a remote move drops the merged preview so live masks show again', async ({ page }) => {
  await addImage(page);
  await paintPolygon(page);
  await closePanel(page);

  await page.locator('#btn-merge').click();
  await expect(page.locator('#btn-download')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#btn-merge')).toBeHidden(); // merged preview is up

  // A peer grabs/moves a mask: the preview hides every mask, so it must clear and
  // return to the live view (merge button reappears, download hidden).
  const id = await imgIdAt(page, 0);
  const p = await simPos(page, 0);
  await emitRemote(page, 'collab:remote-drag', { imgIdx: id, x: p!.x + 200, y: p!.y + 150, angle: 0 });

  await expect(page.locator('#btn-merge')).toBeVisible();
  await expect(page.locator('#btn-download')).toBeHidden();
});

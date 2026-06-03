// Merge -> preview -> download. Merge runs an inline Worker + OffscreenCanvas.

import { test, expect, addImage, paintPolygon, closePanel, emitRemote, imgIdAt, simPos, groupClientPos } from './fixtures';

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

test('a peer move keeps the merged preview; a local grab clears it', async ({ page }) => {
  await addImage(page);
  await paintPolygon(page);
  await closePanel(page);

  await page.locator('#btn-merge').click();
  await expect(page.locator('#btn-download')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#btn-merge')).toBeHidden(); // merged preview is up

  // A peer moves a mask: the preview is KEPT (the moving mask is drawn over it),
  // not dropped.
  const id = await imgIdAt(page, 0);
  const p = await simPos(page, 0);
  await emitRemote(page, 'collab:remote-grab', { imgIdx: id, color: '#fff' });
  await emitRemote(page, 'collab:remote-drag', { imgIdx: id, x: p!.x + 60, y: p!.y + 40, angle: 0 });
  await page.waitForTimeout(150);
  await expect(page.locator('#btn-merge')).toBeHidden();
  await expect(page.locator('#btn-download')).toBeVisible();
  await emitRemote(page, 'collab:remote-release', { imgIdx: id });

  // The local user grabbing a mask DOES clear the preview.
  const c = await groupClientPos(page, 0);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator('#btn-merge')).toBeVisible();
  await expect(page.locator('#btn-download')).toBeHidden();
});

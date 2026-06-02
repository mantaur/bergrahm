// Session export + import. Consumes tests/fixtures/session.zip (2 imgs, img0 has
// 1 polygon) produced by session.setup.ts.

import { test, expect, addImage, paintPolygon, imageCount, polyCount, collabOut, FIXTURE_IMG } from './fixtures';
import path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const SESSION_ZIP = path.join(_dir, 'fixtures', 'session.zip');

test.describe('Session export', () => {
  test('exports a zip and reports Exported', async ({ page }) => {
    await addImage(page);
    await paintPolygon(page);
    await page.locator('#step-images .im-step-hd').click();

    const exportBtn = page.locator('#btn-export-session');
    await expect(exportBtn).toBeEnabled();

    const dl = page.waitForEvent('download');
    await exportBtn.click();
    expect((await dl).suggestedFilename()).toBe('merger-session.zip');
    await expect(page.locator('#session-status')).toHaveText(/Exported/, { timeout: 15000 });
  });
});

test.describe('Session import', () => {
  test('imports into an empty app (replace path, no confirm)', async ({ page }) => {
    await page.locator('#inp-import-session').setInputFiles(SESSION_ZIP);
    // Empty app -> no confirm dialog; images load directly.
    await expect(page.locator('#session-confirm')).toHaveClass(/im-hidden/);
    await expect.poll(() => imageCount(page)).toBe(2);
    await expect(page.locator('#paint-area')).not.toHaveClass(/im-hidden/);
    await expect(page.locator('#step-paint')).not.toHaveClass(/im-step-locked/);
    await expect(page.locator('#rank-list > li')).toHaveCount(2);
    expect(await polyCount(page, 0)).toBe(1); // restored mask

    // A local import fires collab:session-loaded so a host re-streams to guests
    // (and any guest prompt is dismissed). See collaborate.js.
    expect((await collabOut(page, 'collab:session-loaded')).length).toBeGreaterThanOrEqual(1);
  });

  test('shows confirm dialog when a session is already active', async ({ page }) => {
    await addImage(page);
    await page.locator('#inp-import-session').setInputFiles(SESSION_ZIP);
    await expect(page.locator('#session-confirm')).not.toHaveClass(/im-hidden/);
  });

  test('Replace wipes existing and loads the imported session', async ({ page }) => {
    await addImage(page, FIXTURE_IMG); // 1 image
    await page.locator('#inp-import-session').setInputFiles(SESSION_ZIP);
    await page.locator('#btn-sess-replace').click();
    await expect.poll(() => imageCount(page)).toBe(2);
    await expect(page.locator('#rank-list > li')).toHaveCount(2);
  });

  test('Add appends the imported session to existing images', async ({ page }) => {
    await addImage(page, FIXTURE_IMG); // 1 image
    await page.locator('#inp-import-session').setInputFiles(SESSION_ZIP);
    await page.locator('#btn-sess-add').click();
    await expect.poll(() => imageCount(page)).toBe(3); // 1 + 2
    await expect(page.locator('#rank-list > li')).toHaveCount(3);
  });

  test('Cancel leaves existing state untouched', async ({ page }) => {
    await addImage(page, FIXTURE_IMG); // 1 image
    await page.locator('#inp-import-session').setInputFiles(SESSION_ZIP);
    await page.locator('#btn-sess-cancel').click();
    await expect(page.locator('#session-confirm')).toHaveClass(/im-hidden/);
    expect(await imageCount(page)).toBe(1);
  });
});

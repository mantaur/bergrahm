// Setup project: builds tests/fixtures/session.zip consumed by session-io.spec.ts.
// Doubles as the export-flow validation (export is exercised here end to end).

import { test as setup, expect, addImage, paintPolygon, FIXTURE_IMG2 } from './fixtures';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(_dir, 'fixtures', 'session.zip');

setup('build session.zip fixture (exports a 2-image session)', async ({ page }) => {
  // Two images so import tests can assert a meaningful count; paint a polygon on
  // the first so restoration of masks is verifiable.
  await addImage(page, [FIXTURE_IMG2, FIXTURE_IMG2]);
  await paintPolygon(page);
  expect(await page.locator('#step-paint')).toBeTruthy();

  // Reopen step-images (painting opened step-paint and collapsed it).
  await page.locator('#step-images .im-step-hd').click();
  await expect(page.locator('#step-images')).toHaveClass(/im-step-open/);

  const exportBtn = page.locator('#btn-export-session');
  await expect(exportBtn).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await exportBtn.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('merger-session.zip');
  await download.saveAs(OUT);

  // Status reaches "Exported" and the file is non-trivial.
  await expect(page.locator('#session-status')).toHaveText(/Exported/, { timeout: 15000 });
  expect(fs.statSync(OUT).size).toBeGreaterThan(200);
});

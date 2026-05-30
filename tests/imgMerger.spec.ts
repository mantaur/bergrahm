// Uses the routed fixture (CDNs -> local vendor) so the suite runs offline.
import { test, expect, PAGE, FIXTURE_IMG } from './fixtures';

test.describe('Initial UI state', () => {
  test.beforeEach(async ({ page }) => { await page.goto(PAGE); });

  test('sim canvas is visible', async ({ page }) => {
    await expect(page.locator('#sim-canvas')).toBeVisible();
  });

  test('floating action bar is visible', async ({ page }) => {
    await expect(page.locator('#sim-hud')).toBeVisible();
    await expect(page.locator('#btn-collab')).toBeVisible();
    await expect(page.locator('#btn-sim-undo')).toBeVisible();
    await expect(page.locator('#btn-sim-redo')).toBeVisible();
    await expect(page.locator('#btn-sim-reset')).toBeVisible();
  });

  test('panel toggle button is visible', async ({ page }) => {
    await expect(page.locator('#btn-panel-toggle')).toBeVisible();
  });

  test('undo and redo start disabled', async ({ page }) => {
    await expect(page.locator('#btn-sim-undo')).toBeDisabled();
    await expect(page.locator('#btn-sim-redo')).toBeDisabled();
  });

  test('reset starts enabled', async ({ page }) => {
    await expect(page.locator('#btn-sim-reset')).toBeEnabled();
  });

  test('merge, cancel and download start hidden', async ({ page }) => {
    await expect(page.locator('#btn-merge')).toBeHidden();
    await expect(page.locator('#btn-cancel')).toBeHidden();
    await expect(page.locator('#btn-download')).toBeHidden();
  });

  test('sidebar starts closed', async ({ page }) => {
    await expect(page.locator('#panel-wrap')).toHaveClass(/im-panel-hidden/);
  });
});

test.describe('Sidebar', () => {
  test.beforeEach(async ({ page }) => { await page.goto(PAGE); });

  test('toggle button opens and closes panel', async ({ page }) => {
    const panel = page.locator('#panel-wrap');
    await page.locator('#btn-panel-toggle').click();
    await expect(panel).not.toHaveClass(/im-panel-hidden/);
    await page.locator('#btn-panel-toggle').click();
    await expect(panel).toHaveClass(/im-panel-hidden/);
  });

  test('advanced panel toggles via More button', async ({ page }) => {
    await page.locator('#btn-panel-toggle').click();
    await page.locator('#cfg-images').setInputFiles(FIXTURE_IMG);
    await expect(page.locator('#paint-area')).not.toHaveClass(/im-hidden/);
    await expect(page.locator('#adv-panel')).toHaveClass(/im-hidden/);
    await page.locator('#btn-adv-toggle').click();
    await expect(page.locator('#adv-panel')).not.toHaveClass(/im-hidden/);
    await page.locator('#btn-adv-toggle').click();
    await expect(page.locator('#adv-panel')).toHaveClass(/im-hidden/);
  });
});

test.describe('Collab modal', () => {
  test.beforeEach(async ({ page }) => { await page.goto(PAGE); });

  test('opens via collab button', async ({ page }) => {
    await expect(page.locator('#collab-modal')).toHaveClass(/im-hidden/);
    await page.locator('#btn-collab').click();
    await expect(page.locator('#collab-modal')).not.toHaveClass(/im-hidden/);
  });

  test('closes via X button', async ({ page }) => {
    await page.locator('#btn-collab').click();
    await page.locator('#btn-collab-close').click();
    await expect(page.locator('#collab-modal')).toHaveClass(/im-hidden/);
  });

  test('closes via Escape key', async ({ page }) => {
    await page.locator('#btn-collab').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#collab-modal')).toHaveClass(/im-hidden/);
  });
});

test.describe('Session import', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(PAGE);
    await page.locator('#btn-panel-toggle').click();
  });

  test('import session button is visible', async ({ page }) => {
    await expect(page.locator('#section-paint label[for="inp-import-session"]')).toBeVisible();
  });

  test('file input accepts only .zip', async ({ page }) => {
    await expect(page.locator('#inp-import-session')).toHaveAttribute('accept', '.zip');
  });

  test('export session starts disabled', async ({ page }) => {
    await expect(page.locator('#btn-export-session')).toBeDisabled();
  });
});

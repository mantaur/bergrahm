// Multi-select + move-together: build a selection (shift/cmd-click, marquee,
// Ctrl/Cmd+A) and drag the whole set as one. Desktop drives the shared core via
// the mouse; the mobile select-mode tap path reuses the same selection helpers.

import {
  test, expect, addImage, paintPolygon, openPaintStep, closePanel,
  simPos, groupClientPos, FIXTURE_IMG, FIXTURE_IMG2,
} from './fixtures';

const selectedIds = (page) => page.evaluate(() => (window as any).getSelectedIds());
const undoCount   = (page) => page.evaluate(() => (window as any).getUndoState().undo);

// Two images, each with a polygon -> two draggable sim groups in a grid.
async function setupTwo(page) {
  await addImage(page, [FIXTURE_IMG, FIXTURE_IMG2]);
  await openPaintStep(page);
  await paintPolygon(page);                  // image 0 (paintIdx starts at 0)
  await page.locator('#btn-next-img').click();
  await paintPolygon(page);                  // image 1
  await closePanel(page);
  await expect.poll(() => simPos(page, 0)).not.toBeNull();
  await expect.poll(() => simPos(page, 1)).not.toBeNull();
}

test('shift-click toggles masks into the selection', async ({ page }) => {
  await setupTwo(page);
  await page.keyboard.down('Shift');
  const c0 = await groupClientPos(page, 0);
  await page.mouse.click(c0.x, c0.y);
  const c1 = await groupClientPos(page, 1);
  await page.mouse.click(c1.x, c1.y);
  await page.keyboard.up('Shift');
  expect((await selectedIds(page)).length).toBe(2);

  // Shift-click an already-selected mask removes it.
  await page.keyboard.down('Shift');
  await page.mouse.click(c0.x, c0.y);
  await page.keyboard.up('Shift');
  expect((await selectedIds(page)).length).toBe(1);
});

test('Ctrl/Cmd+A selects all, Escape clears', async ({ page }) => {
  await setupTwo(page);
  await page.keyboard.press('Control+a');
  expect((await selectedIds(page)).length).toBe(2);
  await page.keyboard.press('Escape');
  expect((await selectedIds(page)).length).toBe(0);
});

test('marquee drag over empty space selects enclosed masks', async ({ page }) => {
  await setupTwo(page);
  // Drag a near-full-canvas marquee from an empty corner; both centroids fall in.
  const box = await page.locator('#sim-canvas').boundingBox();
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 12 });
  await page.mouse.up();
  expect((await selectedIds(page)).length).toBe(2);
});

test('dragging a selected mask moves the whole set as one undo entry', async ({ page }) => {
  await setupTwo(page);
  await page.keyboard.press('Control+a');
  expect((await selectedIds(page)).length).toBe(2);

  const b0 = await simPos(page, 0), b1 = await simPos(page, 1);
  const undoBefore = await undoCount(page);
  const c0 = await groupClientPos(page, 0);
  await page.mouse.move(c0.x, c0.y);
  await page.mouse.down();
  await page.mouse.move(c0.x + 80, c0.y + 60, { steps: 12 });
  await page.mouse.up();

  const a0 = await simPos(page, 0), a1 = await simPos(page, 1);
  // Both moved, and by the same world-space delta (translate-together).
  expect(Math.hypot(a0.x - b0.x, a0.y - b0.y)).toBeGreaterThan(1);
  expect(Math.abs((a0.x - b0.x) - (a1.x - b1.x))).toBeLessThan(0.5);
  expect(Math.abs((a0.y - b0.y) - (a1.y - b1.y))).toBeLessThan(0.5);
  // One snapshot for the whole group move.
  expect(await undoCount(page)).toBe(undoBefore + 1);
});

test('plain drag of a non-member mask drops the selection', async ({ page }) => {
  await setupTwo(page);
  // Select just mask 1.
  await page.keyboard.down('Shift');
  const c1 = await groupClientPos(page, 1);
  await page.mouse.click(c1.x, c1.y);
  await page.keyboard.up('Shift');
  expect((await selectedIds(page)).length).toBe(1);

  // Plain-drag mask 0 -> selection cleared; mask 1 stays put.
  const b1 = await simPos(page, 1);
  const c0 = await groupClientPos(page, 0);
  await page.mouse.move(c0.x, c0.y);
  await page.mouse.down();
  await page.mouse.move(c0.x + 60, c0.y + 40, { steps: 8 });
  await page.mouse.up();

  expect((await selectedIds(page)).length).toBe(0);
  const a1 = await simPos(page, 1);
  expect(Math.hypot(a1.x - b1.x, a1.y - b1.y)).toBeLessThan(0.5);
});

test('mobile select mode: tap toggles a mask (chromium)', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', 'synthetic TouchEvent constructor is unreliable on Firefox desktop');
  await setupTwo(page);
  await page.evaluate(() => (window as any).setSimSelectMode(true));
  await expect(page.locator('#btn-sim-select')).toHaveClass(/is-active/);

  const c = await groupClientPos(page, 0);
  await page.evaluate(({ x, y }) => {
    const cv = document.getElementById('sim-canvas') as HTMLCanvasElement;
    const t  = new Touch({ identifier: 1, target: cv, clientX: x, clientY: y });
    const ev = (type: string, touches: Touch[]) => new TouchEvent(type, {
      touches, targetTouches: touches, changedTouches: [t], bubbles: true, cancelable: true,
    });
    cv.dispatchEvent(ev('touchstart', [t]));
    cv.dispatchEvent(ev('touchend', []));
  }, c);
  expect((await selectedIds(page)).length).toBe(1);

  // Leaving select mode clears the selection.
  await page.evaluate(() => (window as any).setSimSelectMode(false));
  expect((await selectedIds(page)).length).toBe(0);
});

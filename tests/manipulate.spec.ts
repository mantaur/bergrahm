// Manipulating a mask in the sim: move (drag), scale+rotate (Ctrl+drag), reset,
// and sim undo/redo. A draggable group exists once an image has a polygon.

import {
  test, expect, addImage, paintPolygon, closePanel,
  simPos, imageScale, groupClientPos, collabOut,
} from './fixtures';

const IDX = 0;

async function setup(page) {
  await addImage(page);
  await paintPolygon(page);
  await closePanel(page);
  // Group must exist before we can drag it.
  await expect.poll(() => simPos(page, IDX)).not.toBeNull();
}

test('drag moves the image and emits grab/release', async ({ page }) => {
  await setup(page);
  const before = await simPos(page, IDX);
  const c = await groupClientPos(page, IDX);

  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 70, c.y + 50, { steps: 10 });
  await page.mouse.up();

  const after = await simPos(page, IDX);
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(1);
  expect((await collabOut(page, 'collab:body-grabbing')).length).toBeGreaterThanOrEqual(1);
  expect((await collabOut(page, 'collab:body-releasing')).length).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#btn-sim-undo')).toBeEnabled();
});

test('Ctrl+drag scales and rotates the image', async ({ page }) => {
  await setup(page);
  expect(await imageScale(page, IDX)).toBeNull(); // auto scale initially
  const c = await groupClientPos(page, IDX);

  await page.keyboard.down('Control');
  await page.mouse.move(c.x, c.y); // grab at centre (guaranteed inside the body)
  await page.mouse.down();
  // Arc the cursor around the centre: first move sets the angle/radius reference,
  // subsequent moves rotate (and vary distance -> scale).
  await page.mouse.move(c.x + 55, c.y, { steps: 5 });
  await page.mouse.move(c.x, c.y + 75, { steps: 5 });
  await page.mouse.move(c.x - 55, c.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Control');

  expect(await imageScale(page, IDX)).not.toBeNull(); // scale became explicit
  const after = await simPos(page, IDX);
  expect(Math.abs(after.angle)).toBeGreaterThan(0.05); // rotated
});

test('reset repositions the image', async ({ page }) => {
  await setup(page);
  const c = await groupClientPos(page, IDX);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 80, c.y + 60, { steps: 10 });
  await page.mouse.up();
  const moved = await simPos(page, IDX);

  await page.locator('#btn-sim-reset').click();
  const reset = await simPos(page, IDX);
  expect(Math.hypot(reset.x - moved.x, reset.y - moved.y)).toBeGreaterThan(1);
});

test('sim undo restores and redo re-applies a move', async ({ page }) => {
  await setup(page);
  const before = await simPos(page, IDX);
  const c = await groupClientPos(page, IDX);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 80, c.y + 60, { steps: 10 });
  await page.mouse.up();
  const moved = await simPos(page, IDX);

  await page.locator('#btn-sim-undo').click();
  const undone = await simPos(page, IDX);
  expect(Math.hypot(undone.x - before.x, undone.y - before.y)).toBeLessThan(1);

  await expect(page.locator('#btn-sim-redo')).toBeEnabled();
  await page.locator('#btn-sim-redo').click();
  const redone = await simPos(page, IDX);
  expect(Math.hypot(redone.x - moved.x, redone.y - moved.y)).toBeLessThan(1);
});

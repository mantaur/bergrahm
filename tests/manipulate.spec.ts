// Manipulating a mask in the sim: move (drag), scale+rotate (Ctrl+drag), reset,
// and sim undo/redo. A draggable group exists once an image has a polygon.

import {
  test, expect, addImage, paintPolygon, closePanel,
  simPos, imageScale, groupClientPos, collabOut, emitRemote, imgIdAt,
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

test('sim undo restores scale and angle after a Ctrl+drag', async ({ page }) => {
  await setup(page);
  expect(await imageScale(page, IDX)).toBeNull(); // auto scale initially
  const c = await groupClientPos(page, IDX);

  await page.keyboard.down('Control');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 55, c.y, { steps: 5 });
  await page.mouse.move(c.x, c.y + 75, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Control');

  expect(await imageScale(page, IDX)).not.toBeNull();                 // scale became explicit
  expect(Math.abs((await simPos(page, IDX)).angle)).toBeGreaterThan(0.05); // rotated

  // The unified snapshot captures scale, so undo restores BOTH scale and angle
  // (the old move-only entry left scale stuck -> the drift we set out to fix).
  await page.locator('#btn-sim-undo').click();
  expect(await imageScale(page, IDX)).toBeNull();                     // scale back to auto
  expect(Math.abs((await simPos(page, IDX)).angle)).toBeLessThan(0.01); // angle back to 0
});

test('Ctrl+drag broadcasts the committed scale to peers', async ({ page }) => {
  await setup(page);
  const c = await groupClientPos(page, IDX);

  await page.keyboard.down('Control');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 55, c.y, { steps: 5 });
  await page.mouse.move(c.x, c.y + 75, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Control');

  const scale = await imageScale(page, IDX);
  expect(scale).not.toBeNull(); // scale committed locally

  // The gesture must put that scale on the wire (it used to broadcast nothing,
  // so peers kept the old/auto scale).
  const events = await collabOut(page, 'collab:scales-changed');
  expect(events.length).toBeGreaterThanOrEqual(1);
  const id = await imgIdAt(page, IDX);
  expect(events[events.length - 1].detail.scales[id]).toBeCloseTo(scale as number, 2);
});

test('Ctrl+drag streams the live scale, and an inbound remote scale previews', async ({ page }) => {
  await setup(page);
  const c = await groupClientPos(page, IDX);

  // While Ctrl-dragging, the live drag stream should carry scale (not just on commit).
  await page.keyboard.down('Control');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 55, c.y, { steps: 4 });
  await page.mouse.move(c.x, c.y + 75, { steps: 4 });
  await page.waitForTimeout(80); // let the sim rAF broadcast at least once
  const dragEvents = await collabOut(page, 'collab:body-dragging');
  expect(dragEvents.some(e => typeof e.detail.scale === 'number')).toBe(true);
  await page.mouse.up();
  await page.keyboard.up('Control');

  // Inbound: a remote drag carrying scale sets a live (render-only) preview.
  const id = await imgIdAt(page, IDX);
  const p = await simPos(page, IDX);
  await emitRemote(page, 'collab:remote-drag', { imgIdx: id, x: p!.x, y: p!.y, angle: 0, scale: 2.5 });
  expect(await page.evaluate((i) => (window as any).getRemoteScalePreview(i), id)).toBeCloseTo(2.5, 2);

  // The committed scale (remote-scales) clears the preview.
  await emitRemote(page, 'collab:remote-scales', { scales: { [id]: 2.5 } });
  expect(await page.evaluate((i) => (window as any).getRemoteScalePreview(i), id)).toBeNull();
});

test('undoing a resize leaves a moved mask in place; move-undo still works after', async ({ page }) => {
  await setup(page);
  const start = await simPos(page, IDX);

  // Move the mask.
  const c = await groupClientPos(page, IDX);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 70, c.y + 50, { steps: 10 });
  await page.mouse.up();
  const moved = await simPos(page, IDX);
  expect(Math.hypot(moved.x - start.x, moved.y - start.y)).toBeGreaterThan(1);

  // Resize the canvas (type a wider width); resize is debounced ~600ms.
  const w0 = parseInt(await page.locator('#cfg-width').inputValue());
  await page.locator('#cfg-width').fill(String(w0 + 300));
  await page.waitForTimeout(700);

  // Undo the resize -> bounds revert, but the moved mask stays put (scoped entry).
  await page.locator('#btn-sim-undo').click();
  const afterResizeUndo = await simPos(page, IDX);
  expect(Math.hypot(afterResizeUndo.x - moved.x, afterResizeUndo.y - moved.y)).toBeLessThan(1);

  // Undo the move -> mask returns to its original spot. No drift between the two.
  await page.locator('#btn-sim-undo').click();
  const afterMoveUndo = await simPos(page, IDX);
  expect(Math.hypot(afterMoveUndo.x - start.x, afterMoveUndo.y - start.y)).toBeLessThan(1);
});

test('undo/redo count badges track stack depth', async ({ page }) => {
  await setup(page);
  const undoBadge = page.locator('#sim-undo-badge');
  const redoBadge = page.locator('#sim-redo-badge');
  await expect(undoBadge).toHaveText('0');
  await expect(redoBadge).toHaveText('0');

  // Three discrete drags -> three undo entries (the in-drag flood pushes none).
  for (let i = 0; i < 3; i++) {
    const c = await groupClientPos(page, IDX);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 40, c.y + 30, { steps: 5 });
    await page.mouse.up();
  }
  await expect(undoBadge).toHaveText('3');
  await expect(redoBadge).toHaveText('0');

  // Undo moves one entry from undo -> redo.
  await page.locator('#btn-sim-undo').click();
  await expect(undoBadge).toHaveText('2');
  await expect(redoBadge).toHaveText('1');

  // Redo moves it back.
  await page.locator('#btn-sim-redo').click();
  await expect(undoBadge).toHaveText('3');
  await expect(redoBadge).toHaveText('0');
});

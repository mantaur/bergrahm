// Diagnostics for the canvas (sim) move-sync + undo jank the user reports:
// dragging "gets stuck", post-drop "phantom" motion, and an undo stack that
// doesn't match the number of drops. These tests MEASURE the wire behaviour so
// the root causes are pinned with numbers, not guesses. They drive the
// collab:* event contract directly (offline, no live peer needed).
//
// Findings being measured (see imageMerge.js / collaborate.js):
//   1. body-dragging floods at ~30/s with no coalescing (imageMerge.js:1807,
//      broadcast synchronously in collaborate.js:796).
//   2. remote-drag / remote-positions have NO guard for the image you are
//      actively dragging (imageMerge.js:3431, :3364) -> remote update overwrites
//      your in-flight drag = "stuck / snaps away". (encoded as test.fail: the
//      test asserts the DESIRED guarded behaviour and currently fails.)
//   3. a late remote echo arriving AFTER release mutates the canvas but creates
//      no undo entry -> the nudge is un-undoable ("phantom edits undo can't fix").

import type { Page } from '@playwright/test';
import {
  test, expect, addImage, paintPolygon, closePanel,
  simPos, groupClientPos, collabOut, emitRemote,
} from './fixtures';

const IDX = 0;

function undoState(page: Page): Promise<{ undo: number; redo: number; preLift: number }> {
  return page.evaluate(() => (window as any).getUndoState());
}

async function setup(page: Page) {
  await addImage(page);
  await paintPolygon(page);
  await closePanel(page);
  await expect.poll(() => simPos(page, IDX)).not.toBeNull();
}

// ── 1. Drag flood: many body-dragging events per single drag, no coalescing ─────
test('a ~4s circular pull (one lap = pi s) floods body-dragging and ends offset', async ({ page }) => {
  await setup(page);
  const c = await groupClientPos(page, IDX);
  const startPos = await simPos(page, IDX);

  const before = (await collabOut(page, 'collab:body-dragging')).length;

  // Realistic long pull: grab the mask and drag it around a circle. One full lap
  // = pi seconds (angular velocity omega = 2*pi / pi = 2 rad/s); pull for ~4s =
  // ~1.27 laps, so the mask ends offset from where it started (4 is not a whole
  // multiple of pi). Cursor traces the circle; the grabbed group follows.
  const R = 60;                      // circle radius in client px
  const DUR_S = 4, DT_MS = 40;       // ~4s pull, one hop every 40ms
  const STEPS = Math.round((DUR_S * 1000) / DT_MS);
  await page.mouse.move(c.x, c.y);   // grab at the group's centre
  await page.mouse.down();
  for (let i = 1; i <= STEPS; i++) {
    const theta = 2 * (i * DT_MS / 1000); // 2 rad/s
    await page.mouse.move(c.x + R * Math.cos(theta), c.y + R * Math.sin(theta), { steps: 1 });
    await page.waitForTimeout(DT_MS);
  }
  await page.mouse.up();

  const drags = (await collabOut(page, 'collab:body-dragging')).length - before;
  const endPos = await simPos(page, IDX);
  const offset = Math.hypot(endPos!.x - startPos!.x, endPos!.y - startPos!.y);
  console.log(`[diag] ~4s circular pull (~1.27 laps): ${drags} body-dragging broadcasts; ` +
    `ended ${offset.toFixed(1)} world-units from start`);

  // One drag should NOT be one message: the sim re-broadcasts the position every
  // 33ms. Over ~4s that is ~100+ events (proves rate-based flooding, not a single
  // coalesced update). Each is a synchronous JSON.stringify + send on the main
  // thread, all of which the receiver replays.
  expect(drags).toBeGreaterThanOrEqual(40);
  // 4s is not a whole multiple of pi, so the mask does not return to start.
  expect(offset).toBeGreaterThan(1);
});

// ── 2. No self-guard: a remote update overwrites the image you are dragging ─────
test('remote update for the actively-dragged image is ignored (self-guard)', async ({ page }) => {
  test.fail(true, 'BUG: remote-drag/positions have no guard for _activeDragIdx; the in-flight drag is overwritten');
  await setup(page);
  const before = await simPos(page, IDX);
  const c = await groupClientPos(page, IDX);

  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 40, c.y + 30, { steps: 5 }); // now actively dragging IDX
  const mid = await simPos(page, IDX);

  // A peer's (or a late buffered) update for the SAME image lands mid-drag.
  const far = { imgIdx: IDX, x: before!.x + 5000, y: before!.y + 5000, angle: 1 };
  await emitRemote(page, 'collab:remote-drag', far);
  const after = await simPos(page, IDX);
  await page.mouse.up();

  // DESIRED: the local drag wins; the remote update for the image under our
  // pointer is ignored. Currently it is NOT -> `after` jumps to `far`.
  expect(Math.hypot(after!.x - mid!.x, after!.y - mid!.y)).toBeLessThan(1);
});

// ── 3. Late echo after release mutates state with no undo entry ─────────────────
test('a remote echo after release moves the image but adds no undo entry', async ({ page }) => {
  await setup(page);
  const c = await groupClientPos(page, IDX);

  // One clean drag + release => exactly one undo entry.
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 80, c.y + 60, { steps: 10 });
  await page.mouse.up();

  const depthAfterDrop = (await undoState(page)).undo;
  const posAfterDrop = await simPos(page, IDX);
  expect(depthAfterDrop).toBe(1);

  // A buffered drag message arrives AFTER the drop (the channel was saturated
  // during the drag) and replays.
  await emitRemote(page, 'collab:remote-drag', {
    imgIdx: IDX, x: posAfterDrop!.x + 300, y: posAfterDrop!.y + 300, angle: 0,
  });

  const posAfterEcho = await simPos(page, IDX);
  const depthAfterEcho = (await undoState(page)).undo;

  // The canvas moved...
  expect(Math.hypot(posAfterEcho!.x - posAfterDrop!.x, posAfterEcho!.y - posAfterDrop!.y))
    .toBeGreaterThan(100);
  // ...but no undo entry was recorded for it: this mutation is un-undoable, and
  // pressing undo jumps past it to the pre-drag position, leaving a visible gap.
  expect(depthAfterEcho).toBe(depthAfterDrop);
});

// ── 4. Settings echo is dead: inbound settings neither push undo nor re-broadcast ─
// applyRemoteSettings (what a peer's settings / session-meta message runs) used to
// fake `input`/`change` events, re-entering the width/height/blend handlers; the
// debounced resize they armed dispatched collab:resize-done (-> a phantom undo
// entry) AND re-broadcast the same settings (-> a self-sustaining echo to 50). The
// fix applies settings directly and runs resizeSim() only on a real change, so a
// received (especially no-op) settings message does nothing to the undo stack and
// sends nothing back. Single page can't loop with itself, so we drive the inbound
// side and assert the loop's two symptoms are gone.

function currentDims(page: Page) {
  return page.evaluate(() => {
    const b = (window as any).getSimBounds();
    const m = (window as any).getCollabState();
    return { outW: m.outW, outH: m.outH, simX1: b.simX1, simY1: b.simY1, simX2: b.simX2, simY2: b.simY2 };
  });
}

test('an inbound settings (no change) pushes no undo entry and does not re-broadcast', async ({ page }) => {
  await setup(page);
  const dims = await currentDims(page);

  const undo0 = (await undoState(page)).undo;
  const out0 = (await collabOut(page, 'collab:settings-changed')).length;

  // Simulate ONE received settings/session-meta with the SAME dimensions.
  await page.evaluate((d) => (window as any).applyRemoteSettings(d), dims);
  // Wait well past the old 600ms resize + 200ms broadcast debounces to catch any
  // delayed echo (there should be none).
  await page.waitForTimeout(1000);

  // No phantom undo entry...
  expect((await undoState(page)).undo).toBe(undo0);
  // ...and nothing sent back (the bounce that fed the echo is gone).
  expect((await collabOut(page, 'collab:settings-changed')).length).toBe(out0);
});

test('repeated inbound settings do not grow the undo stack', async ({ page }) => {
  await setup(page);
  const dims = await currentDims(page);
  const undo0 = (await undoState(page)).undo;

  // The peer "bouncing" settings back, many times. No mouse / keyboard at all.
  const ROUNDS = 4;
  for (let i = 0; i < ROUNDS; i++) {
    await page.evaluate((d) => (window as any).applyRemoteSettings(d), dims);
    await page.waitForTimeout(700);
  }

  expect((await undoState(page)).undo).toBe(undo0);
});

test('a genuine remote resize updates bounds without an undo entry or echo', async ({ page }) => {
  await setup(page);
  const dims = await currentDims(page);
  const undo0 = (await undoState(page)).undo;
  const out0 = (await collabOut(page, 'collab:settings-changed')).length;

  // A bigger canvas with explicit new bounds, as a peer's real resize would send.
  const bigger = {
    outW: dims.outW + 200, outH: dims.outH + 160,
    simX1: dims.simX1, simY1: dims.simY1,
    simX2: dims.simX2 + 200, simY2: dims.simY2 + 160,
  };
  await page.evaluate((d) => (window as any).applyRemoteSettings(d), bigger);
  await page.waitForTimeout(1000);

  // The resize actually took effect (resizeSim ran, kept the explicit bounds)...
  const after = await page.evaluate(() => (window as any).getSimBounds());
  expect(after.simX2 - after.simX1).toBeCloseTo(bigger.simX2 - bigger.simX1, 0);
  expect(after.simY2 - after.simY1).toBeCloseTo(bigger.simY2 - bigger.simY1, 0);
  // ...but still no undo entry and nothing sent back.
  expect((await undoState(page)).undo).toBe(undo0);
  expect((await collabOut(page, 'collab:settings-changed')).length).toBe(out0);
});

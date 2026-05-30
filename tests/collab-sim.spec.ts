// Collaboration tested deterministically through the app's event contract:
//   - incoming peer messages are replayed as `collab:remote-*` CustomEvents,
//   - outgoing intent is captured from the `collab:*` events the app dispatches.
// No WebRTC/broker needed. The live-transport path is covered by collab-real.spec.ts.

import {
  test, expect, addImage, paintPolygon, closePanel,
  emitRemote, imageCount, polyCount, simPos, collabOut,
  TINY_IMG_DATAURL, FIXTURE_IMG,
} from './fixtures';

// ── Host side: what the app exposes for a joining peer ──────────────────────────

test('host: getCollabState reflects the loaded session', async ({ page }) => {
  await addImage(page);
  await paintPolygon(page);
  const cs = await page.evaluate(() => (window as any).getCollabState());
  expect(cs.imageCount).toBe(1);
  expect(cs.rankOrder).toEqual([0]);
  expect(cs.outW).toBe(1080);
  expect(cs.outH).toBe(1920);
});

// ── Guest side: receiving a pushed session ──────────────────────────────────────

test('guest: a pushed session-meta populates the skeleton', async ({ page }) => {
  await emitRemote(page, 'collab:remote-session-meta', {
    imageCount: 2,
    outW: 1080, outH: 1920, fillColor: '#181a1b',
    rankOrder: [0, 1], paintIdx: 0,
    images: [
      { name: 'a.png', w: 400, h: 400, polygons: [[{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 1 }]], scale: null },
      { name: 'b.png', w: 400, h: 400, polygons: [], scale: null },
    ],
  });
  await expect.poll(() => imageCount(page)).toBe(2);
  await expect(page.locator('#rank-list > li')).toHaveCount(2);
  await expect(page.locator('#paint-area')).not.toHaveClass(/im-hidden/);
  await expect(page.locator('#step-paint')).not.toHaveClass(/im-step-locked/);
  expect(await polyCount(page, 0)).toBe(1);
});

// ── Adding an image over collab ──────────────────────────────────────────────────

test('remote: an incoming image is appended', async ({ page }) => {
  await emitRemote(page, 'collab:remote-image', {
    name: 'remote.png', w: 2, h: 2, jpegBase64: TINY_IMG_DATAURL,
    encoding: null, polygons: [], simPos: null, simAngle: 0,
  });
  await expect.poll(() => imageCount(page)).toBe(1);
  await expect(page.locator('#rank-list > li')).toHaveCount(1);
  await expect(page.locator('#paint-area')).not.toHaveClass(/im-hidden/);
});

test('local: adding an image emits collab:images-added', async ({ page }) => {
  await addImage(page);
  expect((await collabOut(page, 'collab:images-added')).length).toBeGreaterThanOrEqual(1);
});

// ── Removing an image over collab ────────────────────────────────────────────────

test('local: removing an image emits collab:image-removed', async ({ page }) => {
  await addImage(page, [FIXTURE_IMG, FIXTURE_IMG]);
  await expect.poll(() => imageCount(page)).toBe(2);

  // First rank item maps to imgIdx 0 (rankOrder starts [0,1]).
  await page.locator('#rank-list > li').first().locator('.im-film-rm').click();
  await expect.poll(() => imageCount(page)).toBe(1);
  await expect(page.locator('#rank-list > li')).toHaveCount(1);

  const ev = await collabOut(page, 'collab:image-removed');
  expect(ev.length).toBeGreaterThanOrEqual(1);
  expect(ev.at(-1).detail.imgIdx).toBe(0);
});

test('remote: an incoming image removal is applied locally', async ({ page }) => {
  await addImage(page, [FIXTURE_IMG, FIXTURE_IMG]);
  await expect.poll(() => imageCount(page)).toBe(2);

  await emitRemote(page, 'collab:remote-image-removed', { imgIdx: 0 });
  await expect.poll(() => imageCount(page)).toBe(1);
  await expect(page.locator('#rank-list > li')).toHaveCount(1);

  // Applying a remote removal must NOT echo back out (no rebroadcast loop).
  expect(await collabOut(page, 'collab:image-removed')).toHaveLength(0);
});

test('remote: removing the last image clears the filmstrip', async ({ page }) => {
  await addImage(page);
  await expect.poll(() => imageCount(page)).toBe(1);

  await emitRemote(page, 'collab:remote-image-removed', { imgIdx: 0 });
  await expect.poll(() => imageCount(page)).toBe(0);
  await expect(page.locator('#rank-list > li')).toHaveCount(0);
  await expect(page.locator('#paint-area')).toHaveClass(/im-hidden/);
});

// ── Manipulating a mask over collab ──────────────────────────────────────────────

test('remote: a polygon update changes the local polygon count', async ({ page }) => {
  await addImage(page);
  await emitRemote(page, 'collab:remote-polygon', {
    imgIdx: 0, polygons: [[{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 50, y: 90 }]],
  });
  await expect.poll(() => polyCount(page, 0)).toBe(1);
});

test('remote: positions move the local sim group', async ({ page }) => {
  await addImage(page);
  await paintPolygon(page);
  await closePanel(page);
  const before = await simPos(page, 0);
  const target = { x: before.x + 500, y: before.y - 300, angle: 0 };

  await emitRemote(page, 'collab:remote-positions', { positions: { 0: target } });
  const after = await simPos(page, 0);
  expect(after.x).toBeCloseTo(target.x, 0);
  expect(after.y).toBeCloseTo(target.y, 0);
});

test('remote: grab locks the image and release frees it', async ({ page }) => {
  await addImage(page);
  await paintPolygon(page);
  await closePanel(page);

  // Remote peer grabs image 0 -> local drag must be ignored.
  await emitRemote(page, 'collab:remote-grab', { imgIdx: 0, color: '#fff' });
  const locked = await simPos(page, 0);
  const c = await page.evaluate(() => {
    const pos = (window as any).getSimPositions()[0];
    const st = (window as any).getSimState();
    const cv = document.getElementById('sim-canvas') as HTMLCanvasElement;
    const r = cv.getBoundingClientRect();
    const ts = st.dispScale * st.viewScale;
    return {
      x: (pos.x - st.viewOffset.x) * ts * r.width / cv.width + r.left,
      y: (pos.y - st.viewOffset.y) * ts * r.height / cv.height + r.top,
    };
  });
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 80, c.y + 60, { steps: 6 });
  await page.mouse.up();
  const stillLocked = await simPos(page, 0);
  expect(Math.hypot(stillLocked.x - locked.x, stillLocked.y - locked.y)).toBeLessThan(1);

  // Release -> dragging works again.
  await emitRemote(page, 'collab:remote-release', { imgIdx: 0 });
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 80, c.y + 60, { steps: 6 });
  await page.mouse.up();
  const moved = await simPos(page, 0);
  expect(Math.hypot(moved.x - locked.x, moved.y - locked.y)).toBeGreaterThan(1);
});

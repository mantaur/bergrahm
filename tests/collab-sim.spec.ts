// Collaboration tested deterministically through the app's event contract:
//   - incoming peer messages are replayed as `collab:remote-*` CustomEvents,
//   - outgoing intent is captured from the `collab:*` events the app dispatches.
// No WebRTC/broker needed. The live-transport path is covered by collab-real.spec.ts.

import {
  test, expect, addImage, paintPolygon, closePanel,
  emitRemote, imageCount, polyCount, simPos, collabOut, imgIdAt, groupClientPos,
  TINY_IMG_DATAURL, FIXTURE_IMG,
} from './fixtures';

// ── Host side: what the app exposes for a joining peer ──────────────────────────

test('host: getCollabState reflects the loaded session', async ({ page }) => {
  await addImage(page);
  await paintPolygon(page);
  const cs = await page.evaluate(() => (window as any).getCollabState());
  expect(cs.imageCount).toBe(1);
  expect(cs.rankOrder).toEqual([await imgIdAt(page, 0)]);
  expect(cs.outW).toBe(1080);
  expect(cs.outH).toBe(1920);
});

// The join snapshot must carry every synced setting (slides/seed/sharpness), else a
// peer that joins inherits the wrong slice count or merge parameters. These used to
// drift because getSessionMeta and the live broadcast were separate serializers.
test('host: getSessionMeta carries slides + seed + sharpness to joiners', async ({ page }) => {
  await addImage(page);
  await page.evaluate(() => {
    const set = (id: string, v: string) => {
      const el = document.getElementById(id) as HTMLInputElement;
      el.value = v;
      el.dispatchEvent(new Event('input'));
    };
    set('cfg-slides', '3');
    set('cfg-seed', '7');
    set('cfg-dither-exp', '9');
  });
  const meta = await page.evaluate(() => (window as any).getSessionMeta());
  expect(meta.slides).toBe(3);
  expect(meta.seed).toBe(7);
  expect(meta.ditherExp).toBe(9);
});

test('guest: applyRemoteSettings applies seed + sharpness', async ({ page }) => {
  await page.evaluate(() => (window as any).applyRemoteSettings({ seed: 13, ditherExp: 5 }));
  const v = await page.evaluate(() => ({
    seed: (document.getElementById('cfg-seed') as HTMLInputElement).value,
    dither: (document.getElementById('cfg-dither-exp') as HTMLInputElement).value,
  }));
  expect(v.seed).toBe('13');
  expect(v.dither).toBe('5');
});

// ── Guest side: receiving a pushed session ──────────────────────────────────────

test('guest: a pushed session-meta populates the skeleton', async ({ page }) => {
  await emitRemote(page, 'collab:remote-session-meta', {
    imageCount: 2,
    outW: 1080, outH: 1920, fillColor: '#181a1b',
    rankOrder: ['ra', 'rb'], paintIdx: 0,
    images: [
      { id: 'ra', name: 'a.png', w: 400, h: 400, polygons: [[{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 1 }]], scale: null },
      { id: 'rb', name: 'b.png', w: 400, h: 400, polygons: [], scale: null },
    ],
  });
  await expect.poll(() => imageCount(page)).toBe(2);
  await expect(page.locator('#rank-list > li')).toHaveCount(2);
  await expect(page.locator('#paint-area')).not.toHaveClass(/im-hidden/);
  await expect(page.locator('#step-paint')).not.toHaveClass(/im-step-locked/);
  expect(await polyCount(page, 0)).toBe(1);
});

test('guest: merge button stays hidden until pixels arrive', async ({ page }) => {
  // Masks/groups exist from the pushed meta, but no image bytes have streamed in.
  await emitRemote(page, 'collab:remote-session-meta', {
    imageCount: 1,
    outW: 400, outH: 400, fillColor: '#181a1b',
    rankOrder: ['ra'], paintIdx: 0,
    images: [
      { id: 'ra', name: 'a.png', w: 400, h: 400,
        polygons: [[{ x: 40, y: 40 }, { x: 360, y: 40 }, { x: 200, y: 360 }]],
        scale: null, simPos: { x: 200, y: 200 }, simAngle: 0 },
    ],
  });
  await expect.poll(() => imageCount(page)).toBe(1);

  // No merge offered yet (can't merge an image with no pixels), and the status
  // tells you it's still waiting -- no dead-end "Waiting..." behind a live button.
  await expect(page.locator('#btn-merge')).toHaveClass(/im-hidden/);
  await expect(page.locator('#sim-status')).toHaveText(/Waiting/);

  // Once the image's bytes stream in, the merge button appears.
  await emitRemote(page, 'collab:remote-image-full', {
    imgIdx: 'ra', name: 'a.png', w: 2, h: 2, jpegBase64: TINY_IMG_DATAURL, polygons: undefined,
  });
  await expect(page.locator('#btn-merge')).not.toHaveClass(/im-hidden/);
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

  const removedId = await imgIdAt(page, 0); // first rank item's image
  await page.locator('#rank-list > li').first().locator('.im-film-rm').click();
  await expect.poll(() => imageCount(page)).toBe(1);
  await expect(page.locator('#rank-list > li')).toHaveCount(1);

  const ev = await collabOut(page, 'collab:image-removed');
  expect(ev.length).toBeGreaterThanOrEqual(1);
  expect(ev.at(-1).detail.imgIdx).toBe(removedId);
});

test('remote: an incoming image removal is applied locally', async ({ page }) => {
  await addImage(page, [FIXTURE_IMG, FIXTURE_IMG]);
  await expect.poll(() => imageCount(page)).toBe(2);

  await emitRemote(page, 'collab:remote-image-removed', { imgIdx: await imgIdAt(page, 0) });
  await expect.poll(() => imageCount(page)).toBe(1);
  await expect(page.locator('#rank-list > li')).toHaveCount(1);

  // Applying a remote removal must NOT echo back out (no rebroadcast loop).
  expect(await collabOut(page, 'collab:image-removed')).toHaveLength(0);
});

test('remote: removing the last image clears the filmstrip', async ({ page }) => {
  await addImage(page);
  await expect.poll(() => imageCount(page)).toBe(1);

  await emitRemote(page, 'collab:remote-image-removed', { imgIdx: await imgIdAt(page, 0) });
  await expect.poll(() => imageCount(page)).toBe(0);
  await expect(page.locator('#rank-list > li')).toHaveCount(0);
  await expect(page.locator('#paint-area')).toHaveClass(/im-hidden/);
});

// ── Manipulating a mask over collab ──────────────────────────────────────────────

test('remote: a polygon update changes the local polygon count', async ({ page }) => {
  await addImage(page);
  await emitRemote(page, 'collab:remote-polygon', {
    imgIdx: await imgIdAt(page, 0), polygons: [[{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 50, y: 90 }]],
  });
  await expect.poll(() => polyCount(page, 0)).toBe(1);
});

test('remote: positions move the local sim group', async ({ page }) => {
  await addImage(page);
  await paintPolygon(page);
  await closePanel(page);
  const id = await imgIdAt(page, 0);
  const before = await simPos(page, 0);
  const target = { x: before.x + 500, y: before.y - 300, angle: 0 };

  await emitRemote(page, 'collab:remote-positions', { positions: { [id]: target } });
  const after = await simPos(page, 0);
  expect(after.x).toBeCloseTo(target.x, 0);
  expect(after.y).toBeCloseTo(target.y, 0);
});

test('remote: grab locks the image and release frees it', async ({ page }) => {
  await addImage(page);
  await paintPolygon(page);
  await closePanel(page);

  // Remote peer grabs the image -> local drag must be ignored.
  const id = await imgIdAt(page, 0);
  await emitRemote(page, 'collab:remote-grab', { imgIdx: id, color: '#fff' });
  const locked = await simPos(page, 0);
  const c = await groupClientPos(page, 0);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 80, c.y + 60, { steps: 6 });
  await page.mouse.up();
  const stillLocked = await simPos(page, 0);
  expect(Math.hypot(stillLocked.x - locked.x, stillLocked.y - locked.y)).toBeLessThan(1);

  // Release -> dragging works again.
  await emitRemote(page, 'collab:remote-release', { imgIdx: id });
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 80, c.y + 60, { steps: 6 });
  await page.mouse.up();
  const moved = await simPos(page, 0);
  expect(Math.hypot(moved.x - locked.x, moved.y - locked.y)).toBeGreaterThan(1);
});

// Regression: global "scale all" must rescale masks in place, not reset the output
// frame to the origin (which teleported masks out of an imported off-origin shape).
test('scale-all rescales in place without moving the output frame or masks', async ({ page }) => {
  await emitRemote(page, 'collab:remote-session-meta', {
    imageCount: 1,
    outW: 400, outH: 400, fillColor: '#181a1b',
    rankOrder: ['ra'], paintIdx: 0,
    simX1: 1000, simY1: 1000, simX2: 1400, simY2: 1400, // off-origin output rect
    images: [
      {
        id: 'ra', name: 'a.png', w: 400, h: 400,
        polygons: [[{ x: 40, y: 40 }, { x: 360, y: 40 }, { x: 200, y: 360 }]],
        scale: null, simPos: { x: 1200, y: 1200 }, simAngle: 0,
      },
    ],
  });
  await expect.poll(() => imageCount(page)).toBe(1);

  const boundsBefore = await page.evaluate(() => (window as any).getSimBounds());
  const posBefore = await simPos(page, 0);

  await page.evaluate(() => {
    const s = document.getElementById('cfg-scale-all') as HTMLInputElement;
    s.value = '0.5';
    (document.getElementById('btn-scale-all') as HTMLButtonElement).click();
  });

  const boundsAfter = await page.evaluate(() => (window as any).getSimBounds());
  const posAfter = await simPos(page, 0);
  const scaleAfter = await page.evaluate(() => (window as any).getSessionMeta().images[0].scale);

  expect(scaleAfter).toBeCloseTo(0.5, 5); // the rescale actually applied
  expect(boundsAfter.simX1).toBe(boundsBefore.simX1); // frame did NOT move to origin
  expect(boundsAfter.simY1).toBe(boundsBefore.simY1);
  expect(Math.abs(posAfter!.x - posBefore!.x)).toBeLessThan(0.5); // mask stayed put
  expect(Math.abs(posAfter!.y - posBefore!.y)).toBeLessThan(0.5);
});

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

// Live-upload progress (sending added images to peers) shows on the sim-status pill so
// it's visible while the collab modal is closed. "Synced" messages self-clear.
test('collab sync-status drives the sim-status pill', async ({ page }) => {
  await emitRemote(page, 'collab:sync-status', { text: 'Syncing 1/3 to peers' });
  await expect(page.locator('#sim-status')).toHaveText('Syncing 1/3 to peers');

  await emitRemote(page, 'collab:sync-status', { text: 'Synced 3 images to peers' });
  await expect(page.locator('#sim-status')).toHaveText('Synced 3 images to peers');
  await expect(page.locator('#sim-status')).toHaveText('', { timeout: 5000 }); // self-clears
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

// Regression: a reconnecting guest holds more/newer images than the host's snapshot.
// A join-handshake session-meta (replace falsy) must MERGE, never wipe -- otherwise the
// host's stale snapshot clobbers the guest's images (the "pushes one image back, removes
// the rest" data-loss bug). Only an explicit re-stream (replace:true) replaces wholesale.
test('guest: a non-replace session-meta merges instead of wiping local images', async ({ page }) => {
  await addImage(page, [FIXTURE_IMG, FIXTURE_IMG, FIXTURE_IMG]);
  await expect.poll(() => imageCount(page)).toBe(3);
  const idsBefore = await page.evaluate(() => (window as any).getSessionMeta().rankOrder);

  // Host (with a stale 1-image snapshot) reconnects us: must not wipe our 3.
  await emitRemote(page, 'collab:remote-session-meta', {
    imageCount: 1, replace: false,
    outW: 400, outH: 400, fillColor: '#181a1b',
    rankOrder: ['stale-a'], paintIdx: 0,
    images: [{ id: 'stale-a', name: 'stale.png', w: 400, h: 400, polygons: [], scale: null }],
  });

  // All three local images survive; the only-new id is appended.
  await expect.poll(() => imageCount(page)).toBe(4);
  const idsAfter = await page.evaluate(() => (window as any).getSessionMeta().rankOrder);
  for (const id of idsBefore) expect(idsAfter).toContain(id);
  expect(idsAfter).toContain('stale-a');
});

test('guest: a replace session-meta still replaces wholesale', async ({ page }) => {
  await addImage(page, [FIXTURE_IMG, FIXTURE_IMG]);
  await expect.poll(() => imageCount(page)).toBe(2);

  await emitRemote(page, 'collab:remote-session-meta', {
    imageCount: 1, replace: true,
    outW: 400, outH: 400, fillColor: '#181a1b',
    rankOrder: ['fresh-a'], paintIdx: 0,
    images: [{ id: 'fresh-a', name: 'fresh.png', w: 400, h: 400, polygons: [], scale: null }],
  });

  await expect.poll(() => imageCount(page)).toBe(1);
  const ids = await page.evaluate(() => (window as any).getSessionMeta().rankOrder);
  expect(ids).toEqual(['fresh-a']);
});

// On reconnect the host re-sends its (possibly stale) snapshot; the guest must push back
// any fully-loaded local images the host is missing -- this is what delivers images that
// stalled mid-upload before the drop. The host dedups by id.
test('guest: a merge re-sends images the host is missing', async ({ page }) => {
  await addImage(page); // 1 local image with pixels
  const localId = await imgIdAt(page, 0);
  const before = (await collabOut(page, 'collab:images-added')).length;

  // Host reconnects us with a snapshot that does NOT contain our image.
  await emitRemote(page, 'collab:remote-session-meta', {
    imageCount: 0, replace: false,
    outW: 400, outH: 400, fillColor: '#181a1b',
    rankOrder: [], paintIdx: 0, images: [],
  });

  await expect.poll(async () => (await collabOut(page, 'collab:images-added')).length).toBeGreaterThan(before);
  const ev = await collabOut(page, 'collab:images-added');
  expect(ev.at(-1).detail.ids).toContain(localId);
});

// Live add (binary path): the image-binary header lands first and shows a pending
// skeleton row immediately; the bytes arrive next and fill it. Avoids a blank wait
// while a large image streams in.
test('guest: a live-add skeleton shows pending, then the binary fill completes it', async ({ page }) => {
  await emitRemote(page, 'collab:remote-image-skeleton', {
    id: 'live-a', name: 'live.png', w: 400, h: 400,
    polygons: [[{ x: 40, y: 40 }, { x: 360, y: 40 }, { x: 200, y: 360 }]],
    simPos: { x: 200, y: 200 }, simAngle: 0,
  });
  await expect.poll(() => imageCount(page)).toBe(1);
  await expect(page.locator('#rank-list .im-rank-thumb')).toHaveClass(/im-rank-thumb-pending/);
  await expect(page.locator('#btn-merge')).toHaveClass(/im-hidden/); // no pixels yet -> no merge

  await emitRemote(page, 'collab:remote-image-binary', {
    imgIdx: 'live-a', name: 'live.png', w: 2, h: 2, jpegBase64: TINY_IMG_DATAURL,
  });
  await expect(page.locator('#rank-list .im-rank-thumb')).not.toHaveClass(/im-rank-thumb-pending/);
  await expect(page.locator('#btn-merge')).not.toHaveClass(/im-hidden/);
  expect(await imageCount(page)).toBe(1); // filled in place, not appended twice
});

// A duplicate skeleton (re-delivered header / echo) must not create a second row.
test('guest: a live-add skeleton is idempotent by id', async ({ page }) => {
  const skel = {
    id: 'dup-a', name: 'dup.png', w: 400, h: 400,
    polygons: [], simPos: { x: 200, y: 200 }, simAngle: 0,
  };
  await emitRemote(page, 'collab:remote-image-skeleton', skel);
  await emitRemote(page, 'collab:remote-image-skeleton', skel);
  await expect.poll(() => imageCount(page)).toBe(1);
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

// Collaboration tested deterministically through the app's event contract:
//   - incoming peer messages are replayed as `collab:remote-*` CustomEvents,
//   - outgoing intent is captured from the `collab:*` events the app dispatches.
// No WebRTC/broker needed. The live-transport path is covered by collab-real.spec.ts.

import {
  test, expect, addImage, paintPolygon, closePanel, openPaintStep,
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

// ── Shared metadata via Yjs (settings domain) ────────────────────────────────────
// Settings sync through a Yjs CRDT (window.ydoc) instead of a raw broadcast: a local
// edit lands in the shared doc, and a remote doc update applies to the local UI.
test('a local settings edit writes into the shared Y.Doc', async ({ page }) => {
  await page.evaluate(() => {
    const el = document.getElementById('cfg-seed') as HTMLInputElement;
    el.value = '77';
    el.dispatchEvent(new Event('input'));
  });
  // _broadcastSettings is debounced ~200ms; poll the doc.
  await expect.poll(() => page.evaluate(() => (window as any).ydoc.getMap('settings').get('seed'))).toBe(77);
});

test('a remote Y.Doc settings update applies to the local UI', async ({ page }) => {
  await page.evaluate(() => {
    const yd = (window as any).ydoc;
    yd.transact(() => yd.getMap('settings').set('seed', 99), 'remote'); // simulate a peer update
  });
  await expect
    .poll(() => page.evaluate(() => (document.getElementById('cfg-seed') as HTMLInputElement).value))
    .toBe('99');
});

test('a rank-order change writes into the shared Y.Doc', async ({ page }) => {
  await addImage(page, [FIXTURE_IMG, FIXTURE_IMG]);
  await expect.poll(() => imageCount(page)).toBe(2);
  const ids = await page.evaluate(() => (window as any).getSessionMeta().rankOrder);
  const reversed = [...ids].reverse();
  await page.evaluate((order) => window.dispatchEvent(new CustomEvent('collab:rank-order-changed', { detail: { order } })), reversed);
  await expect.poll(() => page.evaluate(() => (window as any).ydoc.getArray('rankOrder').toArray())).toEqual(reversed);
});

test('a remote Y.Doc rank-order update applies locally', async ({ page }) => {
  await addImage(page, [FIXTURE_IMG, FIXTURE_IMG]);
  await expect.poll(() => imageCount(page)).toBe(2);
  const ids = await page.evaluate(() => (window as any).getSessionMeta().rankOrder);
  const reversed = [...ids].reverse();
  await page.evaluate((order) => {
    const yd = (window as any).ydoc;
    yd.transact(() => {
      const yr = yd.getArray('rankOrder');
      if (yr.length) yr.delete(0, yr.length);
      yr.insert(0, order);
    }, 'remote');
  }, reversed);
  await expect.poll(() => page.evaluate(() => (window as any).getSessionMeta().rankOrder)).toEqual(reversed);
});

test('a polygon edit round-trips through the Y.Doc', async ({ page }) => {
  await addImage(page);
  const id = await imgIdAt(page, 0);
  await page.evaluate(
    ({ id, poly }) => window.dispatchEvent(new CustomEvent('collab:polygon-changed', { detail: { imgIdx: id, polygons: poly } })),
    { id, poly: [[{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 50, y: 90 }]] },
  );
  await expect.poll(() => page.evaluate((id) => (window as any).ydoc.getMap('polygons').get(id)?.length, id)).toBe(1);

  // A remote doc update applies to the local mask.
  await page.evaluate((id) => {
    const yd = (window as any).ydoc;
    const two = [[{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 1 }], [{ x: 4, y: 4 }, { x: 5, y: 5 }, { x: 6, y: 4 }]];
    yd.transact(() => yd.getMap('polygons').set(id, two), 'remote');
  }, id);
  await expect.poll(() => polyCount(page, 0)).toBe(2);
});

test('a scale edit writes into the Y.Doc', async ({ page }) => {
  await addImage(page);
  const id = await imgIdAt(page, 0);
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('collab:scales-changed', { detail: { scales: { [id]: 0.5 } } })), id);
  await expect.poll(() => page.evaluate((id) => (window as any).ydoc.getMap('scales').get(id), id)).toBe(0.5);
});

// ── Per-image membership via Yjs ──────────────────────────────────────────────────
// The image LIST lives in ydoc.getMap("images"); bytes are pulled by assetHash. A local
// add announces membership in the doc (with its content hash registered); a remote
// membership snapshot builds/removes images locally, applying masks from the doc.

test('a local add registers per-image membership in the Y.Doc', async ({ page }) => {
  await addImage(page);
  const id = await imgIdAt(page, 0);
  const m = await expect
    .poll(() => page.evaluate((id) => (window as any).ydoc.getMap('images').get(id) || null, id))
    .not.toBeNull()
    .then(() => page.evaluate((id) => (window as any).ydoc.getMap('images').get(id), id));
  expect(m.id).toBe(id);
  expect(m.assetHash).toBeTruthy(); // bytes are content-addressed for pull
});

test('a remote membership snapshot builds an image with its mask from the doc', async ({ page }) => {
  // Mask present in the doc; image announced via membership. The mask must apply even
  // though it is delivered alongside (not after) the image -- the old drop-on-missing bug.
  await page.evaluate(() => {
    (window as any).applyRemoteMembership({
      images: { m1: { id: 'm1', name: 'm.png', w: 400, h: 400, assetHash: 'h1', simHidden: false, scaleFixed: false, simPos: { x: 200, y: 200 }, simAngle: 0 } },
      order: ['m1'],
      polygons: { m1: [[{ x: 40, y: 40 }, { x: 360, y: 40 }, { x: 200, y: 360 }]] },
      scales: {},
    });
  });
  await expect.poll(() => imageCount(page)).toBe(1);
  expect(await polyCount(page, 0)).toBe(1); // mask applied at build, not dropped
  await expect(page.locator('#rank-list .im-rank-thumb')).toHaveClass(/im-rank-thumb-pending/); // no bytes yet
});

test('a remote membership snapshot removes an image the doc no longer has', async ({ page }) => {
  await page.evaluate(() => {
    const mk = (id: string) => ({ id, name: id + '.png', w: 400, h: 400, assetHash: id, simHidden: false, scaleFixed: false, simPos: null, simAngle: 0 });
    (window as any).applyRemoteMembership({ images: { a: mk('a'), b: mk('b') }, order: ['a', 'b'], polygons: {}, scales: {} });
  });
  await expect.poll(() => imageCount(page)).toBe(2);
  // Doc now drops "a".
  await page.evaluate(() => {
    const mk = (id: string) => ({ id, name: id + '.png', w: 400, h: 400, assetHash: id, simHidden: false, scaleFixed: false, simPos: null, simAngle: 0 });
    (window as any).applyRemoteMembership({ images: { b: mk('b') }, order: ['b'], polygons: {}, scales: {} });
  });
  await expect.poll(() => imageCount(page)).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).getSessionMeta().rankOrder)).toEqual(['b']);
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

// Reconnect convergence: a locally-added image lives in the membership doc, so on
// reconnect the doc is exchanged and the peer pulls bytes by hash -- no "resend missing
// images" re-stream (that caused the loop). Here we assert the image is in the doc and a
// stale session-meta merge does NOT trigger a re-send.
test('guest: a locally added image is in the membership doc and is not re-streamed on a stale merge', async ({ page }) => {
  await addImage(page); // 1 local image with pixels
  const localId = await imgIdAt(page, 0);
  await expect.poll(() => page.evaluate((id) => !!(window as any).ydoc.getMap('images').get(id), localId)).toBe(true);

  const before = (await collabOut(page, 'collab:images-added')).length;
  // A stale session-meta merge (host without our image) must NOT re-fire images-added.
  await emitRemote(page, 'collab:remote-session-meta', {
    imageCount: 0, replace: false,
    outW: 400, outH: 400, fillColor: '#181a1b',
    rankOrder: [], paintIdx: 0, images: [],
  });
  await page.waitForTimeout(300);
  expect((await collabOut(page, 'collab:images-added')).length).toBe(before); // no re-stream
  expect(await imageCount(page)).toBe(1); // our image is untouched
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

// ── Content-addressed asset layer ────────────────────────────────────────────────

// Bytes are pulled by content hash and self-heal: a skeleton that knows its assetHash
// but lacks pixels stays pending until the asset arrives, then fills -- independent of
// whether the original push succeeded.
test('guest: a content-addressed asset fills the image waiting on it', async ({ page }) => {
  await emitRemote(page, 'collab:remote-image-skeleton', {
    id: 'ca-1', assetHash: 'deadbeef', name: 'ca.png', w: 400, h: 400,
    polygons: [[{ x: 40, y: 40 }, { x: 360, y: 40 }, { x: 200, y: 360 }]],
    simPos: { x: 200, y: 200 }, simAngle: 0,
  });
  await expect.poll(() => imageCount(page)).toBe(1);
  await expect(page.locator('#rank-list .im-rank-thumb')).toHaveClass(/im-rank-thumb-pending/);
  await expect(page.locator('#btn-merge')).toHaveClass(/im-hidden/);

  await emitRemote(page, 'collab:remote-asset', { hash: 'deadbeef', jpegBase64: TINY_IMG_DATAURL });
  await expect(page.locator('#rank-list .im-rank-thumb')).not.toHaveClass(/im-rank-thumb-pending/);
  await expect(page.locator('#btn-merge')).not.toHaveClass(/im-hidden/);
});

// The reconcile loop requests bytes for a skeleton it knows the hash of but lacks.
test('guest: reconcile requests a missing asset by hash', async ({ page }) => {
  await emitRemote(page, 'collab:remote-image-skeleton', {
    id: 'ca-2', assetHash: 'cafe1234', name: 'ca.png', w: 400, h: 400,
    polygons: [], simPos: { x: 200, y: 200 }, simAngle: 0,
  });
  await expect.poll(() => imageCount(page)).toBe(1);
  // Force a reconcile rather than waiting on the 4s timer.
  await page.evaluate(() => (window as any).reconcileAssets());
  await expect.poll(async () => (await collabOut(page, 'collab:asset-needed')).some((e) => e.detail.hash === 'cafe1234')).toBe(true);
});

// Removing the last polygon must clear the sim group AND trigger a repaint. Previously
// simRefreshGroup deleted the group but returned without marking the view dirty, so the
// mask lingered on the canvas until a pan. _clearMergedImage (dirty flag + merge-button
// refresh) is the observable consequence: with a lone masked image, merge un-readies.
test('removing the last polygon refreshes the canvas (group gone, merge un-ready)', async ({ page }) => {
  await addImage(page);
  await paintPolygon(page);
  await expect(page.locator('#btn-merge')).toBeVisible();

  const id = await imgIdAt(page, 0);
  await emitRemote(page, 'collab:remote-polygon', { imgIdx: id, polygons: [] });
  expect(await polyCount(page, 0)).toBe(0);
  await expect(page.locator('#btn-merge')).toBeHidden(); // repaint/cleanup ran
});

// Merge must not be offered while any image is still transferring -- a merge would run
// against a session that isn't fully synced in.
test('merge button hides until every image is transferred', async ({ page }) => {
  await addImage(page);
  await paintPolygon(page);
  await expect(page.locator('#btn-merge')).toBeVisible(); // one image, masked, loaded

  // A second image arrives but its bytes are not here yet -> merge hides.
  await emitRemote(page, 'collab:remote-image-skeleton', {
    id: 'gm2', assetHash: 'gm2hash', name: 'g2.png', w: 400, h: 400,
    polygons: [], simPos: { x: 200, y: 200 }, simAngle: 0,
  });
  await expect.poll(() => imageCount(page)).toBe(2);
  await expect(page.locator('#btn-merge')).toBeHidden();

  // Its bytes arrive -> all transferred -> merge available again.
  await emitRemote(page, 'collab:remote-asset', { hash: 'gm2hash', jpegBase64: TINY_IMG_DATAURL });
  await expect(page.locator('#btn-merge')).toBeVisible();
});

// Navigating to an image whose bytes have not arrived must still advance the painter
// (which shows a "Loading X%" placeholder), not silently stay on the previous image.
test('navigating to an unloaded image still advances the painter', async ({ page }) => {
  await addImage(page); // index 0, loaded locally
  await emitRemote(page, 'collab:remote-image-skeleton', {
    id: 'unl', assetHash: 'unlhash', name: 'u.png', w: 400, h: 400,
    polygons: [], simPos: { x: 200, y: 200 }, simAngle: 0,
  });
  await expect.poll(() => imageCount(page)).toBe(2);
  await openPaintStep(page);
  await expect(page.locator('#paint-index-label')).toHaveText('1 / 2');
  await page.locator('#btn-next-img').click();
  await expect(page.locator('#paint-index-label')).toHaveText('2 / 2'); // advanced despite no bytes
});

// The tiny thumbnail is content-addressed and pulled first, so a preview appears before
// the heavy full image bytes land.
test('guest: a thumbnail fills the preview before the full image bytes', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).applyRemoteMembership({
      images: { th1: { id: 'th1', name: 't.png', w: 400, h: 400, assetHash: 'fullh', thumbHash: 'thumbh', simHidden: false, scaleFixed: false, simPos: null, simAngle: 0 } },
      order: ['th1'], polygons: {}, scales: {},
    });
  });
  await expect.poll(() => imageCount(page)).toBe(1);
  await expect(page.locator('#rank-list .im-rank-thumb')).toHaveClass(/im-rank-thumb-pending/);
  // Only the thumbnail arrives -> the preview resolves even though full bytes are missing.
  await emitRemote(page, 'collab:remote-asset', { hash: 'thumbh', jpegBase64: TINY_IMG_DATAURL });
  await expect(page.locator('#rank-list .im-rank-thumb')).not.toHaveClass(/im-rank-thumb-pending/);
});

// Bounded concurrency: the reconcile keeps only a few pulls in flight at once instead of
// requesting every missing hash, so queued/stalled serves on a slow link can't be
// re-requested into a duplicate pile-up (the post-sync channel-saturation bug).
test('guest: pulls assets with bounded concurrency (no request stampede)', async ({ page }) => {
  await page.evaluate(() => {
    const mk = (id: string, h: string) => ({ id, name: id + '.png', w: 400, h: 400, assetHash: h, thumbHash: null, simHidden: false, scaleFixed: false, simPos: null, simAngle: 0 });
    const images: any = {};
    const order: string[] = [];
    for (let i = 0; i < 6; i++) { images['w' + i] = mk('w' + i, 'h' + i); order.push('w' + i); }
    (window as any).applyRemoteMembership({ images, order, polygons: {}, scales: {} });
  });
  await expect.poll(() => imageCount(page)).toBe(6);

  // The first reconcile (run by applyRemoteMembership) requests at most the window size.
  await page.waitForTimeout(150);
  const firstBatch = (await collabOut(page, 'collab:asset-needed')).map((e: any) => e.detail.hash);
  expect(firstBatch.length).toBeGreaterThan(0);
  expect(firstBatch.length).toBeLessThanOrEqual(4); // ASSET_CONCURRENCY

  // Delivering the in-flight ones frees window slots -> the remaining hashes get requested.
  for (const h of firstBatch) await emitRemote(page, 'collab:remote-asset', { hash: h, jpegBase64: TINY_IMG_DATAURL });
  await expect.poll(async () => (await collabOut(page, 'collab:asset-needed')).length).toBeGreaterThan(firstBatch.length);
});

// De-dup: repeated reconciles within the backoff window don't re-ask for the same hash,
// so a transfer in flight isn't drowned in duplicate re-serves.
test('guest: a missing asset is not re-requested within the backoff window', async ({ page }) => {
  await emitRemote(page, 'collab:remote-image-skeleton', {
    id: 'ca-3', assetHash: 'beef99', name: 'ca.png', w: 400, h: 400,
    polygons: [], simPos: { x: 200, y: 200 }, simAngle: 0,
  });
  await expect.poll(() => imageCount(page)).toBe(1);
  for (let i = 0; i < 3; i++) await page.evaluate(() => (window as any).reconcileAssets());
  const reqs = (await collabOut(page, 'collab:asset-needed')).filter((e: any) => e.detail.hash === 'beef99');
  expect(reqs.length).toBe(1); // requested once, then de-duped
});

// Pull order follows the carousel (rank) order, like the YOLO encode queue: the image
// nearest the top of the list requests its bytes first, regardless of insertion order.
test('guest: reconcile requests assets in carousel (rank) order', async ({ page }) => {
  await page.evaluate(() => {
    const mk = (id: string, hash: string) => ({ id, name: id + '.png', w: 400, h: 400, assetHash: hash, simHidden: false, scaleFixed: false, simPos: null, simAngle: 0 });
    // Insertion order a,b,c but carousel order c,a,b.
    (window as any).applyRemoteMembership({
      images: { a: mk('a', 'ha'), b: mk('b', 'hb'), c: mk('c', 'hc') },
      order: ['c', 'a', 'b'],
      polygons: {}, scales: {},
    });
  });
  await expect.poll(() => imageCount(page)).toBe(3);

  // applyRemoteMembership runs a reconcile that requests the three missing hashes; the
  // request de-dup means each hash is asked for once, so these first three events are the
  // pull order.
  await expect.poll(async () => (await collabOut(page, 'collab:asset-needed')).length).toBeGreaterThanOrEqual(3);
  const hashes = (await collabOut(page, 'collab:asset-needed')).slice(0, 3).map((e: any) => e.detail.hash);
  expect(hashes).toEqual(['hc', 'ha', 'hb']); // rank order, not insertion order
});

// A locally added image is content-addressed and registered so this peer can serve it.
test('local add registers a content-addressed asset', async ({ page }) => {
  await addImage(page);
  const r = await page.evaluate(async () => {
    const id = (window as any).getSessionMeta().images[0].id;
    const buf = await (window as any).getImageBuffer(id);
    return { hash: buf.assetHash, has: (window as any).hasAsset(buf.assetHash) };
  });
  expect(r.hash).toBeTruthy();
  expect(r.has).toBe(true);
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

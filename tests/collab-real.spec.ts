// Real two-context WebRTC smoke test. Uses the live PeerJS cloud broker, so it is
// skipped unless REAL_COLLAB=1 (needs internet; can flake on broker/STUN).
//   REAL_COLLAB=1 bunx playwright test tests/collab-real.spec.ts --project=chromium

import { test, expect } from '@playwright/test';
import { routeVendor, PAGE, FIXTURE_IMG, SESSION_ZIP } from './fixtures';

test.describe('real collab (live broker)', () => {
  test.skip(!process.env.REAL_COLLAB, 'set REAL_COLLAB=1 to run the live two-context smoke');

  test('host and guest connect across two contexts', async ({ browser }) => {
    const room = 'pw-' + Math.random().toString(36).slice(2, 9);

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await routeVendor(ctxA);
    await routeVendor(ctxB);
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    try {
      // A hosts the room.
      await a.goto(PAGE);
      await a.locator('#btn-collab').click();
      await a.locator('#collab-room-inp').fill(room);
      await a.locator('#btn-collab-join').click();
      await expect(a.locator('#collab-status')).toHaveText(/Hosting/, { timeout: 25000 });
      await expect(a.locator('#collab-role')).toHaveText('Host');

      // B joins the same room via the URL param (auto-join).
      await b.goto(PAGE + '?room=' + room);
      await expect(b.locator('#collab-status')).toHaveText(/Connected as guest/, { timeout: 25000 });
      await expect(b.locator('#collab-role')).toHaveText('Guest');

      // Both sides see one peer.
      await expect(a.locator('#collab-status')).toHaveText(/guest/, { timeout: 25000 });
      await expect(a.locator('#collab-peer-badge')).toBeVisible();
      await expect(b.locator('#collab-peer-badge')).toBeVisible();

      // Session import is host-only: the guest's import is disabled, the host's is not.
      await expect(b.locator('#inp-import-session')).toBeDisabled();
      await expect(a.locator('#inp-import-session')).toBeEnabled();

      // Settings sync through the Yjs CRDT over the data channel: a host edit converges
      // to the guest's UI.
      await a.evaluate(() => {
        const el = document.getElementById('cfg-seed') as HTMLInputElement;
        el.value = '88';
        el.dispatchEvent(new Event('input'));
      });
      await expect
        .poll(() => b.evaluate(() => (document.getElementById('cfg-seed') as HTMLInputElement).value), { timeout: 25000 })
        .toBe('88');

      // Presenter mode: host enables it, then closes the modal and pans;
      // the guest's viewport should follow.
      const gBefore = await b.evaluate(() => (window as any).getSimState().viewOffset);
      await a.locator('#btn-collab-present').click();
      await a.locator('#btn-collab-close').click();
      const box = await a.locator('#sim-canvas').boundingBox();
      await a.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await a.mouse.wheel(150, 100);
      await expect.poll(async () => {
        const o = await b.evaluate(() => (window as any).getSimState().viewOffset);
        return Math.hypot(o.x - gBefore.x, o.y - gBefore.y);
      }, { timeout: 25000 }).toBeGreaterThan(1);

      // Host adds an image -> membership converges to the guest (rank item appears),
      // then the BYTES pull through the content-addressed asset layer: the guest's
      // pending thumbnail resolves once it has fetched the image by hash.
      await a.locator('#cfg-images').setInputFiles(FIXTURE_IMG);
      await expect(a.locator('#rank-list > li')).toHaveCount(1);
      await expect(b.locator('#rank-list > li')).toHaveCount(1, { timeout: 25000 });
      await expect(b.locator('#rank-list .im-rank-thumb')).not.toHaveClass(/im-rank-thumb-pending/, { timeout: 25000 });

      // Host removes the image -> the removal propagates via the membership doc.
      await a.locator('#rank-list > li').first().locator('.im-film-rm').click();
      await expect(a.locator('#rank-list > li')).toHaveCount(0);
      await expect(b.locator('#rank-list > li')).toHaveCount(0, { timeout: 25000 });

      // Guest adds an image -> membership converges up to the host, and the host pulls
      // the bytes by hash (the path that used to fail / loop).
      await b.locator('#cfg-images').setInputFiles(FIXTURE_IMG);
      await expect(b.locator('#rank-list > li')).toHaveCount(1);
      await expect(a.locator('#rank-list > li')).toHaveCount(1, { timeout: 25000 });
      await expect(a.locator('#rank-list .im-rank-thumb')).not.toHaveClass(/im-rank-thumb-pending/, { timeout: 25000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  // Regression: uploading many DISTINCT images at once made the receiver scramble
  // them -- many asset sends raced on one connection, and the receiver pairs a binary
  // with the single preceding header, so interleaved sends stored one image's bytes
  // under another's hash (wrong thumbnail / wrong image). Per-connection send
  // serialization fixes it. Here: guest adds N distinct images; the host must end up
  // with each hash mapping to bytes that actually hash back to that key (no cross-wire).
  test('many distinct images sync without cross-wiring', async ({ browser }) => {
    const N = 6;
    const room = 'pw-' + Math.random().toString(36).slice(2, 9);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await routeVendor(ctxA);
    await routeVendor(ctxB);
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    try {
      await a.goto(PAGE);
      await a.locator('#btn-collab').click();
      await a.locator('#collab-room-inp').fill(room);
      await a.locator('#btn-collab-join').click();
      await expect(a.locator('#collab-status')).toHaveText(/Hosting/, { timeout: 25000 });
      await b.goto(PAGE + '?room=' + room);
      await expect(b.locator('#collab-status')).toHaveText(/Connected as guest/, { timeout: 25000 });

      // Generate N visually-distinct PNGs (distinct bytes -> distinct content hashes).
      const dataUrls: string[] = await b.evaluate((n) => {
        const urls: string[] = [];
        for (let i = 0; i < n; i++) {
          const c = document.createElement('canvas');
          c.width = 96;
          c.height = 96;
          const x = c.getContext('2d')!;
          x.fillStyle = `rgb(${(i * 37) % 256},${(i * 73) % 256},${(i * 109) % 256})`;
          x.fillRect(0, 0, 96, 96);
          x.fillStyle = '#fff';
          x.font = '40px sans-serif';
          x.fillText('I' + i, 8, 56);
          urls.push(c.toDataURL('image/png'));
        }
        return urls;
      }, N);
      const files = dataUrls.map((u, i) => ({ name: `d${i}.png`, mimeType: 'image/png', buffer: Buffer.from(u.split(',')[1], 'base64') }));

      // Guest adds them all at once -> they sync to the host.
      await b.locator('#cfg-images').setInputFiles(files);
      await expect(b.locator('#rank-list > li')).toHaveCount(N);
      await expect(a.locator('#rank-list > li')).toHaveCount(N, { timeout: 30000 });
      // All host thumbnails resolve (bytes pulled).
      await expect(a.locator('#rank-list .im-rank-thumb-pending')).toHaveCount(0, { timeout: 30000 });

      // Integrity: every host image's stored bytes must hash back to its own assetHash.
      const bad = await a.evaluate(async () => {
        const ah = (bytes: Uint8Array) => {
          let h1 = 0x811c9dc5,
            h2 = 0x01000193;
          for (let i = 0; i < bytes.length; i++) {
            h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ bytes[i], 0x85ebca6b) >>> 0;
          }
          return bytes.length.toString(16) + '-' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
        };
        const meta = (window as any).getSessionMeta();
        const mism: string[] = [];
        const seen = new Set<string>();
        for (const im of meta.images) {
          const buf = await (window as any).getAssetBuffer(im.assetHash);
          if (!buf) {
            mism.push(im.id + ':nobytes');
            continue;
          }
          const got = ah(new Uint8Array(buf));
          if (got !== im.assetHash) mism.push(im.id + ':' + im.assetHash + '!=' + got);
          seen.add(im.assetHash);
        }
        return { mism, distinct: seen.size, count: meta.images.length };
      });
      expect(bad.mism).toEqual([]); // no bytes stored under the wrong hash
      expect(bad.distinct).toBe(N); // all distinct content
      expect(bad.count).toBe(N);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  // A big (multi-chunk) image must reassemble correctly through the resumable partial
  // path -- the slices accumulate in the persistent _assetPartials buffer, then finalize.
  test('a large multi-chunk image transfers with correct bytes', async ({ browser }) => {
    const room = 'pw-' + Math.random().toString(36).slice(2, 9);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await routeVendor(ctxA);
    await routeVendor(ctxB);
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    try {
      await a.goto(PAGE);
      await a.locator('#btn-collab').click();
      await a.locator('#collab-room-inp').fill(room);
      await a.locator('#btn-collab-join').click();
      await expect(a.locator('#collab-status')).toHaveText(/Hosting/, { timeout: 25000 });
      await b.goto(PAGE + '?room=' + room);
      await expect(b.locator('#collab-status')).toHaveText(/Connected as guest/, { timeout: 25000 });

      // Random-noise PNG (incompressible) -> ~200KB -> several 64KB chunks.
      const dataUrl = await b.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 256; c.height = 256;
        const x = c.getContext('2d')!;
        const img = x.createImageData(256, 256);
        for (let i = 0; i < img.data.length; i++) img.data[i] = i % 4 === 3 ? 255 : (Math.random() * 256) | 0;
        x.putImageData(img, 0, 0);
        return c.toDataURL('image/png');
      });
      const file = { name: 'big.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') };
      expect(file.buffer.byteLength).toBeGreaterThan(64 * 1024); // multi-chunk

      await b.locator('#cfg-images').setInputFiles([file]);
      await expect(a.locator('#rank-list > li')).toHaveCount(1, { timeout: 30000 });
      await expect(a.locator('#rank-list .im-rank-thumb-pending')).toHaveCount(0, { timeout: 30000 });

      const ok = await a.evaluate(async () => {
        const ah = (bytes: Uint8Array) => {
          let h1 = 0x811c9dc5, h2 = 0x01000193;
          for (let i = 0; i < bytes.length; i++) {
            h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ bytes[i], 0x85ebca6b) >>> 0;
          }
          return bytes.length.toString(16) + '-' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
        };
        const meta = (window as any).getSessionMeta();
        const buf = await (window as any).getAssetBuffer(meta.images[0].assetHash);
        return !!buf && ah(new Uint8Array(buf)) === meta.images[0].assetHash;
      });
      expect(ok).toBe(true); // reassembled bytes hash back to the declared content key
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  // Repro: a guest refresh makes it re-pull every image from the host. The host must
  // stop serving once the guest has them again -- not keep pushing in a loop.
  test('a guest refresh does not leave the host serving in a loop', async ({ browser }) => {
    const N = 4;
    const room = 'pw-' + Math.random().toString(36).slice(2, 9);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await routeVendor(ctxA);
    await routeVendor(ctxB);
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    try {
      await a.goto(PAGE);
      await a.locator('#btn-collab').click();
      await a.locator('#collab-room-inp').fill(room);
      await a.locator('#btn-collab-join').click();
      await expect(a.locator('#collab-status')).toHaveText(/Hosting/, { timeout: 25000 });
      await b.goto(PAGE + '?room=' + room);
      await expect(b.locator('#collab-status')).toHaveText(/Connected as guest/, { timeout: 25000 });

      const dataUrls: string[] = await b.evaluate((n) => {
        const urls: string[] = [];
        for (let i = 0; i < n; i++) {
          const c = document.createElement('canvas');
          c.width = 240; c.height = 240;
          const x = c.getContext('2d')!;
          const img = x.createImageData(240, 240);
          for (let j = 0; j < img.data.length; j++) img.data[j] = j % 4 === 3 ? 255 : ((j * (i + 7)) % 256);
          x.putImageData(img, 0, 0);
          x.fillStyle = '#fff'; x.font = '48px sans-serif'; x.fillText('R' + i, 8, 60);
          urls.push(c.toDataURL('image/png'));
        }
        return urls;
      }, N);
      const files = dataUrls.map((u, i) => ({ name: `r${i}.png`, mimeType: 'image/png', buffer: Buffer.from(u.split(',')[1], 'base64') }));

      await b.locator('#cfg-images').setInputFiles(files);
      await expect(a.locator('#rank-list > li')).toHaveCount(N, { timeout: 30000 });
      const hostHasAll = () => a.evaluate(() => (window as any).getSessionMeta().images.every((im: any) => (window as any).hasAsset(im.assetHash)));
      await expect.poll(hostHasAll, { timeout: 30000 }).toBe(true);

      // Guest refreshes -> re-joins -> re-pulls every image.
      await b.goto(PAGE + '?room=' + room);
      await expect(b.locator('#collab-status')).toHaveText(/Connected as guest/, { timeout: 25000 });
      const guestHasAll = () => b.evaluate(() => { const m = (window as any).getSessionMeta(); return m.images.length > 0 && m.images.every((im: any) => (window as any).hasAsset(im.assetHash)); });
      await expect.poll(guestHasAll, { timeout: 30000 }).toBe(true);

      // The guest now holds everything again. Measure the host's outgoing traffic while idle.
      await a.evaluate(() => { const s = (window as any)._sync; s.on = true; s.tx = { bytes: 0, msgs: {} }; s.rx = { bytes: 0, msgs: {} }; });
      await a.waitForTimeout(5000);
      const sa = await a.evaluate(() => ({ msgs: (window as any)._sync.tx.msgs, bytes: (window as any)._sync.tx.bytes }));
      console.log('HOST tx 5s after guest refresh+resync:', JSON.stringify(sa));
      expect(sa.bytes, 'host should not keep serving after guest re-synced').toBeLessThan(50 * 1024);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  // Regression: a session imported BEFORE hosting must reach a guest that joins later --
  // import populates state directly, so it has to be published into the shared doc too.
  test('an imported session syncs to a guest that joins afterward', async ({ browser }) => {
    const room = 'pw-' + Math.random().toString(36).slice(2, 9);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await routeVendor(ctxA);
    await routeVendor(ctxB);
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    try {
      // A imports a session while solo (not yet hosting)...
      await a.goto(PAGE);
      await a.locator('#inp-import-session').setInputFiles(SESSION_ZIP);
      await expect(a.locator('#rank-list > li')).toHaveCount(2, { timeout: 30000 });
      // ...and also adds an image the normal way. Unless the import is published into the
      // doc, the add-path doc update (which knows only the added image) would wipe the
      // imported images on the joiner via membership reconcile.
      await a.locator('#cfg-images').setInputFiles(FIXTURE_IMG);
      await expect(a.locator('#rank-list > li')).toHaveCount(3, { timeout: 30000 });

      // Then A hosts, and B joins afterward.
      await a.locator('#btn-collab').click();
      await a.locator('#collab-room-inp').fill(room);
      await a.locator('#btn-collab-join').click();
      await expect(a.locator('#collab-status')).toHaveText(/Hosting/, { timeout: 25000 });
      await b.goto(PAGE + '?room=' + room);
      await expect(b.locator('#collab-status')).toHaveText(/Connected as guest/, { timeout: 25000 });

      // B receives ALL images -- imported + added (membership synced) -- and pulls bytes.
      await expect(b.locator('#rank-list > li')).toHaveCount(3, { timeout: 30000 });
      await expect(b.locator('#rank-list .im-rank-thumb-pending')).toHaveCount(0, { timeout: 30000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('a room password gates guests', async ({ browser }) => {
    const room = 'pw-' + Math.random().toString(36).slice(2, 9);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await routeVendor(ctxA);
    await routeVendor(ctxB);
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    try {
      // Host sets a room password.
      await a.goto(PAGE);
      await a.locator('#btn-collab').click();
      await a.locator('#collab-room-inp').fill(room);
      await a.locator('#collab-pass-inp').fill('s3cret');
      await a.locator('#btn-collab-join').click();
      await expect(a.locator('#collab-status')).toHaveText(/Hosting/, { timeout: 25000 });

      // Wrong password -> rejected.
      await b.goto(PAGE);
      await b.locator('#btn-collab').click();
      await b.locator('#collab-room-inp').fill(room);
      await b.locator('#collab-pass-inp').fill('nope');
      await b.locator('#btn-collab-join').click();
      await expect(b.locator('#collab-status')).toHaveText(/Wrong room password/, { timeout: 25000 });

      // Correct password -> connects.
      await b.locator('#collab-pass-inp').fill('s3cret');
      await b.locator('#btn-collab-join').click();
      await expect(b.locator('#collab-status')).toHaveText(/Connected as guest/, { timeout: 25000 });
      await expect(a.locator('#collab-status')).toHaveText(/guest/, { timeout: 25000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

// Real two-context WebRTC smoke test. Uses the live PeerJS cloud broker, so it is
// skipped unless REAL_COLLAB=1 (needs internet; can flake on broker/STUN).
//   REAL_COLLAB=1 bunx playwright test tests/collab-real.spec.ts --project=chromium

import { test, expect } from '@playwright/test';
import { routeVendor, PAGE, FIXTURE_IMG } from './fixtures';

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

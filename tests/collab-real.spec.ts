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
      await expect(a.locator('#collab-status')).toHaveText(/Connected/, { timeout: 25000 });

      // B joins the same room via the URL param (auto-join).
      await b.goto(PAGE + '?room=' + room);
      await expect(b.locator('#collab-status')).toHaveText(/Connected/, { timeout: 25000 });

      // Both sides see one peer.
      await expect(a.locator('#collab-status')).toHaveText(/peer/, { timeout: 25000 });
      await expect(a.locator('#collab-peer-badge')).toBeVisible();
      await expect(b.locator('#collab-peer-badge')).toBeVisible();

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

      // Host adds an image -> it streams to the guest.
      await a.locator('#cfg-images').setInputFiles(FIXTURE_IMG);
      await expect(a.locator('#rank-list > li')).toHaveCount(1);
      await expect(b.locator('#rank-list > li')).toHaveCount(1, { timeout: 25000 });

      // Host removes the image -> the removal propagates to the guest.
      await a.locator('#rank-list > li').first().locator('.im-film-rm').click();
      await expect(a.locator('#rank-list > li')).toHaveCount(0);
      await expect(b.locator('#rank-list > li')).toHaveCount(0, { timeout: 25000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

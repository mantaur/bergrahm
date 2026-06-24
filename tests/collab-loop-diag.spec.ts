// Regression guard against background-traffic loops: once images are synced, the data
// channels should be quiet (only heartbeat pings, which are sent outside broadcast()).
// Uses the live broker, so it is gated behind REAL_COLLAB.
//   REAL_COLLAB=1 bunx playwright test tests/collab-loop-diag.spec.ts --project=chromium
// Relies on collaborate.js's opt-in tx counters: set window._txStats={} / _txBytes=0 to
// begin tallying broadcast + chunked-binary sends by message type.
import { test, expect } from '@playwright/test';
import { routeVendor, PAGE } from './fixtures';

test.describe('loop diag', () => {
  test.skip(!process.env.REAL_COLLAB, 'set REAL_COLLAB=1');

  test('no continuous traffic once images are synced', async ({ browser }) => {
    const N = 6;
    const room = 'pw-' + Math.random().toString(36).slice(2, 9);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await routeVendor(ctxA);
    await routeVendor(ctxB);
    const a = await ctxA.newPage(); // host (laptop)
    const b = await ctxB.newPage(); // guest (phone)
    a.on('console', (m) => console.log('[A]', m.text()));
    b.on('console', (m) => console.log('[B]', m.text()));

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
          c.width = 200; c.height = 200;
          const x = c.getContext('2d')!;
          x.fillStyle = `rgb(${(i * 37) % 256},${(i * 73) % 256},${(i * 109) % 256})`;
          x.fillRect(0, 0, 200, 200);
          x.fillStyle = '#fff'; x.font = '60px sans-serif'; x.fillText('I' + i, 10, 110);
          urls.push(c.toDataURL('image/png'));
        }
        return urls;
      }, N);
      const files = dataUrls.map((u, i) => ({ name: `d${i}.png`, mimeType: 'image/png', buffer: Buffer.from(u.split(',')[1], 'base64') }));

      await b.locator('#cfg-images').setInputFiles(files);
      await expect(b.locator('#rank-list > li')).toHaveCount(N);
      await expect(a.locator('#rank-list > li')).toHaveCount(N, { timeout: 30000 });
      await expect(a.locator('#rank-list .im-rank-thumb-pending')).toHaveCount(0, { timeout: 30000 });
      // Guest's own images present too.
      await expect(b.locator('#rank-list .im-rank-thumb-pending')).toHaveCount(0, { timeout: 30000 });

      // Let it settle, then reset counters on both sides.
      await a.waitForTimeout(3000);
      const reset = () => { (window as any)._txStats = {}; (window as any)._txBytes = 0; };
      await a.evaluate(reset);
      await b.evaluate(reset);

      // Idle window.
      await a.waitForTimeout(6000);

      const read = () => ({ stats: (window as any)._txStats, bytes: (window as any)._txBytes || 0 });
      const sa = await a.evaluate(read);
      const sb = await b.evaluate(read);
      console.log('HOST(A) idle 6s tx:', JSON.stringify(sa));
      console.log('GUEST(B) idle 6s tx:', JSON.stringify(sb));

      // After settle, idle traffic should be tiny (heartbeat pings are sent outside
      // broadcast()). A loop shows up as a large byte count or a repeated message type.
      expect(sa.bytes, 'host bytes/6s').toBeLessThan(50 * 1024);
      expect(sb.bytes, 'guest bytes/6s').toBeLessThan(50 * 1024);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

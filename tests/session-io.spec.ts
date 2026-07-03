// Session export + import. Consumes tests/fixtures/session.zip (2 imgs, img0 has
// 1 polygon) produced by session.setup.ts.

import { test, expect, addImage, paintPolygon, imageCount, polyCount, collabOut, FIXTURE_IMG, SESSION_ZIP } from './fixtures';

test.describe('Session export', () => {
  test('exports a zip and reports Exported', async ({ page }) => {
    // Export runs a CPU-heavy worker (JPEG encode + DEFLATE zip); under the full
    // parallel suite it can take longer than the default 30s, so give it room.
    test.setTimeout(60_000);
    await addImage(page);
    await paintPolygon(page);
    await page.locator('#step-images .im-step-hd').click();

    const exportBtn = page.locator('#btn-export-session');
    await expect(exportBtn).toBeEnabled();

    const dl = page.waitForEvent('download', { timeout: 45_000 });
    await exportBtn.click();
    expect((await dl).suggestedFilename()).toBe('merger-session.zip');
    await expect(page.locator('#session-status')).toHaveText(/Exported/, { timeout: 15000 });
  });
});

test.describe('Session import', () => {
  test('imports into an empty app (replace path, no confirm)', async ({ page }) => {
    await page.locator('#inp-import-session').setInputFiles(SESSION_ZIP);
    // Empty app -> no confirm dialog; images load directly.
    await expect(page.locator('#session-confirm')).toHaveClass(/im-hidden/);
    await expect.poll(() => imageCount(page)).toBe(2);
    await expect(page.locator('#paint-area')).not.toHaveClass(/im-hidden/);
    await expect(page.locator('#step-paint')).not.toHaveClass(/im-step-locked/);
    await expect(page.locator('#rank-list > li')).toHaveCount(2);
    expect(await polyCount(page, 0)).toBe(1); // restored mask

    // A local import fires collab:session-loaded so a host re-streams to guests
    // (and any guest prompt is dismissed). See collaborate.js.
    expect((await collabOut(page, 'collab:session-loaded')).length).toBeGreaterThanOrEqual(1);
  });

  test('shows confirm dialog when a session is already active', async ({ page }) => {
    await addImage(page);
    await page.locator('#inp-import-session').setInputFiles(SESSION_ZIP);
    await expect(page.locator('#session-confirm')).not.toHaveClass(/im-hidden/);
  });

  test('Replace wipes existing and loads the imported session', async ({ page }) => {
    await addImage(page, FIXTURE_IMG); // 1 image
    await page.locator('#inp-import-session').setInputFiles(SESSION_ZIP);
    await page.locator('#btn-sess-replace').click();
    await expect.poll(() => imageCount(page)).toBe(2);
    await expect(page.locator('#rank-list > li')).toHaveCount(2);
  });

  test('Add appends the imported session to existing images', async ({ page }) => {
    await addImage(page, FIXTURE_IMG); // 1 image
    await page.locator('#inp-import-session').setInputFiles(SESSION_ZIP);
    await page.locator('#btn-sess-add').click();
    await expect.poll(() => imageCount(page)).toBe(3); // 1 + 2
    await expect(page.locator('#rank-list > li')).toHaveCount(3);
  });

  test('Cancel leaves existing state untouched', async ({ page }) => {
    await addImage(page, FIXTURE_IMG); // 1 image
    await page.locator('#inp-import-session').setInputFiles(SESSION_ZIP);
    await page.locator('#btn-sess-cancel').click();
    await expect(page.locator('#session-confirm')).toHaveClass(/im-hidden/);
    expect(await imageCount(page)).toBe(1);
  });

  // One undecodable image must not abort the import: its compressed bytes still
  // land (thumb-less), every other image loads, and the run ends in "Imported".
  test('import survives an image the decoder rejects', async ({ page }) => {
    await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js' });
    const zipB64 = await page.evaluate(async () => {
      const cv = document.createElement('canvas');
      cv.width = 40; cv.height = 30;
      cv.getContext('2d')!.fillRect(0, 0, 40, 30);
      const good = await new Promise<Blob>((r) => cv.toBlob((b) => r(b!), 'image/jpeg'));

      const zip = new (window as any).JSZip();
      zip.file('images/0.jpg', await good.arrayBuffer());
      zip.file('images/1.jpg', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])); // garbage bytes
      zip.file('session.json', JSON.stringify({
        version: 2, outW: 800, outH: 600, fillColor: '#ffffff', blendMode: 'gradient',
        seed: 42, ditherExp: 4, slides: 1, useYolo: false,
        rankOrder: ['good', 'bad'], paintIdx: 0,
        images: [
          { id: 'good', name: 'good.jpg', w: 40, h: 30, scale: null, polygons: [], currentPoly: [] },
          { id: 'bad', name: 'bad.jpg', w: 40, h: 30, scale: null, polygons: [], currentPoly: [] },
        ],
      }));
      return zip.generateAsync({ type: 'base64' });
    });

    await page.locator('#inp-import-session').setInputFiles({
      name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from(zipB64, 'base64'),
    });

    await expect(page.locator('#session-status')).toHaveText(/Imported/, { timeout: 15000 });
    expect(await imageCount(page)).toBe(2);
    // The bad image's bytes were still shipped for later use/export.
    const badLen = await page.evaluate(async () => (await (window as any).getImageBuffer('bad'))?.buffer.byteLength ?? 0);
    expect(badLen).toBe(8);
  });

  // The host streams imported images to a collab guest via these window getters:
  // raw bytes by content hash (getImageBuffer) + a portable data-URL thumbnail
  // (getImageThumb, never a blob: URL, which is only valid in the host's document).
  test('imported images expose portable bytes + data-URL thumb for collab streaming', async ({ page }) => {
    await page.locator('#inp-import-session').setInputFiles(SESSION_ZIP);
    await expect.poll(() => imageCount(page)).toBe(2);

    const read = () => page.evaluate(async () => {
      const meta = (window as any).getSessionMeta();
      const id   = meta.images[0].id;
      const buf  = await (window as any).getImageBuffer(id);
      if (!buf) return null; // pixels still streaming in
      return {
        bufLen: buf.buffer.byteLength,
        assetHash: buf.assetHash || '',
        thumb: (window as any).getImageThumb(id) || '',
      };
    });

    await expect.poll(async () => (await read())?.bufLen ?? 0).toBeGreaterThan(0);
    const r = await read();
    expect(r!.assetHash).toBeTruthy();                   // content key travels with the bytes
    expect(r!.thumb.startsWith('data:')).toBe(true);     // portable thumbnail, not blob:
  });
});

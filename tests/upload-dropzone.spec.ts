// Upload zone lights green while image files are dragged over it. The hidden file
// input ingests the actual drop; these listeners only drive the highlight class.

import { test, expect } from './fixtures';

test('upload zone lights green for file drags, clears on leave (chromium)', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', 'DragEvent constructor ignores dataTransfer on Firefox desktop');
  const zone = page.locator('.im-upload-zone');

  // Dragging a file over -> green class on.
  await page.evaluate(() => {
    const z = document.querySelector('.im-upload-zone')!;
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }));
    z.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(zone).toHaveClass(/im-uz-drag/);

  // Leaving the zone (relatedTarget outside) -> class off.
  await page.evaluate(() => {
    const z = document.querySelector('.im-upload-zone')!;
    z.dispatchEvent(new DragEvent('dragleave', { relatedTarget: document.body, bubbles: true }));
  });
  await expect(zone).not.toHaveClass(/im-uz-drag/);

  // A non-file drag (plain text) must not light it.
  await page.evaluate(() => {
    const z = document.querySelector('.im-upload-zone')!;
    const dt = new DataTransfer();
    dt.setData('text/plain', 'hello');
    z.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(zone).not.toHaveClass(/im-uz-drag/);
});

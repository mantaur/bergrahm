// Shared Playwright fixture + helpers for Image Merger functional tests.
//
//  - Routes the three runtime CDNs (peerjs, qrcodejs, jszip) to local vendored
//    copies so the suite runs offline + deterministic. jszip is fetched from
//    inside the session worker via importScripts; context-level routing covers it.
//  - Installs a collab spy: outgoing `collab:*` CustomEvents are recorded into
//    window.__collabOut so tests can assert the app emits the right intent
//    without a live peer connection.
//  - Auto-navigates each test to the imgMerger page.

import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const PAGE = '/assets/pages/projects/imgMerger/index.html';
export const FIXTURE_IMG = 'tests/fixtures/test-image.png';
export const FIXTURE_IMG2 = 'tests/fixtures/image2.png';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(_dir, 'vendor');

// Outgoing collab event types imageMerge.js dispatches on window.
const COLLAB_OUT_TYPES = [
  'collab:images-added', 'collab:image-removed', 'collab:polygon-changed',
  'collab:settings-changed', 'collab:rank-order-changed', 'collab:body-grabbing',
  'collab:body-moved', 'collab:body-releasing', 'collab:body-lift',
  'collab:scales-changed', 'collab:canvas-resized', 'collab:encoding-ready',
];

function jsFile(file: string) {
  return { contentType: 'application/javascript', body: fs.readFileSync(path.join(VENDOR, file)) };
}

// Map the CDN requests the app makes to local vendored files.
export async function routeVendor(context: BrowserContext) {
  await context.route(/unpkg\.com\/.*peerjs/i, r => r.fulfill(jsFile('peerjs.min.js')));
  await context.route(/qrcodejs/i,             r => r.fulfill(jsFile('qrcode.min.js')));
  await context.route(/cdnjs\.cloudflare\.com\/.*jszip/i, r => r.fulfill(jsFile('jszip.min.js')));
}

// Init script (string form so it can be reused for manually-created pages).
const COLLAB_SPY_INIT = `
  window.__collabOut = [];
  for (const t of ${JSON.stringify(COLLAB_OUT_TYPES)}) {
    window.addEventListener(t, (e) => {
      let detail = null;
      try { detail = JSON.parse(JSON.stringify(e.detail)); } catch (_) {}
      window.__collabOut.push({ type: t, detail });
    });
  }
`;

export const test = base.extend<{}>({
  context: async ({ context }, use) => {
    await routeVendor(context);
    await use(context);
  },
  page: async ({ page }, use) => {
    await page.addInitScript(COLLAB_SPY_INIT);
    await page.goto(PAGE);
    await use(page);
  },
});

export { expect };

// ── Helpers ───────────────────────────────────────────────────────────────────

// Add one or more images via the file input; waits until the paint area appears.
export async function addImage(page: Page, files: string | string[] = FIXTURE_IMG) {
  const before = await imageCount(page);
  const list = Array.isArray(files) ? files : [files];
  await page.locator('#cfg-images').setInputFiles(list);
  await expect(page.locator('#paint-area')).not.toHaveClass(/im-hidden/);
  await expect.poll(() => imageCount(page)).toBe(before + list.length);
}

// Open the Paint Masks accordion step so the canvas has layout, then paint a
// polygon by clicking vertices on the canvas and closing on the first vertex.
export async function paintPolygon(
  page: Page,
  pts: { x: number; y: number }[] = [{ x: 40, y: 40 }, { x: 140, y: 40 }, { x: 90, y: 120 }],
) {
  await openPaintStep(page);
  const wrap = page.locator('#canvas-wrap');
  await expect(wrap).toBeVisible();
  for (const p of pts) await wrap.click({ position: p });
  await wrap.click({ position: pts[0] }); // click first vertex again to close
}

// Close the settings panel (so it doesn't overlay the sim canvas) via Escape.
export async function closePanel(page: Page) {
  if (await page.locator('#panel-wrap').evaluate(el => !el.classList.contains('im-panel-hidden'))) {
    await page.keyboard.press('Escape');
  }
  await expect(page.locator('#panel-wrap')).toHaveClass(/im-panel-hidden/);
}

// Client-space coords of a sim group's centre (mirrors collaborate.js physicsToClient).
export function groupClientPos(page: Page, imgIdx: number): Promise<{ x: number; y: number }> {
  return page.evaluate((i) => {
    const pos = (window as any).getSimPositions()[i];
    const st = (window as any).getSimState();
    const canvas = document.getElementById('sim-canvas') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const ts = st.dispScale * st.viewScale;
    const cx = (pos.x - st.viewOffset.x) * ts;
    const cy = (pos.y - st.viewOffset.y) * ts;
    return {
      x: cx * rect.width / canvas.width + rect.left,
      y: cy * rect.height / canvas.height + rect.top,
    };
  }, imgIdx);
}

export async function openPaintStep(page: Page) {
  const step = page.locator('#step-paint');
  if (!(await step.evaluate(el => el.classList.contains('im-step-open')))) {
    await step.locator('.im-step-hd').click();
  }
  await expect(step).toHaveClass(/im-step-open/);
}

// ── State inspection (via the app's window.* getters) ──────────────────────────

export function imageCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).getSessionMeta?.().imageCount ?? 0);
}

export function polyCount(page: Page, imgIdx: number): Promise<number> {
  return page.evaluate((i) => {
    const m = (window as any).getSessionMeta?.();
    return m?.images?.[i]?.polygons?.length ?? 0;
  }, imgIdx);
}

export function simPos(page: Page, imgIdx: number): Promise<{ x: number; y: number; angle: number } | null> {
  return page.evaluate((i) => (window as any).getSimPositions?.()[i] ?? null, imgIdx);
}

export function imageScale(page: Page, imgIdx: number): Promise<number | null> {
  return page.evaluate((i) => {
    const m = (window as any).getSessionMeta?.();
    return m?.images?.[i]?.scale ?? null;
  }, imgIdx);
}

// ── Collab event contract ──────────────────────────────────────────────────────

// Dispatch an incoming peer event (what collaborate.js would emit on a message).
export function emitRemote(page: Page, type: string, detail: any) {
  return page.evaluate(({ type, detail }) => {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }, { type, detail });
}

// Read recorded outgoing collab events of a given type.
export function collabOut(page: Page, type: string): Promise<any[]> {
  return page.evaluate((t) => ((window as any).__collabOut || []).filter((e: any) => e.type === t), type);
}

// A tiny valid 2x2 PNG as a data URL (used as remote image payload in sim tests).
// The remote-image handler only does `img.src = <this>`, so PNG is fine.
export const TINY_IMG_DATAURL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mM4ERAARAwQCgApTgWh/NRB6gAAAABJRU5ErkJggg==';

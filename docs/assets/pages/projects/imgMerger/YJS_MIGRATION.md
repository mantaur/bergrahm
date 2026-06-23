# Yjs metadata migration -- status + continuation

Goal: sync all collaborative *metadata* through a Yjs CRDT so concurrent edits
converge to one consistent state (no last-writer races). Large binary stays OUT
of the doc.

## Architecture

- **Bytes** (image raw data): content-addressed asset layer (`assetStore` +
  `assetHash` in imageMerge.js). Pulled on demand by hash with retry. NOT in Yjs.
- **Thumbnails / encodings**: derived locally / synced on their own paths. NOT in Yjs.
- **Metadata**: a single `Y.Doc` (`window.ydoc` in collaborate.js). Updates ride the
  existing PeerJS data channels via the `ydoc-update` message (base64 Yjs update;
  host relays; idempotent). On join the host sends full state (`_sendDocState`).
- Yjs is vendored as a single self-contained ESM (`vendor/yjs.mjs`, built with
  `bun build`). crypto.subtle is avoided everywhere (undefined on plain-http LAN).

## Migrated (done, tested -- offline + real-WebRTC smoke for settings)

| Domain     | Y type                      | Apply event (remote)        |
|------------|-----------------------------|-----------------------------|
| settings   | `ydoc.getMap("settings")`   | `applyRemoteSettings(json)` |
| rankOrder  | `ydoc.getArray("rankOrder")`| `applyRemoteRankOrder(arr)` |
| polygons   | `ydoc.getMap("polygons")`   | `collab:remote-polygon`     |
| scales     | `ydoc.getMap("scales")`     | `collab:remote-scales`      |

## The migration pattern (per domain)

1. Add the Y type next to `ySettings` in collaborate.js.
2. Add an `observe((event, txn) => { if (txn.origin !== "remote") return; ... })`
   that applies the change locally (call the existing `applyRemote*` / dispatch the
   existing `collab:remote-*` event -- so app-side apply logic is unchanged).
3. Change the local `collab:*-changed` listener to `ydoc.transact(() => yType.set(...),
   "local")` instead of `broadcast(...)`.

Key mechanisms / gotchas:
- **Origin tags**: local writes use origin `"local"`; remote applies use `"remote"`
  (`Y.applyUpdate(ydoc, u, "remote")`). Observers act only on `"remote"` -> no echo loop.
- `applyRemoteSettings` self-guards (`window._collabApplyingRemote`) so applying a
  remote change can't re-broadcast. Reuse that pattern for any new apply path that
  touches inputs which themselves trigger `collab:*-changed`.
- **Transitional dual-system**: un-migrated domains still use the old messages, and
  the old handleMsg cases (`settings`/`rank-order`/`polygon`/`scales`) remain as
  harmless dead code. Remove them once nothing sends those messages. session-meta
  still redundantly carries settings; drop that after membership is migrated.

## Remaining domains

1. **positions** (high-frequency; live drag). Today: `collab:body-moved` /
   `bodies-moved` / `body-dragging` -> `positions` -> `collab:remote-positions`.
   Recommend: `ydoc.getMap("positions")` of `id -> {x,y,angle}`. **Keep live-drag
   frames on the ephemeral `drag`/`positions` message** (don't write the doc every
   frame); write the doc only on **commit** (`body-moved`/`bodies-moved`). MUST be
   verified in a real browser for drag smoothness + convergence.
2. **Per-image membership + metadata** (name, w, h, assetHash, simHidden,
   currentPoly). The image LIST. Intertwines with the asset layer and the
   session-meta join. Recommend `ydoc.getMap("images")` of `id -> Y.Map(meta)`;
   add/remove flow through the doc; the asset layer pulls bytes by `assetHash`. This
   replaces session-meta's image list + the skeleton/announce path. Largest change.
3. **Presence** (cursors, grab-locks). Natural fit for Yjs **Awareness**, but the
   vendored bundle is `yjs` only (no `y-protocols/awareness`). Either vendor
   awareness separately, or leave presence on the existing ephemeral messages
   (ephemeral data is a weak CRDT fit anyway). Lowest priority.

## Verifying

- Offline: event-contract tests in `tests/collab-sim.spec.ts` (local edit -> doc;
  remote doc update -> apply).
- Real WebRTC: `REAL_COLLAB=1 bunx playwright test tests/collab-real.spec.ts
  --project=chromium`. Add a per-domain convergence assertion (host edits -> guest
  observes) as each domain lands -- this is the only test that exercises real
  Yjs-over-data-channel convergence.

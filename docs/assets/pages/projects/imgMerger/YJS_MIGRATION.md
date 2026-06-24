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

| Domain     | Y type                      | Apply event (remote)         |
|------------|-----------------------------|------------------------------|
| settings   | `ydoc.getMap("settings")`   | `applyRemoteSettings(json)`  |
| rankOrder  | `ydoc.getArray("rankOrder")`| `applyRemoteRankOrder(arr)`  |
| polygons   | `ydoc.getMap("polygons")`   | `collab:remote-polygon`      |
| scales     | `ydoc.getMap("scales")`     | `collab:remote-scales`       |
| membership | `ydoc.getMap("images")`     | `applyRemoteMembership(snap)`|

### Membership notes (the image list)
- `yImages` holds per-image meta only (id, name, w, h, **assetHash**, simHidden,
  scaleFixed, currentPoly, simPos/simAngle). **Bytes are never in the doc** -- they are
  pulled by `assetHash` via the content-addressed asset layer.
- `applyRemoteMembership(snap)` reconciles local state to `{images, order, polygons,
  scales}`: builds skeletons for new ids (applying mask+scale from the doc at build
  time -> fixes the "mask arrived before its image" drop), removes images the doc lacks,
  sets rank order, then `reconcileAssets()` pulls bytes.
- **Mutual doc exchange on (re)connect**: both host and guest `_sendDocState` to each
  other. Yjs merges are commutative + idempotent, so this converges membership without
  re-streaming -- it replaced the old "resend missing images" hack AND the full-res
  streaming in `sendSessionTo` (both were the reconnect-storm loop).
- **Asset reconcile must fill-from-store, not only request**: content addressing means
  the bytes may already be local (shared/re-added content, or a prior pull). If
  `assetStore.has(hash)`, populate the entry from the store; only request when truly
  absent. `removeImage` evicts unreferenced bytes (memory + avoids a stale store entry
  suppressing a later pull). This was a real bug caught by the real-WebRTC smoke.

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
- **Transitional dual-system**: the old handleMsg cases (`settings`/`rank-order`/
  `polygon`/`scales`/`image`/`image-removed`/`image-binary`/`image-full`) and the
  `sendImageBinary`/`_forwardImageBinary`/skeleton receive paths remain as harmless
  dead code (nothing sends those messages now). `sendSessionTo` still sends
  `session-meta` + thumbnails on join (redundant with the doc but deduped by id); it no
  longer streams full-res bytes. Safe cleanup once confident: drop the dead messages and
  fold `session-meta`'s remaining role (paintIdx, simView) into the doc, retiring
  `sendSessionTo` entirely.

## Remaining domains

1. **positions** (high-frequency; live drag). Today: `collab:body-moved` /
   `bodies-moved` / `body-dragging` -> `positions` -> `collab:remote-positions`.
   Membership carries a *creation-time* simPos, and live moves still ride the ephemeral
   `positions` path -- so a peer that joins AFTER moves can see a stale initial
   position until the next move. To fix: write committed positions into the doc on
   `body-moved`/`bodies-moved` (a `ydoc.getMap("positions")` of `id -> {x,y,angle}`, or
   fold into the membership entry), keeping live-drag frames ephemeral. MUST be verified
   in a real browser for drag smoothness + convergence.
2. **Presence** (cursors, grab-locks). Natural fit for Yjs **Awareness**, but the
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

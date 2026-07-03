# Image rendering notes (2026-07-03)

Snapshot of the rendering discussion after the Android blob-storage bug hunt,
kept so we can revisit the open options later.

## How rendering works today

Thumbnails (filmstrip): at import the worker decodes the JPEG straight to
~256px (createImageBitmap with resize), re-encodes to a small JPEG, and the
main thread turns it into a base64 data: URL assigned to a plain img element.
So thumbs ARE img elements, but of a self-made 256px copy, not the original.
The data-URL form is deliberate: portable across collab peers (blob: URLs are
not), and 40 thumbs cost ~2MB total.

Mask painting step: a canvas. On navigation we decode the original bytes to
the canvas backing size (display width x dpr, capped), drawImage, and drop the
bitmap immediately. Nothing decoded is retained; stepping back re-decodes. The
mask overlay is a second canvas on top.

Decode source (since build 98): compressed bytes live in a JS ArrayBuffer
(entry.bytes); each decode mints a transient Blob -> createImageBitmap ->
fallback img element.

## How the web typically does it

Plain img src and the browser owns everything: async decode, decode-to-layout
size, a shared discardable image cache (decoded pixels dropped under pressure
and silently re-decoded), GPU upload. JS never touches pixels. Canvas /
createImageBitmap is the "app manages pixels" path -- appropriate for editors
(the painter genuinely needs it: pixel-space pointer math, mask compositing,
merge), but lifetime and memory management become ours.

## Assessment

The memory-saving decodes (decode-to-target-size) are NOT the flakiness
source -- the browser does the same internally; keep them. The residual
"works sometimes" pointed at the remaining blob-storage touchpoints: every
decode still minted a transient Blob, the import worker built blobs, and the
img fallback used an object URL -- all through the same storage layer that
Android Chrome demonstrably broke (NotReadableError on read-back).

## Options

1. ImageDecoder (WebCodecs) as primary decode -- consumes the ArrayBuffer
   directly, zero Blob involvement. Feature-detect; keep the blob chain as
   fallback (Firefox/Safari coverage). IMPLEMENTED (build 100).
   CAVEAT found during implementation: ImageDecoder is [SecureContext] --
   it does NOT exist on plain-http LAN origins (the usual phone test setup;
   same reason crypto.subtle is avoided in the asset store). On https
   (deployed site) and localhost it engages. For insecure contexts the chain
   ends in an img element fed a data: URL built from entry.bytes -- inline
   bytes, no blob storage, available everywhere.
   Watch item: EXIF orientation. createImageBitmap(blob) applies EXIF
   rotation by default; ImageDecoder output should too on modern Chrome, but
   if a file-added portrait photo ever renders rotated/distorted in the
   painter, suspect this path first.

2. Painter as img-under-mask-canvas instead of drawing the photo into the
   canvas -- the browser would manage the photo's decode/cache lifecycle and
   only the mask stays app-managed. Bigger surgery, less certain payoff.
   NOT implemented; revisit if painter rendering is still flaky after (1).

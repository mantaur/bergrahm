// Local static server for docs/, mirroring what GitHub Pages serves. Run: bun scripts/serve-docs.ts
const root = new URL("../docs/", import.meta.url);
const port = Number(process.env.PORT || 4321);

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    let file = Bun.file(new URL("." + pathname, root));
    if (!(await file.exists())) {
      file = Bun.file(new URL("." + pathname + "/index.html", root));
    }
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(file);
  },
});

console.log(`Serving docs/ at http://localhost:${port}`);

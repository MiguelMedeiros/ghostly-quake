/**
 * Builds Arena's page, dist/index.html: the engine's glue and the app's script and styles inline, nothing loaded by URL
 * (the runner's sandbox allows no other way in). Both scripts are classic, not modules, so they run the same when the
 * runner writes the entry into its frame. The engine's wasm and the game data are not in the page: they are files of
 * the bundle beside it (dist/game/, copied by scripts/assets.mjs), read through `ghostly.file`.
 *
 * The glue, engine/dist/fte.js, is emscripten's output for FTEQW (scripts/engine.mjs). It is wrapped in
 * `window.ghostlyFte = function (Module) {…}` so the app starts the engine when a match needs it, with the Module it
 * builds (src/engine.ts); it stays in a script of its own because it is sloppy-mode code (it assigns globals).
 *
 * Notices: the npm packages the script carries, with their licence texts, then the engine's and the game data's. A
 * package with no licence file fails the build.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE"];

/** Notices of what the page and its files carry besides npm packages, [title, file]. */
export const ASSET_NOTICES: [string, string][] = [
  ["FTEQW engine (GPL-2.0)", "assets/fteqw/NOTICE"],
  ["GNU General Public License, version 2", "assets/fteqw/LICENSE"],
  ["LibreQuake game data (BSD-3-Clause; game code GPL-2.0-or-later)", "assets/librequake/NOTICE"],
  ["LibreQuake licence (BSD-3-Clause)", "assets/librequake/COPYING"],
];

/** The notice block for the npm packages among these module ids, then the engine's and the data's. */
export function thirdPartyNotices(moduleIds: string[], assets: [string, string][] = ASSET_NOTICES): string {
  const packages = new Map<string, string>();
  for (const id of moduleIds) {
    const match = /^(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(id.replace(/\\/g, "/").replace(/^\0/, ""));
    if (match) packages.set(match[2], match[1]);
  }
  const blocks = [...packages].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, dir]) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license?: string };
    const file = LICENSE_FILES.map((f) => join(dir, f)).find((f) => existsSync(f));
    if (!file) throw new Error(`${name} has no license file to carry in the bundle`);
    return `${name} ${pkg.version} (${pkg.license ?? "see below"})\n\n${readFileSync(file, "utf8").trim()}`;
  });
  for (const [title, file] of assets) blocks.push(`${title}\n\n${readFileSync(join(import.meta.dirname, file), "utf8").trim()}`);
  const text = `Arena, a Ghostly mini-app. Copyright (C) 2026 Miguel Medeiros. GPL-2.0-only (see below): its source is at\nhttps://github.com/MiguelMedeiros/ghostly-quake.\n\nThird-party software and data in this app:\n\n${blocks.join("\n\n----\n\n")}`;
  if (text.includes("*/")) throw new Error("a license text would end the notice comment early");
  return text;
}

/** The engine's glue, wrapped so the app can start it with its own Module. */
export function engineScript(glue: string = readFileSync(join(import.meta.dirname, "engine/dist/fte.js"), "utf8")): string {
  if (/<\/script|<!--/i.test(glue)) throw new Error("the engine's glue contains text that would end its tag early");
  return `window.ghostlyFte = function (Module) {\n${glue}\nreturn { cbuf: function (text) { FTEC.cbufadd(text); }, ready: function () { return FTEC.evcb.cbufaddtext != 0; } };\n};`;
}

function singleFile(): Plugin {
  return {
    name: "ghostly-mini-app-single-file",
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = Object.values(bundle);
      const html = files.find((f) => f.type === "asset" && f.fileName.endsWith(".html"));
      const chunks = files.filter((f) => f.type === "chunk");
      const styles = files.filter((f) => f.type === "asset" && f.fileName.endsWith(".css"));
      if (!html || html.type !== "asset" || chunks.length !== 1 || chunks[0].type !== "chunk") {
        return this.error("expected one HTML page and one script chunk");
      }
      const chunk = chunks[0];
      const others = files.filter((f) => f !== html && f !== chunk && !styles.includes(f));
      if (others.length) return this.error(`files that cannot be inlined: ${others.map((f) => f.fileName).join(", ")}`);
      const code = chunk.code;
      const css = styles.map((s) => (s.type === "asset" ? String(s.source).replace(/\/\*\$vite\$:\d+\*\/\s*/g, "") : "")).join("\n");
      for (const [what, text, bad] of [["script", code, /<\/script|<!--/i], ["styles", css, /<\/style/i]] as const) {
        if (bad.test(text)) return this.error(`the ${what} contains text that would end its tag early`);
      }
      const notice = thirdPartyNotices(Object.keys(chunk.modules));
      // The page is written here whole rather than edited from Vite's: index.html is only the dev server's entry.
      html.source = [
        "<!doctype html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="utf-8" />',
        '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
        "    <title>Arena</title>",
        `    <style>\n${css}</style>`,
        "  </head>",
        "  <body>",
        '    <div id="app"></div>',
        `    <script>\n/*!\n${notice}\n*/\n${engineScript()}\n</script>`,
        `    <script>\n(() => {\n${code}\n})();\n</script>`,
        "  </body>",
        "</html>",
        "",
      ].join("\n");
      delete bundle[chunk.fileName];
      for (const s of styles) delete bundle[s.fileName];
    },
  };
}

/** For `npm run dev`: the glue as a script, and the bundle's files at /game/. */
function devServer(): Plugin {
  return {
    name: "ghostly-arena-dev",
    apply: "serve",
    transformIndexHtml: (html) => html.replace("<!--engine-->", `<script>\n${engineScript()}\n</script>`),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const files: Record<string, string> = { "/game/engine.wasm.gz": "engine/dist/fte.wasm.gz", "/game/arena.pk3": "data/arena.pk3" };
        const file = req.url && files[req.url];
        if (!file) return next();
        res.setHeader("content-type", "application/octet-stream");
        res.end(readFileSync(join(import.meta.dirname, file)));
      });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [singleFile(), devServer()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    modulePreload: false,
    reportCompressedSize: false,
  },
});

// Puts what `ghostly app publish` bundles into one folder: the built page, the game files, the icon, and the manifest,
// ghostly-app.json, as it is. `ghostly app publish` takes every file in the folder it is given (folders included), so
// it must never be run on the repository itself. See docs/PUBLISHING.md.
//
//   npm run build && npm run stage [-- <folder>]    (default: release/)
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { bundleFiles, root } from "./files.mjs";

const out = resolve(process.argv[2] ?? resolve(root, "release"));
const files = bundleFiles();
const manifest = JSON.parse(readFileSync(resolve(root, "ghostly-app.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
for (const [path, file] of files) {
  mkdirSync(dirname(resolve(out, path)), { recursive: true });
  copyFileSync(file, resolve(out, path));
}
copyFileSync(resolve(root, "ghostly-app.json"), resolve(out, "ghostly-app.json"));
console.log(`staged Arena ${manifest.version} in ${out}: ${files.map(([p]) => p).join(", ")}, ghostly-app.json`);

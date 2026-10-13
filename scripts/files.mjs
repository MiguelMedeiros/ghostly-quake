// The bundle's files, as `ghostly app publish` names them: the built page and the game files beside it (dist/), and
// the icon. Shared by digest, stage and check:bundle.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GAME_FILES } from "./assets.mjs";

export const root = new URL("..", import.meta.url).pathname;
/** WISP 1200: a whole bundle is at most 16 MiB. */
export const BUNDLE_LIMIT = 16 * 1024 * 1024;

/** [path in the bundle, file on disk], sorted by path as the manifest lists them. */
export function bundleFiles() {
  const list = [["index.html", resolve(root, "dist/index.html")], ...GAME_FILES.map(([path]) => [path, resolve(root, "dist", path)]), ["icon.png", resolve(root, "assets/icon.png")]];
  for (const [path, file] of list) if (!existsSync(file)) throw new Error(`no ${file} for ${path}: run npm run build first`);
  return list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The bundle's files with their bytes. */
export const readBundleFiles = () => bundleFiles().map(([path, file]) => ({ path, bytes: readFileSync(file) }));

// Puts the bundle's data files beside the built page: dist/game/engine.wasm.gz (the engine, engine/dist/fte.wasm.gz)
// and dist/game/arena.pk3 (the game data, data/arena.pk3). `npm run build` runs it after Vite; the page reads both
// through `ghostly.file`. The files are copied as they are committed, so the same commit always gives the same bytes.
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
/** The bundle's files besides index.html: [path in the bundle, source in the repository]. */
export const GAME_FILES = [
  ["game/arena.pk3", "data/arena.pk3"],
  ["game/engine.wasm.gz", "engine/dist/fte.wasm.gz"],
];

if (process.argv[1] && resolve(process.argv[1]) === resolve(root, "scripts/assets.mjs")) {
  mkdirSync(resolve(root, "dist/game"), { recursive: true });
  for (const [path, source] of GAME_FILES) copyFileSync(resolve(root, source), resolve(root, "dist", path));
}

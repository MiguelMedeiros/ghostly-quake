// Builds the engine: FTEQW at a pinned commit, with engine/patches/ applied, compiled to WebAssembly by a pinned
// emscripten image. Writes engine/dist/fte.js (the glue), engine/dist/fte.wasm and fte.wasm.gz (what the bundle
// carries), and their SHA-256 in engine/dist/SHA256SUMS. Those files are committed, so `npm run build` needs no Docker; this script is how they are
// made, and `--check` makes them again and says whether the bytes are the committed ones.
//
//   npm run engine                 build and replace engine/dist/
//   npm run engine -- --check      build into engine/.build/ and compare with engine/dist/ (exit 1 on a difference)
//
// Needs git and Docker. The source is cloned into engine/.build/ (ignored by git). A heavy build: on the shared Mac,
// run it under `lockf -k /tmp/ghostly-heavy.lock npm run engine`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "fflate";

/** FTEQW, the engine: GPL-2.0, https://github.com/fte-team/fteqw. */
export const FTE_REPO = "https://github.com/fte-team/fteqw";
export const FTE_COMMIT = "f937b9d88f71fc4429db5fe56c6a98d922711b2e";
/** FTE's build config (engine/common/config_<name>.h). */
export const FTE_CONFIG = "fteqw";
/**
 * emscripten 4.0.15, by digest. The image is published per architecture: the same compiler, built for each. CI runs
 * the amd64 one; a Mac with Apple silicon the arm64 one.
 */
export const EMSDK = {
  x64: "emscripten/emsdk@sha256:27bc6267cb285223b8aebb7627bfebae7cb3ad2aaa0d5923b8aa5321793033e8",
  arm64: "emscripten/emsdk@sha256:d4216eed0500d24261bbdbe91be922ca9518c8ff262f7e7d3a6f8729729a7713",
};
/** zlib, which FTE's Makefile would otherwise fetch with wget: fetched here once and checked. */
export const ZLIB = {
  url: "https://zlib.net/fossils/zlib-1.3.1.tar.gz",
  file: "zlib-1.3.1.tar.gz",
  sha256: "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23",
};
export const OUTPUTS = [
  ["ftewebgl.js", "fte.js"],
  ["ftewebgl.wasm", "fte.wasm"],
];

const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

async function fetchChecked({ url, file, sha256: want }, dir) {
  const path = join(dir, file);
  if (!existsSync(path)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const got = sha256(readFileSync(path));
  if (got !== want) throw new Error(`${file} has SHA-256 ${got}, expected ${want}`);
}

async function main() {
  const check = process.argv.includes("--check");
  // ENGINE_ARCH=x64 on an arm64 Mac runs CI's image under emulation, to check both give the same bytes.
  const image = EMSDK[process.env.ENGINE_ARCH ?? arch()] ?? EMSDK.x64;
  const build = join(root, "engine/.build");
  const src = join(build, "fteqw");
  rmSync(src, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  run("git", ["init", "-q"], src);
  run("git", ["fetch", "-q", "--depth", "1", FTE_REPO, FTE_COMMIT], src);
  run("git", ["-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"], src);
  const patches = readdirSync(join(root, "engine/patches")).filter((f) => f.endsWith(".patch")).sort();
  for (const patch of patches) run("git", ["apply", join(root, "engine/patches", patch)], src);
  await fetchChecked(ZLIB, join(src, "engine"));
  run("docker", ["run", "--rm", "-v", `${src}:/src`, "-w", "/src/engine", image, "make", "-j8", "web-rel", `FTE_CONFIG=${FTE_CONFIG}`], root);

  const out = check ? join(build, "dist") : join(root, "engine/dist");
  mkdirSync(out, { recursive: true });
  const sums = [];
  for (const [from, to] of OUTPUTS) {
    copyFileSync(join(src, "engine/release", from), join(out, to));
    sums.push(`${sha256(readFileSync(join(out, to)))}  ${to}`);
  }
  // The bundle carries the wasm gzipped (src/engine.ts inflates it), by fflate: the same bytes on every machine.
  writeFileSync(join(out, "fte.wasm.gz"), gzipSync(readFileSync(join(out, "fte.wasm")), { level: 9, mem: 12, mtime: 0 }));
  sums.push(`${sha256(readFileSync(join(out, "fte.wasm.gz")))}  fte.wasm.gz`);
  writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
  console.log(`FTEQW ${FTE_COMMIT.slice(0, 9)} (${FTE_CONFIG}, ${patches.length} patches) in ${image}:\n${sums.join("\n")}`);
  if (check) {
    const committed = readFileSync(join(root, "engine/dist/SHA256SUMS"), "utf8");
    if (committed !== `${sums.join("\n")}\n`) {
      console.error(`differs from engine/dist/SHA256SUMS:\n${committed}`);
      process.exit(1);
    }
    console.log("the same bytes as engine/dist/");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

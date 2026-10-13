// The built app: a page that loads nothing by URL and carries the notices of what it holds, with the engine and the
// game data beside it, all under the 16 MiB a bundle may hold.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GAME_FILES } from "../scripts/assets.mjs";
import { engineScript } from "../vite.config.ts";

const root = join(import.meta.dirname, "..");
let out: string;
let page: string;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "arena-"));
  await build({ configFile: join(root, "vite.config.ts"), logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  page = readFileSync(join(out, "index.html"), "utf8");
}, 120_000);

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("the Arena page", () => {
  it("is one HTML file with its two scripts and its styles inline", () => {
    expect(readdirSync(out)).toEqual(["index.html"]);
    expect(page).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(page).not.toMatch(/<link\b/i);
    expect(page).not.toMatch(/<(?:iframe|object|embed|frame)\b/i);
    expect(page).not.toMatch(/type="module"/);
    expect(page.match(/<script\b/g)).toHaveLength(2);
    expect(page.match(/<style\b/g)).toHaveLength(1);
    // The engine's glue first: the app's script calls window.ghostlyFte.
    expect(page.indexOf("window.ghostlyFte = function (Module)")).toBeLessThan(page.lastIndexOf("<script>"));
  });

  it("carries the engine's GPL notice and source, LibreQuake's licence, and fflate's", () => {
    const notice = page.slice(page.indexOf("/*!"), page.indexOf("*/", page.indexOf("/*!")) + 2);
    expect(notice).toContain("GPL-2.0-only");
    expect(notice).toContain("https://github.com/MiguelMedeiros/ghostly-quake");
    expect(notice).toContain("FTEQW, https://github.com/fte-team/fteqw, commit f937b9d88f71fc4429db5fe56c6a98d922711b2e");
    expect(notice).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(notice).toContain("Version 2, June 1991");
    expect(notice).toContain("Contributors to the LibreQuake project");
    expect(notice).toContain("Neither the name of the LibreQuake project");
    expect(notice).toContain("fflate 0.8.2 (MIT)");
  });

  it("names no server to reach: the engine's only network is the chat pipe", () => {
    const start = page.indexOf("/*!");
    const code = page.slice(0, start) + page.slice(page.indexOf("*/", start) + 2);
    expect(code).toContain("ws://ghostly.invalid/");
    expect(code).not.toMatch(/\beval\s*\(\s*UTF8ToString/);
  });

  it("refuses a glue that would end its script early", () => {
    expect(() => engineScript("var a = '</script>';")).toThrow(/end its tag early/);
    expect(engineScript("var x = 1;")).toContain("FTEC.cbufadd(text)");
  });
});

describe("the bundle's files", () => {
  it("fit the 16 MiB a bundle may hold, with room for the manifest and the signature", () => {
    const total = statSync(join(out, "index.html")).size + statSync(join(root, "assets/icon.png")).size + GAME_FILES.reduce((n, [, source]) => n + statSync(join(root, source)).size, 0);
    expect(total).toBeLessThan(16 * 1024 * 1024 - 64 * 1024);
  });

  it("the icon is a square PNG of at most 256 KiB and 1024 pixels", () => {
    const icon = readFileSync(join(root, "assets/icon.png"));
    expect(icon.subarray(1, 4).toString()).toBe("PNG");
    expect(icon.length).toBeLessThanOrEqual(256 * 1024);
    const [w, h] = [icon.readUInt32BE(16), icon.readUInt32BE(20)];
    expect(w).toBe(h);
    expect(w).toBeLessThanOrEqual(1024);
  });

  it("the engine files are the ones engine/dist/SHA256SUMS names", async () => {
    const { createHash } = await import("node:crypto");
    const sums = readFileSync(join(root, "engine/dist/SHA256SUMS"), "utf8");
    for (const file of ["fte.js", "fte.wasm.gz"]) {
      const hash = createHash("sha256").update(readFileSync(join(root, "engine/dist", file))).digest("hex");
      expect(sums).toContain(`${hash}  ${file}`);
    }
  });
});

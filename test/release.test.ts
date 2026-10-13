// What a release is made from: the manifest as `ghostly app publish` takes it, and scripts/bundle.mjs, which says
// whether a signed bundle is this checkout's build and writes the store's listing for it (docs/PUBLISHING.md).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestOf, expected, listing, problems, readManifest, SOURCE } from "../scripts/bundle.mjs";

const root = join(import.meta.dirname, "..");
const source = JSON.parse(readFileSync(join(root, "ghostly-app.json"), "utf8")) as Record<string, unknown>;
const files = [
  { path: "game/arena.pk3", bytes: new Uint8Array([1, 2, 3]) },
  { path: "index.html", bytes: new TextEncoder().encode("<!doctype html><title>Arena</title>") },
];
const KEY = "o".repeat(52);

function bundle(manifest: Record<string, unknown>): Uint8Array {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(manifestBytes.length);
  return Buffer.concat([Buffer.from("GHOSTLYAPP1"), length, manifestBytes]);
}

describe("the manifest", () => {
  it("is what WISP 1200 asks of a writer", () => {
    expect(Object.keys(source).sort()).toEqual(
      ["name", "version", "kind", "title", "tagline", "description", "releaseNotes", "entry", "permissions", "view", "runtime", "license", "sources", "homepage", "support"].sort(),
    );
    expect(source.name).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    expect([...(source.title as string)].length).toBeLessThanOrEqual(40);
    expect([...(source.tagline as string)].length).toBeLessThanOrEqual(80);
    expect([...(source.description as string)].length).toBeLessThanOrEqual(2000);
    expect([...(source.releaseNotes as string)].length).toBeLessThanOrEqual(500);
    expect(source.permissions).toEqual(["chat", "name"]);
    expect(source.view).toBe("full");
    expect(source.sources).toEqual([SOURCE]);
    expect(source.license).toBe("GPL-2.0-only AND BSD-3-Clause");
  });

  it("names no trademark of id Software's but to say where the engine comes from (LibreQuake is the data's name)", () => {
    for (const key of ["name", "title", "tagline", "releaseNotes"]) expect(String(source[key]).replace(/LibreQuake/g, "")).not.toMatch(/quake/i);
    expect(source.description).toMatch(/descended from id Software's Quake engine/);
  });
});

describe("scripts/bundle.mjs", () => {
  const manifest = expected(source, files, 1, KEY);

  it("finds nothing wrong with this checkout's build", () => {
    expect(problems(manifest, source, files, KEY)).toEqual([]);
    expect(problems(manifest, source, files, null)).toEqual([]);
  });

  it("finds another key, another file, a changed field", () => {
    expect(problems(manifest, source, files, "z".repeat(52))[0]).toMatch(/another publisher key/);
    expect(problems(manifest, source, [files[0]!, { path: "index.html", bytes: new Uint8Array([9]) }], KEY)[0]).toMatch(/index.html .* is not this build's/);
    expect(problems({ ...manifest, title: "Other" }, source, files, KEY)[0]).toMatch(/title is "Other"/);
    expect(problems({ ...manifest, files: [] }, source, files, KEY)[0]).toMatch(/holds no file/);
  });

  it("reads a bundle's manifest and its digest", () => {
    const read = readManifest(bundle(manifest));
    expect(read.manifest).toEqual(manifest);
    expect(read.digest).toBe(createHash("sha256").update(JSON.stringify(manifest)).digest("base64url"));
    expect(digestOf(manifest)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("writes the store's listing pinned to a commit", () => {
    const entry = listing(manifest, "d".repeat(43), "a".repeat(40));
    expect(entry.urls).toEqual([`https://cdn.jsdelivr.net/gh/MiguelMedeiros/ghostly-quake@${"a".repeat(40)}/app.ghostlyapp`, SOURCE]);
    expect(entry.ref).toBe(`${KEY}/arena`);
    expect(() => listing(manifest, "d", "HEAD")).toThrow();
  });
});

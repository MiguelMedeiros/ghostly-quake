import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAPS } from "../scripts/data.mjs";
import { MAP_IDS } from "../src/protocol.ts";
import { MAP_NAMES } from "../src/ui.ts";
import { compatible } from "../src/version.ts";

const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

describe("versions", () => {
  it("the manifest, package.json and package-lock.json say the same version", () => {
    const version = json("ghostly-app.json").version;
    expect(json("package.json").version).toBe(version);
    expect(json("package-lock.json").version).toBe(version);
    expect(json("package-lock.json").packages[""].version).toBe(version);
  });

  it("two versions play together when only their patch differs", () => {
    expect(compatible("1.0.0", "1.0.0")).toBe(true);
    expect(compatible("1.0.0", "1.0.3")).toBe(true);
    expect(compatible("1.0.0", "1.1.0")).toBe(false);
    expect(compatible("1.0.0", "2.0.0")).toBe(false);
    expect(compatible("1.0.0", "dev")).toBe(false);
  });

  it("the app lists exactly the maps the data carries, by LibreQuake's names", () => {
    expect([...MAP_IDS]).toEqual(MAPS.map(([id]) => id));
    for (const [id, name] of MAPS) expect(MAP_NAMES[id as keyof typeof MAP_NAMES]).toBe(name);
  });
});

import { execFileSync } from "node:child_process";
import http from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { desktopPerson, type DesktopPerson } from "../matrix/people";
import { forgetSharedData, openMacDesktop, type MacDesktop, type MacDriver } from "../support/desktopMac";
import { LocalRelay } from "../support/relay";

/*
 * Arena (MiguelMedeiros/ghostly-agents#659) between two Ghostly Desktop apps on one Mac, in the system WKWebView, on a
 * debug build made with VITE_APPS_TEST=1 (its store fetcher reads the local server below). The staged bundle folder in
 * ARENA_RELEASE is signed by the headless CLI with throwaway keys and listed in a store signed the same way. Both
 * install it, pair, open it in their chat (an app-* window each), A hosts and B joins over `paired-app`.
 */
const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "packages/cli/dist/ghostly.mjs");
const REPO = "https://raw.githubusercontent.com/ghostly-e2e/arena/HEAD/";
const STORE_URL = "https://raw.githubusercontent.com/ghostly-e2e/store/HEAD/ghostly-store.json";
const PORTS = { relay: 49751, a: 49760, b: 49761 };

function ghostly(...args: string[]): Record<string, unknown> {
  return JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as Record<string, unknown>;
}

function publishArena(): Map<string, Uint8Array> {
  const release = process.env.ARENA_RELEASE;
  if (!release) throw new Error("ARENA_RELEASE names the staged Arena folder");
  const dir = mkdtempSync(join(tmpdir(), "ghostly-e2e-arena-"));
  cpSync(release, join(dir, "app"), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "app", "ghostly-app.json"), "utf8"));
  writeFileSync(join(dir, "app", "ghostly-app.json"), JSON.stringify({ ...manifest, sources: [REPO + "app.ghostlyapp"] }));
  const out = join(dir, "app.ghostlyapp");
  const made = ghostly("app", "publish", join(dir, "app"), "--key", join(dir, "publisher.key"), "--out", out, "--sequence", "1");
  const files = new Map<string, Uint8Array>([[REPO + "app.ghostlyapp", new Uint8Array(readFileSync(out))]]);
  mkdirSync(join(dir, "store"));
  writeFileSync(join(dir, "store", "index.json"), JSON.stringify({
    ghostlyStore: 1, name: "E2E store", description: "Apps for the end-to-end tests.", kind: "curated", sequence: 1,
    expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    apps: [{ ref: made.ref, sequence: 1, digest: made.digest, urls: [REPO + "app.ghostlyapp"], title: manifest.title, tagline: manifest.tagline, category: "games" }],
    removed: [], revoked: [],
  }));
  ghostly("store", "sign", join(dir, "store", "index.json"), "--key", join(dir, "store.key"), "--out", join(dir, "store", "signed"));
  files.set(STORE_URL, new Uint8Array(readFileSync(join(dir, "store", "signed", "ghostly-store.json"))));
  files.set(new URL("ghostly-store.sig", STORE_URL).href, new Uint8Array(readFileSync(join(dir, "store", "signed", "ghostly-store.sig"))));
  return files;
}

async function storeServer(files: Map<string, Uint8Array>): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const body = files.get(`https:/${request.url ?? ""}`);
    response.writeHead(body ? 200 : 404, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" });
    response.end(body ? Buffer.from(body) : "404: Not Found");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) };
}

/** Clicks the button whose text is `label` in this window. */
const press = (w: MacDriver, label: string) => expect(async () => {
  await w.execute(`const b = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === arguments[0]); if (!b) throw new Error("no " + arguments[0]); b.click();`, label);
}).toPass({ timeout: 60_000 });

/** A key held for `ms` in the app's window, as the engine reads it (it listens on the window). */
const hold = (w: MacDriver, key: string, code: number, ms: number) => w.executeAsync(`
  const [key, code, ms, done] = arguments;
  const ev = (type) => new KeyboardEvent(type, { key, keyCode: code, which: code, bubbles: true });
  window.dispatchEvent(ev("keydown"));
  const canvas = document.getElementById("canvas");
  canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
  setTimeout(() => { window.dispatchEvent(ev("keyup")); canvas.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true })); done(true); }, ms);`, key, code, ms);

test("two Desktop apps install Arena and play a deathmatch in their chat", async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "macOS only");
  test.setTimeout(10 * 60_000);
  const files = publishArena();
  const server = await storeServer(files);
  const relay = new LocalRelay();
  const env = { GHOSTLY_PKARR_RELAYS: await relay.listen(PORTS.relay) };
  const apps: MacDesktop[] = [];
  forgetSharedData();
  const open = (name: "a" | "b") => async () => {
    const desktop = await openMacDesktop({ name, port: PORTS[name], env });
    apps.push(desktop);
    return { app: desktop.app, stop: () => desktop.stop() };
  };
  try {
    const [alice, bob] = await Promise.all([desktopPerson("a", { env, open: open("a") }), desktopPerson("b", { env, open: open("b") })]);
    await alice.press("New chat");
    const invite = await alice.copyInvite();
    await bob.join(invite);
    for (const p of [alice, bob]) {
      await expect.poll(() => p.canWrite(), { timeout: 120_000 }).toBe(true);
      p.chatHash = await p.hash();
    }

    // Each installs Arena from the store, then opens it in the chat: an app-* window of its own.
    const windows: Record<string, MacDriver> = {};
    for (const p of [alice, bob] as DesktopPerson[]) {
      const app = p.app as MacDriver;
      await app.execute("window.__ghostlyAppsStore = arguments[0]", server.base);
      await app.click('[data-testid="account-apps"]');
      await app.click('[data-testid="apps-add"]');
      await app.type('[data-testid="apps-add-url"]', STORE_URL);
      await app.click('[data-testid="apps-add-check"]');
      await expect.poll(() => app.text('[data-testid="apps-add-store"]'), { timeout: 60_000 }).toContain("E2E store");
      await app.click('[data-testid="apps-add-store-confirm"]');
      await expect.poll(() => app.text('[data-testid="app-listing-install"]'), { timeout: 60_000 }).not.toBeNull();
      await app.click('[data-testid="app-listing-install"]');
      await expect.poll(() => app.text('[data-testid="app-install"]'), { timeout: 60_000 }).toContain("Arena");
      await app.click('[data-testid="app-install-confirm"]');
      await expect.poll(() => app.text('[data-testid="installed-app"]'), { timeout: 120_000 }).toContain("Arena");
      await p.go(p.chatHash!);
      await expect.poll(() => p.canWrite(), { timeout: 60_000 }).toBe(true);
      const before = await app.windows();
      await app.click('[data-testid="composer-more"]');
      await app.click('[data-testid="composer-apps"]');
      await app.click('[data-testid="chat-app-open"]');
      let label: string | undefined;
      await expect.poll(async () => (label = (await app.windows()).find((w) => w.startsWith("app-") && !before.includes(w))), { timeout: 60_000 }).toBeDefined();
      windows[p.name] = app.in(label!);
      await expect.poll(() => windows[p.name]!.execute<string>("return document.querySelector('h1')?.textContent ?? ''").catch(() => ""), { timeout: 60_000 }).toBe("Arena");
      await windows[p.name]!.execute("window.__lines = []; const log = console.log.bind(console); console.log = (...a) => { window.__lines.push(a.join(' ')); log(...a); };");
    }
    const a = windows.a!, b = windows.b!;
    const lines = (w: MacDriver) => w.execute<string[]>("return window.__lines");
    await expect.poll(() => a.execute<string>("return document.body.textContent"), { timeout: 60_000 }).toContain("Your contact has Arena open");

    await press(a, "Host a match");
    await expect.poll(() => b.execute<string>("return document.body.textContent"), { timeout: 60_000 }).toContain("Your contact hosts Solstice");
    await press(b, "Join");
    await expect.poll(async () => (await lines(a)).some((l) => /Bob|Player joined the server|joined the server/.test(l) && !/^Ana/.test(l)), { timeout: 120_000 }).toBe(true);
    await expect.poll(async () => (await lines(b)).some((l) => /Connected to ws:\/\/ghostly\.invalid\/host/.test(l)), { timeout: 60_000 }).toBe(true);

    const stats: string[] = [];
    for (let i = 0; i < 12; i++) {
      await Promise.all([hold(a, i % 2 ? "d" : "a", i % 2 ? 68 : 65, 800), hold(b, "w", 87, 800)]);
      if (i % 3 === 2) stats.push(`${await a.text(".bar .stats")} | ${await b.text(".bar .stats")}`);
    }
    const report = { stats, a: (await lines(a)).filter((l) => !/GL Driver/.test(l)).slice(-40), b: (await lines(b)).filter((l) => !/GL Driver/.test(l)).slice(-40), pids: apps.map((x) => x.pid) };
    writeFileSync(testInfo.outputPath("arena-desktop.json"), JSON.stringify(report, null, 1));
    if (process.env.ARENA_SHOTS) writeFileSync(join(process.env.ARENA_SHOTS, "desktop-report.json"), JSON.stringify(report, null, 1));
    console.log("ARENA DESKTOP STATS", JSON.stringify(stats));
    // Time for a screenshot of each window, when the runner asks for one.
    if (process.env.ARENA_PAUSE) await new Promise((r) => setTimeout(r, Number(process.env.ARENA_PAUSE)));
    expect(await a.text(".bar .label")).toBe("Playing Solstice");
    expect(await b.text(".bar .label")).toBe("Playing Solstice");
  } finally {
    await Promise.all(apps.map((x) => x.stop()));
    await server.close();
    await relay.close?.();
  }
});

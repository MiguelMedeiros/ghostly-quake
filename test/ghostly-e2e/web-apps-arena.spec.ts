import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserContext, FrameLocator, Page } from "@playwright/test";
import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { serveStore } from "../support/appStore";
import { miniApp, openPeers } from "../support/chessApp";

/*
 * Arena (MiguelMedeiros/ghostly-agents#659) end to end on the e2e build: the staged bundle folder in ARENA_RELEASE
 * (ghostly-quake's `npm run stage`), signed here by the headless CLI with throwaway keys, listed in a store signed the
 * same way, served at raw.githubusercontent.com URLs by the test. Ana installs it, opens it in her chat with Bob and
 * hosts a match; Bob installs it from her card and joins; both engines play on Ana's server over `paired-app`.
 */
const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "packages/cli/dist/ghostly.mjs");
const REPO = "https://raw.githubusercontent.com/ghostly-e2e/arena/HEAD/";
const STORE_URL = "https://raw.githubusercontent.com/ghostly-e2e/store/HEAD/ghostly-store.json";
const SHOTS = process.env.ARENA_SHOTS ?? "";

function ghostly(...args: string[]): Record<string, unknown> {
  return JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as Record<string, unknown>;
}

function publishArena(): { files: Map<string, Uint8Array> } {
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
  return { files };
}

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

const arena = (page: Page): FrameLocator => miniApp(page).frameLocator("iframe");

/** What the page (and so the app's frame, and its engine) printed. */
function capture(page: Page): string[] {
  const lines: string[] = [];
  page.on("console", (m) => lines.push(m.text()));
  return lines;
}

async function waitForLine(lines: string[], pattern: RegExp, timeout = 90_000): Promise<void> {
  await expect.poll(() => lines.some((l) => pattern.test(l)), { timeout }).toBe(true);
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test("two people install Arena and play a deathmatch in their chat", async ({ peer, browserName }) => {
  test.setTimeout(8 * 60_000);
  const store = publishArena();
  const [ana, bob] = await openPeers(peer, browserName, "ana", "bob");
  for (const p of [ana, bob]) await p.page.setViewportSize({ width: 1280, height: 800 });
  await Promise.all([serveStore(ana.context, store), serveStore(bob.context, store)]);
  const anaLines = capture(ana.page);
  const bobLines = capture(bob.page);
  await setNickname(ana, "Ana");
  await setNickname(bob, "Bob");

  // Ana installs Arena from the store and opens it in her chat with Bob.
  await ana.page.goto("/#/apps");
  await ana.page.getByTestId("apps-add").click();
  await ana.page.getByTestId("apps-add-url").fill(STORE_URL);
  await ana.page.getByTestId("apps-add-check").click();
  await ana.page.getByTestId("apps-add-store-confirm").click();
  await ana.page.getByTestId("app-store").filter({ hasText: "E2E store" }).getByTestId("app-listing-install").click();
  await shot(ana.page, "01-ana-install");
  await ana.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
  await expect(ana.page.getByTestId("installed-app")).toContainText("Arena");
  await ana.page.goto("/#/");
  await pair(ana, bob);
  await (await composerRow(ana.page, "composer-apps")).click();
  await ana.page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
  await expect(miniApp(ana.page)).toBeVisible();
  await expect(arena(ana.page).getByText("Waiting for your contact to open Arena")).toBeVisible({ timeout: 60_000 });

  // Bob installs it from Ana's card and opens it.
  const card = chat(bob).getByTestId("app-card");
  await expect(card).toContainText("Arena");
  await card.getByTestId("app-card-install").click();
  await shot(bob.page, "02-bob-install");
  await bob.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
  await expect(miniApp(bob.page)).toBeVisible();
  await expect(arena(ana.page).getByText("Your contact has Arena open")).toBeVisible({ timeout: 60_000 });
  await shot(ana.page, "03-ana-lobby");

  // Ana hosts Solstice; Bob joins from the invitation.
  await arena(ana.page).getByRole("button", { name: "Host a match" }).click();
  await expect(arena(bob.page).getByText(/Your contact hosts Solstice/)).toBeVisible({ timeout: 60_000 });
  await shot(bob.page, "04-bob-invitation");
  await arena(bob.page).getByRole("button", { name: "Join" }).click();
  await waitForLine(anaLines, /Bob joined the server/, 120_000);
  await waitForLine(bobLines, /Connected to ws:\/\/ghostly\.invalid\/host/, 30_000);

  // Both play for a while: each moves and fires, then each looks at the other's numbers.
  const frameOf = (p: Peer) => miniApp(p.page).locator("iframe");
  for (const p of [ana, bob]) await frameOf(p).click({ position: { x: 640, y: 400 } });
  const stats: string[] = [];
  for (let i = 0; i < 20; i++) {
    for (const p of [ana, bob]) {
      await p.page.keyboard.down(i % 2 ? "d" : "a");
      await p.page.mouse.down();
    }
    await ana.page.waitForTimeout(700);
    for (const p of [ana, bob]) {
      await p.page.keyboard.up(i % 2 ? "d" : "a");
      await p.page.mouse.up();
    }
    if (i % 5 === 4) stats.push(`${await arena(ana.page).locator(".bar .stats").textContent()} | ${await arena(bob.page).locator(".bar .stats").textContent()}`);
    if (i === 10) {
      await shot(ana.page, "05-ana-playing");
      await shot(bob.page, "06-bob-playing");
    }
  }
  for (const p of [ana, bob]) await p.page.keyboard.down("Tab");
  await shot(ana.page, "07-ana-scores");
  await shot(bob.page, "08-bob-scores");
  for (const p of [ana, bob]) await p.page.keyboard.up("Tab");
  console.log("ARENA STATS", JSON.stringify(stats));
  if (SHOTS) writeFileSync(join(SHOTS, "console-ana.txt"), anaLines.join("\n")), writeFileSync(join(SHOTS, "console-bob.txt"), bobLines.join("\n"));
  await expect(arena(ana.page).locator(".bar .label")).toHaveText("Playing Solstice");
  await expect(arena(bob.page).locator(".bar .label")).toHaveText("Playing Solstice");
  void (null as unknown as BrowserContext);
});

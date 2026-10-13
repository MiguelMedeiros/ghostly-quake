/**
 * Two sides of one chat play a deathmatch in real browsers, each in a sandboxed frame under the runner's CSP: Ana hosts,
 * Bob joins, both engines meet over the chat's frames within the chat's limits, and either can leave.
 */
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openSide, type Side, waitForLine } from "./harness.ts";

type Counters = { sent: number; refused: number; maxBytes: number; received: number };
const counters = (s: Side) => s.frame.evaluate(() => (window as unknown as { __broker: Counters }).__broker);
const violations = (s: Side) => s.frame.evaluate(() => (window as unknown as { __violations: string[] }).__violations);

async function startMatch(browser: import("@playwright/test").Browser, latency = 20): Promise<[Side, Side]> {
  const sides = new Map<string, Side>();
  const relay = { latency };
  const ana = await openSide(browser, { name: "ana", sides, relay, displayName: "Ana" });
  const bob = await openSide(browser, { name: "bob", sides, relay, displayName: "Bob" });
  await expect(ana.frame.getByText("Your contact has Arena open")).toBeVisible({ timeout: 30_000 });
  await ana.frame.getByRole("button", { name: "Host a match" }).click();
  await expect(bob.frame.getByText(/Your contact hosts Solstice: first to 10 frags, 10 minutes/)).toBeVisible({ timeout: 60_000 });
  await bob.frame.getByRole("button", { name: "Join" }).click();
  await waitForLine(bob, /Connected to ws:\/\/ghostly\.invalid\/host/, 90_000);
  await waitForLine(ana, /Bob joined the server/, 30_000);
  return [ana, bob];
}

test("Ana hosts, Bob joins, and both play on Ana's server over the chat, within its limits", async ({ browser }, testInfo) => {
  const [ana, bob] = await startMatch(browser);
  for (const side of [ana, bob]) await expect(side.frame.locator(".bar .label")).toHaveText("Playing Solstice");

  // Both play for a while: they move and fire.
  for (const side of [ana, bob]) await side.page.mouse.click(400, 250);
  const samples: string[] = [];
  for (let i = 0; i < 8; i++) {
    for (const side of [ana, bob]) {
      await side.page.keyboard.down(i % 2 ? "d" : "w");
      await side.page.mouse.down();
    }
    await ana.page.waitForTimeout(800);
    for (const side of [ana, bob]) {
      await side.page.keyboard.up(i % 2 ? "d" : "w");
      await side.page.mouse.up();
    }
    samples.push((await Promise.all([ana, bob].map((s) => s.frame.locator(".bar .stats").textContent()))).join(" | "));
  }
  await ana.page.screenshot({ path: testInfo.outputPath("ana.png") });
  await bob.page.screenshot({ path: testInfo.outputPath("bob.png") });

  const [a, b] = await Promise.all([counters(ana), counters(bob)]);
  writeFileSync(testInfo.outputPath("link.json"), JSON.stringify({ ana: a, bob: b, samples }, null, 1));
  // Packets flowed both ways, no frame passed the chat's bounds, and the broker refused none.
  expect(a.sent).toBeGreaterThan(50);
  expect(b.sent).toBeGreaterThan(50);
  expect(a.refused + b.refused).toBe(0);
  expect(Math.max(a.maxBytes, b.maxBytes)).toBeLessThanOrEqual(32 * 1024);
  // The page's numbers: a round trip and frames a second.
  expect(samples.at(-1)).toMatch(/^\d+ ms · \d+ fps · [\d.]+ KB\/s \| \d+ ms · \d+ fps · [\d.]+ KB\/s$/);
  // Nothing the runner forbids was tried: no network, no eval.
  expect([...(await violations(ana)), ...(await violations(bob))]).toEqual([]);
});

test("when Bob leaves, Ana's server waits and Bob can join again; when Ana leaves, Bob's match ends", async ({ browser }) => {
  const [ana, bob] = await startMatch(browser);
  await bob.frame.getByRole("button", { name: "Leave" }).click();
  await expect(bob.frame.getByText("You left the match.")).toBeVisible();
  await expect(ana.frame.locator(".bar .label")).toHaveText("Waiting for your contact to join. Look around meanwhile.");
  await expect(bob.frame.getByText(/Your contact hosts Solstice/)).toBeVisible({ timeout: 30_000 });
  await bob.frame.getByRole("button", { name: "Join" }).click();
  await expect(ana.frame.locator(".bar .label")).toHaveText("Playing Solstice", { timeout: 60_000 });
  await ana.frame.getByRole("button", { name: "Leave" }).click();
  await expect(bob.frame.getByText("Your contact left the match.")).toBeVisible({ timeout: 30_000 });
  await expect(ana.frame.getByText("You left the match.")).toBeVisible();
});

test("alone, the lobby offers only walking a map, and the page cannot lock the pointer", async ({ browser }) => {
  const sides = new Map<string, Side>();
  const solo = await openSide(browser, { name: "solo", sides, inChat: false, locale: "pt-BR" });
  await expect(solo.frame.getByText("Abra a Arena numa conversa para jogar com um contato.", { exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(solo.frame.getByRole("button", { name: "Hospedar partida" })).toHaveCount(0);
  await solo.frame.getByRole("button", { name: "Andar pelo mapa" }).click();
  await waitForLine(solo, /Server spawned/, 60_000);
  await expect(solo.frame.locator(".bar .label")).toHaveText("Solstice");
  const locked = await solo.frame.evaluate(async () => {
    try {
      await document.body.requestPointerLock();
      return "locked";
    } catch {
      return "refused";
    }
  });
  expect(locked).toBe("refused");
  await solo.frame.getByRole("button", { name: "Sair" }).click();
  await expect(solo.frame.getByRole("button", { name: "Andar pelo mapa" })).toBeVisible();
  expect(await violations(solo)).toEqual([]);
});

/**
 * The built Arena (dist/) in real browsers, for the Playwright specs.
 *
 * Each side is a page that holds the app in `<iframe sandbox="allow-scripts">` with a CSP like the web runner's, so
 * what the runner forbids (eval, fetch, workers, pointer lock) fails here too, and every CSP violation is recorded.
 * A test broker is injected as `window.ghostly` in the frame before the app's script runs. Its `file` asks the host
 * page, which reads the bundle's files from dist/ (the frame itself can fetch nothing). Chat frames between the two
 * sides go through Node (exposeBinding), so a test can delay them and count them, and the broker enforces the chat's
 * limits: 32 KiB a frame, 48 frames a second, 50 requests a second.
 *
 * Nothing leaves the machine: every URL is answered by page.route.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, ConsoleMessage, Frame, Page } from "@playwright/test";

export const ORIGIN = "http://arena.test";
const dist = join(import.meta.dirname, "../../dist");

/** The web runner's CSP (WISP 1200), as far as a <meta> can carry it (no sandbox, no frame-ancestors). */
export const RUNNER_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

export function builtPage(): string {
  return readFileSync(join(dist, "index.html"), "utf8");
}

function framedHost(html: string, size: { width: number; height: number }): string {
  const inner = html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${RUNNER_CSP}" />`);
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#222}iframe{border:0;width:${size.width}px;height:${size.height}px;display:block}</style></head>
<body><iframe sandbox="allow-scripts" title="Arena"></iframe><script>
const frame = document.querySelector("iframe");
frame.srcdoc = ${JSON.stringify(inner).replace(/<\//g, "<\\/")};
addEventListener("message", async (event) => {
  if (event.source !== frame.contentWindow || !event.data || event.data.type !== "file") return;
  const response = await fetch("/dist/" + event.data.path);
  if (!response.ok) { frame.contentWindow.postMessage({ type: "file", id: event.data.id, error: "no-file" }, "*"); return; }
  const bytes = await response.arrayBuffer();
  frame.contentWindow.postMessage({ type: "file", id: event.data.id, bytes }, "*", [bytes]);
});
</script></body></html>`;
}

interface BrokerOptions {
  version: string;
  inChat: boolean;
  locale: string;
  displayName?: string;
}

/** Runs in the frame before the app: the test broker. */
function installBroker(options: BrokerOptions): void {
  const w = window as unknown as Record<string, unknown> & Window;
  w.__violations = [] as string[];
  document.addEventListener("securitypolicyviolation", (e) => (w.__violations as string[]).push(`${e.violatedDirective} ${e.blockedURI}`));
  if (window === window.top) return;
  const store = new Map<string, string>();
  const listeners = { message: new Set<(d: unknown) => void>(), peer: new Set<(d: unknown) => void>() };
  let peer: { version: string } | null = null;
  const files = new Map<number, (r: { bytes?: ArrayBuffer; error?: string }) => void>();
  let fileId = 0;
  addEventListener("message", (event) => {
    const d = event.data as { type?: string; id: number; bytes?: ArrayBuffer; error?: string };
    if (event.source === window.parent && d?.type === "file") files.get(d.id)?.(d), files.delete(d.id);
  });
  // The broker's limits: 50 requests a second for the app, of which at most 48 chat.send frames.
  const requests: number[] = [];
  const sends: number[] = [];
  const within = (list: number[], max: number) => {
    const now = performance.now();
    while (list.length && now - list[0]! > 1000) list.shift();
    if (list.length >= max) return false;
    list.push(now);
    return true;
  };
  const request = () => {
    if (!within(requests, 50)) throw new Error("too-fast");
  };
  const counters = { sent: 0, refused: 0, maxBytes: 0, received: 0 };
  w.__broker = counters;
  const call = (name: string, ...args: unknown[]) => (w[name] as (...a: unknown[]) => Promise<unknown>)(...args);
  w.__deliver = (data: unknown) => {
    counters.received++;
    listeners.message.forEach((l) => l(data));
  };
  w.__peerEvent = (event: { open: boolean; version?: string }) => {
    peer = event.open ? { version: event.version ?? "" } : null;
    listeners.peer.forEach((l) => l(event));
  };
  w.ghostly = {
    context: async () => {
      request();
      return { version: options.version, inChat: options.inChat, peer, theme: "dark", locale: options.locale, ...(options.displayName === undefined ? {} : { name: options.displayName }) };
    },
    file: (path: string) => {
      request();
      return new Promise((resolve, reject) => {
        const id = ++fileId;
        files.set(id, (r) => (r.bytes ? resolve(r.bytes) : reject(new Error(r.error ?? "failed"))));
        window.parent.postMessage({ type: "file", id, path }, "*");
      });
    },
    storage: {
      get: async (key: string) => (request(), store.has(key) ? JSON.parse(store.get(key)!) : undefined),
      set: async (key: string, value: unknown) => void (request(), store.set(key, JSON.stringify(value))),
      delete: async (key: string) => void (request(), store.delete(key)),
      keys: async () => (request(), [...store.keys()]),
    },
    chat: {
      send: async (value: unknown) => {
        request();
        const json = JSON.stringify(value);
        if (json.length > 32 * 1024) throw new Error("too-large");
        if (!within(sends, 48)) {
          counters.refused++;
          throw new Error("too-fast");
        }
        if (!peer) throw new Error("peer-closed");
        counters.sent++;
        counters.maxBytes = Math.max(counters.maxBytes, json.length);
        const ok = await call("__arenaSend", JSON.parse(json));
        if (!ok) throw new Error("peer-closed");
      },
      on: (event: "message" | "peer", listener: (d: unknown) => void) => {
        listeners[event].add(listener);
        return () => listeners[event].delete(listener);
      },
    },
    close: async () => {},
  };
  void call("__arenaHello");
}

export interface Side {
  name: string;
  version: string;
  page: Page;
  context: BrowserContext;
  /** The frame Arena runs in, once its broker said hello. */
  frame: Frame;
  /** What the engine and the app printed. */
  console: string[];
}

export interface Relay {
  /** Milliseconds each frame waits before it is handed over (each way). */
  latency: number;
}

export async function openSide(
  browser: Browser,
  options: { name: string; sides: Map<string, Side>; relay?: Relay; inChat?: boolean; version?: string; displayName?: string; locale?: string; size?: { width: number; height: number } },
): Promise<Side> {
  const { name, sides, inChat = true, version = "1.0.0" } = options;
  const relay = options.relay ?? { latency: 0 };
  const size = options.size ?? { width: 800, height: 500 };
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  const page = await context.newPage();
  const html = builtPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/dist/game/")) return route.fulfill({ body: readFileSync(join(dist, path.slice("/dist/".length))) });
    return route.fulfill({ contentType: "text/html", body: framedHost(html, size) });
  });
  let resolveFrame!: (frame: Frame) => void;
  const ready = new Promise<Frame>((resolve) => (resolveFrame = resolve));
  const side = { name, version, page, context, console: [] as string[] } as Side;
  page.on("console", (message: ConsoleMessage) => side.console.push(message.text()));
  await page.exposeBinding("__arenaHello", async ({ frame }) => {
    side.frame = frame;
    const other = [...sides.values()].find((s) => s !== side && s.frame);
    if (other) {
      await frame.evaluate((v) => (window as unknown as { __peerEvent: (e: unknown) => void }).__peerEvent({ open: true, version: v }), other.version);
      await other.frame.evaluate((v) => (window as unknown as { __peerEvent: (e: unknown) => void }).__peerEvent({ open: true, version: v }), version);
    }
    resolveFrame(frame);
  });
  await page.exposeBinding("__arenaSend", async (_source, data: unknown) => {
    const other = [...sides.values()].find((s) => s !== side && s.frame);
    if (!other) return false;
    const deliver = () => void other.frame.evaluate((d) => (window as unknown as { __deliver: (d: unknown) => void }).__deliver(d), data).catch(() => {});
    if (relay.latency > 0) setTimeout(deliver, relay.latency);
    else deliver();
    return true;
  });
  await page.addInitScript(installBroker, { version, inChat, locale: options.locale ?? "en", displayName: options.displayName } satisfies BrokerOptions);
  sides.set(name, side);
  await page.goto(`${ORIGIN}/index.html`);
  side.frame = await ready;
  return side;
}

/** Waits until a line the side printed matches. */
export async function waitForLine(side: Side, pattern: RegExp, timeout = 30_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const line = side.console.find((l) => pattern.test(l));
    if (line) return line;
    if (Date.now() - start > timeout) throw new Error(`${side.name} never printed ${pattern}; last lines:\n${side.console.slice(-30).join("\n")}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

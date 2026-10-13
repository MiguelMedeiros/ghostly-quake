import { describe, expect, it, vi } from "vitest";
import { type EngineSocket, Link, type LinkClock } from "../src/link.ts";
import { type Frame, readFrame } from "../src/protocol.ts";
import type { MiniAppJson } from "../src/vendor/miniApp.ts";

const match = "AbCdEfGhIjKlMn_-";

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; every?: number }[] = [];
  const clock: LinkClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => timers.splice(timers.indexOf(t as never), 1),
    setInterval: (fn, ms) => {
      const t = { at: now + ms, fn, every: ms };
      timers.push(t);
      return t;
    },
    clearInterval: (t) => timers.splice(timers.indexOf(t as never), 1),
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      now = next.at;
      if (next.every) next.at += next.every;
      else timers.shift();
      next.fn();
      await Promise.resolve();
    }
    now = end;
  };
  return { clock, advance };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const socket = (): EngineSocket => ({ inq: [], err: 0, con: 1 });
const packet = (n: number, size = 40) => new Uint8Array(size).fill(n);

describe("Link", () => {
  it("sends the packets of one engine frame together, in one chat frame", async () => {
    const sent: Frame[] = [];
    const link = new Link({ send: async (f) => void sent.push(f) });
    link.start(match);
    link.send(packet(1));
    link.send(packet(2));
    link.send(packet(3));
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: "net", match });
    expect((sent[0] as Frame & { t: "net" }).p).toHaveLength(3);
    link.stop();
  });

  it("keeps under its rate, and sends what waited when a token comes back", async () => {
    const { clock, advance } = fakeClock();
    const sent: Frame[] = [];
    const link = new Link({ send: async (f) => void sent.push(f), clock, rate: 10, burst: 2, pingEvery: 1e9 });
    link.start(match);
    for (let i = 0; i < 5; i++) {
      link.send(packet(i));
      await tick();
    }
    expect(sent).toHaveLength(2);
    await advance(100);
    await tick();
    expect(sent).toHaveLength(3);
    // The packets that waited went together.
    expect((sent[2] as Frame & { t: "net" }).p).toHaveLength(3);
    await advance(1000);
    expect(sent).toHaveLength(3);
    link.stop();
  });

  it("never sends more than 48 frames in any second, whatever the engine does", async () => {
    const { clock, advance } = fakeClock();
    const times: number[] = [];
    const link = new Link({ send: async () => void times.push(clock.now()), clock });
    link.start(match);
    for (let ms = 0; ms < 5000; ms += 5) {
      link.send(packet(ms & 0xff));
      await tick();
      await advance(5);
    }
    for (const t of times) expect(times.filter((u) => u > t - 1000 && u <= t).length).toBeLessThanOrEqual(48);
    expect(times.length).toBeGreaterThan(150);
    link.stop();
  });

  it("drops the oldest packets when the queue is full", async () => {
    const { clock } = fakeClock();
    const sent: Frame[] = [];
    const link = new Link({ send: async (f) => void sent.push(f), clock, rate: 1, burst: 1, queuePackets: 4, pingEvery: 1e9 });
    link.start(match);
    link.send(packet(0));
    await tick();
    for (let i = 1; i <= 10; i++) link.send(packet(i));
    await tick();
    expect(link.stats.dropped).toBe(6);
    link.stop();
  });

  it("hands the peer's packets to the engine's socket, for its match only", () => {
    const link = new Link({ send: async () => {} });
    const s = socket();
    link.open(s);
    link.start(match);
    const p = readFrame({ t: "net", v: 1, match, p: ["AQID", "BA=="] })!;
    link.receive(p);
    link.receive(readFrame({ t: "net", v: 1, match: "ZZZZZZZZZZZZZZZZ", p: ["AQID"] })!);
    expect(s.inq).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([4])]);
    link.close(s);
    link.receive(p);
    expect(s.inq).toHaveLength(2);
    link.stop();
  });

  it("carries a packet larger than a frame in parts", async () => {
    const frames: Frame[] = [];
    const a = new Link({ send: async (f) => void frames.push(f), frameBytes: 1000, burst: 10 });
    const b = new Link({ send: async () => {} });
    const s = socket();
    b.open(s);
    a.start(match);
    b.start(match);
    const big = new Uint8Array(5000).map((_, i) => i & 0xff);
    a.send(big);
    await tick();
    expect(frames.length).toBeGreaterThan(5);
    for (const f of frames) expect(JSON.stringify(f).length).toBeLessThanOrEqual(1000);
    for (const f of frames) b.receive(readFrame(JSON.parse(JSON.stringify(f)) as MiniAppJson)!);
    expect(s.inq).toEqual([big]);
    a.stop();
    b.stop();
  });

  it("measures the round trip with its own pings", async () => {
    const { clock, advance } = fakeClock();
    const toB: Frame[] = [];
    const toA: Frame[] = [];
    const a = new Link({ send: async (f) => void toB.push(f), clock, pingEvery: 1000 });
    const b = new Link({ send: async (f) => void toA.push(f), clock });
    a.start(match);
    await advance(1000);
    expect(toB[0]).toMatchObject({ t: "ping" });
    await advance(30);
    b.receive(toB[0]!);
    await tick();
    await advance(30);
    a.receive(toA[0]!);
    expect(a.stats.rtt).toBe(60);
    expect(a.stats.srtt).toBe(60);
    a.stop();
  });

  it("counts a refused frame's packets as dropped", async () => {
    const link = new Link({ send: () => Promise.reject(new Error("offline")) });
    link.start(match);
    link.send(packet(1));
    link.send(packet(2));
    await vi.waitFor(() => expect(link.stats.dropped).toBe(2));
    expect(link.stats.lastError).toBe("offline");
    link.stop();
  });
});

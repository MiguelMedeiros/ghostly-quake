import { describe, expect, it } from "vitest";
import type { MatchTerms } from "../src/protocol.ts";
import { type EndReason, Session, type SessionEvents } from "../src/session.ts";
import { chatPair, type MockBroker } from "./mockBroker.ts";

const terms: MatchTerms = { map: "lqdm2", fraglimit: 20, timelimit: 10 };
const settle = () => new Promise((r) => setTimeout(r, 10));

/** One side's session and what it asked the engine to do. */
function side(broker: MockBroker, ids: string[] = []) {
  const calls: string[] = [];
  const events: SessionEvents = {
    state: () => {},
    host: (match) => calls.push(`host ${match}`),
    join: (match) => calls.push(`join ${match}`),
    stop: (reason: EndReason) => calls.push(`stop ${reason}`),
    link: (frame) => calls.push(`link ${frame.t}`),
    peer: () => {},
  };
  broker.launch();
  let n = 0;
  const session = new Session(broker, events, () => ids[n++] ?? `id${String(n).padStart(14, "0")}`);
  return { session, calls };
}

async function opened(...ids: string[][]) {
  const [a, b] = chatPair();
  const ana = side(a, ids[0]);
  await ana.session.start();
  const bob = side(b, ids[1]);
  await bob.session.start();
  await settle();
  return { a, b, ana, bob };
}

describe("Session", () => {
  it("Ana hosts, Bob sees the invitation and joins: both play the same match", async () => {
    const { ana, bob } = await opened(["AAAAAAAAAAAAAAAA"]);
    expect(ana.session.peer).toEqual({ version: "1.0.0" });
    ana.session.host(terms);
    expect(ana.calls).toEqual(["host AAAAAAAAAAAAAAAA"]);
    await settle();
    expect(bob.session.state).toEqual({ kind: "invited", match: "AAAAAAAAAAAAAAAA", terms });
    expect(bob.session.peerState).toBe("hosting");
    bob.session.join();
    expect(bob.calls).toEqual(["join AAAAAAAAAAAAAAAA"]);
    await settle();
    expect(ana.session.state).toEqual({ kind: "playing", match: "AAAAAAAAAAAAAAAA", terms, host: true });
    expect(bob.session.state).toEqual({ kind: "playing", match: "AAAAAAAAAAAAAAAA", terms, host: false });
  });

  it("an invitation reaches a contact who opens the app after the host started", async () => {
    const [a, b] = chatPair();
    const ana = side(a, ["BBBBBBBBBBBBBBBB"]);
    await ana.session.start();
    ana.session.host(terms);
    await settle();
    const bob = side(b);
    await bob.session.start();
    await settle();
    expect(bob.session.state).toMatchObject({ kind: "invited", match: "BBBBBBBBBBBBBBBB" });
  });

  it("when Bob leaves, Ana's server waits for him again; when Ana leaves, Bob's match ends", async () => {
    const { ana, bob } = await opened(["CCCCCCCCCCCCCCCC"]);
    ana.session.host(terms);
    await settle();
    bob.session.join();
    await settle();
    bob.session.leave();
    await settle();
    expect(bob.calls.at(-1)).toBe("stop left");
    expect(ana.session.state).toMatchObject({ kind: "hosting", match: "CCCCCCCCCCCCCCCC" });
    await settle();
    expect(bob.session.state).toMatchObject({ kind: "invited" });
    bob.session.join();
    await settle();
    ana.session.leave();
    await settle();
    expect(ana.calls.at(-1)).toBe("stop left");
    expect(bob.calls.at(-1)).toBe("stop contact-left");
    expect(bob.session.state).toEqual({ kind: "lobby" });
    expect(bob.session.lastEnd).toBe("contact-left");
  });

  it("the host keeps waiting when the joiner closes the app", async () => {
    const { b, ana, bob } = await opened(["DDDDDDDDDDDDDDDD"]);
    ana.session.host(terms);
    await settle();
    bob.session.join();
    await settle();
    b.shutdown();
    await settle();
    expect(ana.session.state).toMatchObject({ kind: "hosting", match: "DDDDDDDDDDDDDDDD" });
    expect(ana.session.peer).toBeNull();
  });

  it("the joiner's match ends when the host closes the app", async () => {
    const { a, ana, bob } = await opened(["EEEEEEEEEEEEEEEE"]);
    ana.session.host(terms);
    await settle();
    bob.session.join();
    await settle();
    a.shutdown();
    await settle();
    expect(bob.calls.at(-1)).toBe("stop contact-closed");
    expect(bob.session.state).toEqual({ kind: "lobby" });
  });

  it("if both host at once, the lower match id is kept and the other side joins it by itself", async () => {
    const { ana, bob } = await opened(["MMMMMMMMMMMMMMMM"], ["KKKKKKKKKKKKKKKK"]);
    ana.session.host(terms);
    bob.session.host({ ...terms, map: "lqdm7" });
    await settle();
    await settle();
    expect(bob.session.state).toMatchObject({ kind: "playing", match: "KKKKKKKKKKKKKKKK", host: true });
    expect(ana.session.state).toMatchObject({ kind: "playing", match: "KKKKKKKKKKKKKKKK", host: false, terms: { map: "lqdm7" } });
    expect(ana.calls).toEqual(["host MMMMMMMMMMMMMMMM", "stop left", "join KKKKKKKKKKKKKKKK"]);
  });

  it("passes the link's frames on, and ignores junk and other matches", async () => {
    const { a, ana } = await opened(["FFFFFFFFFFFFFFFF"]);
    ana.session.host(terms);
    a.inject({ t: "ping", v: 1, n: 1, at: 5 });
    a.inject({ t: "join", v: 1, match: "ZZZZZZZZZZZZZZZZ" });
    a.inject({ t: "host", v: 1, match: "x", terms });
    a.inject("junk");
    await settle();
    expect(ana.calls).toEqual(["host FFFFFFFFFFFFFFFF", "link ping"]);
    expect(ana.session.state).toMatchObject({ kind: "hosting" });
  });

  it("turning an invitation down sends nothing to the host", async () => {
    const { a, ana, bob } = await opened(["GGGGGGGGGGGGGGGG"]);
    ana.session.host(terms);
    await settle();
    const before = a.sent.length;
    bob.session.leave();
    await settle();
    expect(bob.session.state).toEqual({ kind: "lobby" });
    expect(a.sent.length).toBe(before);
    expect(ana.session.state).toMatchObject({ kind: "hosting" });
  });
});

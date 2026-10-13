import { describe, expect, it } from "vitest";
import { fromBase64, isTerms, MAP_IDS, MATCH_ID, newMatchId, readFrame, toBase64 } from "../src/protocol.ts";

const match = "AbCdEfGhIjKlMn_-";

describe("readFrame", () => {
  it("takes each frame Arena sends", () => {
    expect(readFrame({ t: "hello", v: 1, state: "hosting", match })).toEqual({ t: "hello", v: 1, state: "hosting", match });
    expect(readFrame({ t: "host", v: 1, match, terms: { map: "lqdm6", fraglimit: 20, timelimit: 15 } })).toEqual({
      t: "host", v: 1, match, terms: { map: "lqdm6", fraglimit: 20, timelimit: 15 },
    });
    expect(readFrame({ t: "join", v: 1, match })).toEqual({ t: "join", v: 1, match });
    expect(readFrame({ t: "net", v: 1, match, p: ["AAEC", ""] })).toEqual({ t: "net", v: 1, match, p: ["AAEC", ""] });
    expect(readFrame({ t: "net", v: 1, match, p: ["AAEC"], part: [1, 3] })).toMatchObject({ part: [1, 3] });
    expect(readFrame({ t: "ping", v: 1, n: 3, at: 12.5 })).toEqual({ t: "ping", v: 1, n: 3, at: 12.5 });
  });

  it("drops what is not exactly one of them", () => {
    for (const junk of [
      null, 1, "net", [], {}, { t: "net", v: 1 }, { t: "nope", v: 1 }, { t: "join", v: 0, match },
      { t: "join", v: 1, match: "short" }, { t: "host", v: 1, match, terms: { map: "e1m1", fraglimit: 10, timelimit: 10 } },
      { t: "host", v: 1, match, terms: { map: "lqdm1", fraglimit: 11, timelimit: 10 } },
      { t: "net", v: 1, match, p: ["not base64!"] }, { t: "net", v: 1, match, p: [1] },
      { t: "net", v: 1, match, p: Array(65).fill("AA==") }, { t: "net", v: 1, match, p: ["AA==", "AA=="], part: [0, 2] },
      { t: "net", v: 1, match, p: ["AA=="], part: [2, 2] }, { t: "net", v: 1, match, p: ["AA=="], part: [0, 1] },
      { t: "ping", v: 1, n: -1, at: 0 }, { t: "pong", v: 1, n: 1, at: Number.NaN }, { t: "hello", v: 1, state: "lost" },
      { t: "hello", v: 1, state: "lobby", match: "x" },
    ]) {
      expect(readFrame(junk as never), JSON.stringify(junk)).toBeNull();
    }
  });

  it("keeps only the keys it knows", () => {
    expect(readFrame({ t: "join", v: 2, match, extra: "x" } as never)).toEqual({ t: "join", v: 2, match });
  });
});

describe("helpers", () => {
  it("round-trips bytes through base64", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) & 0xff);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("makes match ids the frames accept", () => {
    for (let i = 0; i < 50; i++) expect(newMatchId()).toMatch(MATCH_ID);
  });

  it("checks terms", () => {
    expect(isTerms({ map: MAP_IDS[0], fraglimit: 10, timelimit: 10 })).toBe(true);
    expect(isTerms({ map: MAP_IDS[0], fraglimit: 10 })).toBe(false);
  });
});

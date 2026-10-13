/**
 * The frames Arena sends to the same app on the contact's side (WISP 1200, `apps/1`), and the checks on what the
 * contact sends: every frame from the peer is untrusted, so anything that is not exactly one of these shapes is
 * dropped. See docs/protocol.md.
 *
 * - `hello`: this side's state, sent when the peer opens the app and when this side's state changes.
 * - `host`: this side hosts a match, on these terms, with this id. The other side joins it with `join`.
 * - `join`: this side's engine is starting and will connect to the match with that id.
 * - `leave`: this side left the match with that id.
 * - `net`: the engine's packets for the match with that id, in order, each in base64. A packet too large for one frame
 *   travels in parts (`part` is [index, count]) and is put back together before the engine reads it.
 * - `ping` and `pong`: the app's own round trip over the chat, `at` being the sender's clock, echoed back.
 */
import type { MiniAppJson } from "./vendor/miniApp.ts";

export const PROTOCOL = 1;

/** The maps the app carries (scripts/data.mjs's MAPS), by the engine's name. */
export const MAP_IDS = ["lqdm1", "lqdm2", "lqdm4", "lqdm6", "lqdm7", "lqdm8", "lqdm10", "lqdm11", "lqdm12", "lqdm13"] as const;
export type MapId = (typeof MAP_IDS)[number];
export const FRAG_LIMITS = [5, 10, 20, 30] as const;
export const TIME_LIMITS = [5, 10, 15, 20] as const;

export interface MatchTerms {
  map: MapId;
  fraglimit: (typeof FRAG_LIMITS)[number];
  timelimit: (typeof TIME_LIMITS)[number];
}

export type Frame =
  | { t: "hello"; v: number; state: "lobby" | "hosting" | "playing"; match?: string }
  | { t: "host"; v: number; match: string; terms: MatchTerms }
  | { t: "join"; v: number; match: string }
  | { t: "leave"; v: number; match: string }
  | { t: "net"; v: number; match: string; p: string[]; part?: [number, number] }
  | { t: "ping"; v: number; n: number; at: number }
  | { t: "pong"; v: number; n: number; at: number };

/** A match id: 16 random base64url characters. */
export const MATCH_ID = /^[A-Za-z0-9_-]{16}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** At most this many packets in one `net` frame (a frame is bounded by its bytes anyway). */
export const MAX_PACKETS_PER_FRAME = 64;
/** A packet the engine would never make: larger is dropped. */
export const MAX_PACKET_BYTES = 64 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function newMatchId(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(12));
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_");
}

export function isTerms(value: unknown): value is MatchTerms {
  return (
    isObject(value) &&
    (MAP_IDS as readonly unknown[]).includes(value.map) &&
    (FRAG_LIMITS as readonly unknown[]).includes(value.fraglimit) &&
    (TIME_LIMITS as readonly unknown[]).includes(value.timelimit)
  );
}

/** The frame a peer sent, or null when it is not one Arena understands (a later version's, or junk). */
export function readFrame(data: MiniAppJson): Frame | null {
  if (!isObject(data) || typeof data.t !== "string" || !Number.isSafeInteger(data.v) || (data.v as number) < 1) return null;
  const v = data.v as number;
  const match = typeof data.match === "string" && MATCH_ID.test(data.match) ? data.match : undefined;
  switch (data.t) {
    case "hello":
      if (data.state !== "lobby" && data.state !== "hosting" && data.state !== "playing") return null;
      if (data.match !== undefined && !match) return null;
      return { t: "hello", v, state: data.state, ...(match && { match }) };
    case "host":
      return match && isTerms(data.terms) ? { t: "host", v, match, terms: { map: data.terms.map, fraglimit: data.terms.fraglimit, timelimit: data.terms.timelimit } } : null;
    case "join":
    case "leave":
      return match ? { t: data.t, v, match } : null;
    case "net": {
      if (!match || !Array.isArray(data.p) || data.p.length > MAX_PACKETS_PER_FRAME) return null;
      if (!data.p.every((p) => typeof p === "string" && p.length <= (MAX_PACKET_BYTES * 4) / 3 + 4 && BASE64.test(p))) return null;
      let part: [number, number] | undefined;
      if (data.part !== undefined) {
        const [index, count] = Array.isArray(data.part) ? data.part : [];
        if (!isCount(count, 64) || count < 2 || !isCount(index, count - 1) || data.p.length !== 1) return null;
        part = [index, count];
      }
      return { t: "net", v, match, p: data.p as string[], ...(part && { part }) };
    }
    case "ping":
    case "pong":
      return isCount(data.n, Number.MAX_SAFE_INTEGER) && isTime(data.at) ? { t: data.t, v, n: data.n, at: data.at } : null;
    default:
      return null;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The size `chat.send` counts: the value as compact JSON, in UTF-8 bytes (ASCII here). */
export const frameBytes = (frame: Frame): number => JSON.stringify(frame).length;

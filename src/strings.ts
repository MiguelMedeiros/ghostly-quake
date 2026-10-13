/**
 * The app's words in Ghostly's 8 languages (en, pt, es, fr, it, ja, zh, ar): English here, the others in
 * languages.ts, where a missing key fails the typecheck. pickLanguage chooses from the client's locale. Map names stay
 * as LibreQuake wrote them.
 */
import { ar, es, fr, it, ja, pt, zh } from "./languages.ts";

export const en = {
  title: "Arena",
  tagline: "A deathmatch for two, in your chat",
  loading: "Loading the arena…",
  loadingEngine: "Starting the engine…",
  failed: "The arena could not start: {error}",
  alone: "Open Arena in a chat to play a contact. Alone, you can walk the maps.",
  waitingPeer: "Waiting for your contact to open Arena",
  peerHere: "Your contact has Arena open",
  peerHosting: "Your contact is hosting a match",
  peerPlaying: "Your contact is in a match",
  peerVersion: "Your contact has Arena {version}. Update both to the same version to play.",
  map: "Map",
  frags: "Frag limit",
  minutes: "Time limit",
  minutesValue: "{n} min",
  host: "Host a match",
  walk: "Walk the map",
  invitation: "Your contact hosts {map}: first to {frags} frags, {minutes} minutes.",
  join: "Join",
  decline: "Not now",
  hosting: "Waiting for your contact to join. Look around meanwhile.",
  playing: "Playing {map}",
  leave: "Leave",
  ended_left: "You left the match.",
  "ended_contact-left": "Your contact left the match.",
  "ended_contact-closed": "Your contact closed Arena.",
  ended_offline: "The chat went offline.",
  settings: "Settings",
  sensitivity: "Mouse sensitivity",
  invert: "Invert mouse",
  volume: "Volume",
  edgeTurn: "Turn at the edges",
  controls: "Controls",
  controlsText:
    "Move with W A S D, jump with Space, shoot with the left button, change weapons with 1 to 8 or the wheel. The frame cannot capture the mouse, so move it to aim, rest it at the left or right edge to keep turning, or turn with the arrow keys. Tab shows the scores, Esc the engine's menu.",
  needsKeyboard: "Arena needs a keyboard and a mouse.",
  stats: "{rtt} ms · {fps} fps · {kbps} KB/s",
  credits: "Built on FTEQW, a GPL engine descended from id Software's Quake engine, with LibreQuake's free maps and art.",
  source: "Source code",
};

export type Strings = typeof en;
export type Language = "en" | "pt" | "es" | "fr" | "it" | "ja" | "zh" | "ar";

const TABLES: Record<Language, Strings> = { en, pt, es, fr, it, ja, zh, ar };

/** The language for a BCP 47 tag ("pt-BR" → pt), English when Arena does not speak it. */
export function pickLanguage(tag: string | undefined): Language {
  const base = (tag ?? "").toLowerCase().split(/[-_]/)[0] as Language;
  return base in TABLES ? base : "en";
}

export function stringsFor(language: Language): Strings {
  return TABLES[language];
}

/** A string with its {placeholders} filled. */
export function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));
}

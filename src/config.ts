/**
 * What the app tells the engine: its start-up script (quake.rc, written into the engine's file system), the settings
 * the person chose, and the console commands that host, join and leave a match. Every value that comes from outside
 * the app (a name from the chat) is cleaned before it reaches a console line, so it can never end one or start another.
 */
import type { MatchTerms } from "./protocol.ts";

/** The address of the chat pipe the engine's patched socket code recognises (engine/patches). */
export const PIPE_URL = "ws://ghostly.invalid/host";

export interface Settings {
  /** Mouse sensitivity, the engine's `sensitivity`. */
  sensitivity: number;
  invertMouse: boolean;
  /** 0 to 1. */
  volume: number;
  /** Degrees a second the view turns while the pointer rests at the frame's left or right edge (0: off). */
  edgeTurn: number;
}

export const DEFAULT_SETTINGS: Settings = { sensitivity: 4, invertMouse: false, volume: 0.6, edgeTurn: 180 };

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const num = (value: number): string => String(Math.round(value * 1000) / 1000);

/** Settings read from storage, whatever was kept there: anything missing or out of range takes its default. */
export function readSettings(value: unknown): Settings {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const pick = (key: keyof Settings, min: number, max: number): number => {
    const x = v[key];
    return typeof x === "number" && Number.isFinite(x) ? clamp(x, min, max) : (DEFAULT_SETTINGS[key] as number);
  };
  return {
    sensitivity: pick("sensitivity", 1, 20),
    invertMouse: typeof v.invertMouse === "boolean" ? v.invertMouse : DEFAULT_SETTINGS.invertMouse,
    volume: pick("volume", 0, 1),
    edgeTurn: pick("edgeTurn", 0, 360),
  };
}

/**
 * A player name for the engine: printable ASCII only (the engine's font has no other glyphs that read as letters),
 * no quotes, semicolons or backslashes (they would end a console line or an infostring value), at most 15 characters.
 * Accents are dropped to their letter ("João" becomes "Joao").
 */
export function playerName(name: string | undefined, fallback: string): string {
  const clean = (name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\;$]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 15)
    .trim();
  return clean || fallback;
}

/** quake.rc: LibreQuake's defaults, then the app's own settings. No demos, no saved config, no server lists. */
export function startupScript(): string {
  return [
    "exec default.cfg",
    "exec ghostly.cfg",
    "stuffcmds",
    "",
  ].join("\n");
}

/** ghostly.cfg: what the app needs from the engine, whatever LibreQuake's defaults say. */
export function appConfig(settings: Settings, name: string, colour: number): string {
  return [
    // The chat is the only network: no broker, no master servers, nothing public.
    'set net_ice_broker ""',
    'set sv_port_rtc ""',
    "set sv_public 0",
    "set cl_master 0",
    "set sb_hidenetquake 1",
    // Both sides carry the same data: nothing is downloaded from the host.
    "set allow_download 0",
    "set cl_downloads 0",
    // Packets: the chat carries about 34 frames a second (src/link.ts), so the client sends 30 moves a second.
    "set cl_netfps 30",
    "set rate 30000",
    // The player.
    `set name "${playerName(name, "Player")}"`,
    `set topcolor ${colour}`,
    `set bottomcolor ${colour}`,
    ...settingsCommands(settings),
    // Keys: LibreQuake's WASD and mouse, and the arrows for turning, since the frame cannot capture the mouse.
    'bind LEFTARROW "+left"',
    'bind RIGHTARROW "+right"',
    'bind UPARROW "+forward"',
    'bind DOWNARROW "+back"',
    'bind PGUP "+lookup"',
    'bind PGDN "+lookdown"',
    'bind TAB "+showscores"',
    "set cl_yawspeed 180",
    "set cl_pitchspeed 150",
    // Nothing the frame cannot do: no fullscreen, no saving to a disk it does not have.
    "set vid_fullscreen 0",
    "set cfg_save_auto 0",
    "",
  ].join("\n");
}

/** The settings as console commands, for the start and for a change while the engine runs. */
export function settingsCommands(settings: Settings): string[] {
  return [
    `set sensitivity ${num(settings.sensitivity)}`,
    `set m_pitch ${settings.invertMouse ? "-0.022" : "0.022"}`,
    `set volume ${num(settings.volume)}`,
  ];
}

/** Starts this side's server for a match: deathmatch 3 (items respawn, weapons stay), the contact's slot on the pipe. */
export function hostCommands(terms: MatchTerms): string[] {
  return [
    "disconnect",
    "set deathmatch 3",
    "set teamplay 0",
    "set coop 0",
    `set fraglimit ${terms.fraglimit}`,
    `set timelimit ${terms.timelimit}`,
    "set samelevel 1",
    "set maxclients 2",
    `set sv_port_rtc "${PIPE_URL}"`,
    `map ${terms.map}`,
    "closemenu",
  ];
}

/** Connects to the contact's server, over the pipe. */
export function joinCommands(): string[] {
  return ["disconnect", `connect ${PIPE_URL}`, "closemenu"];
}

/** Leaves the match (and closes this side's server, when it hosts). */
export function leaveCommands(): string[] {
  return ["disconnect", 'set sv_port_rtc ""'];
}

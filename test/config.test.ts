import { describe, expect, it } from "vitest";
import { appConfig, DEFAULT_SETTINGS, hostCommands, joinCommands, leaveCommands, PIPE_URL, playerName, readSettings, settingsCommands } from "../src/config.ts";

describe("playerName", () => {
  it("keeps a plain name, drops accents to their letters", () => {
    expect(playerName("Ana", "Player")).toBe("Ana");
    expect(playerName("João Ñandú", "Player")).toBe("Joao Nandu");
  });

  it("never lets a name end a console line or an infostring value", () => {
    for (const evil of ['a"; quit; "', "a\\b\\c", "x\ny", "a;b", "$var"]) {
      const name = playerName(evil, "Player");
      expect(name).not.toMatch(/["\;\n$]/);
    }
  });

  it("is at most 15 characters, and falls back when nothing printable is left", () => {
    expect(playerName("A".repeat(40), "Player")).toHaveLength(15);
    expect(playerName("日本語", "Player")).toBe("Player");
    expect(playerName(undefined, "Player")).toBe("Player");
    expect(playerName("   ", "Player")).toBe("Player");
  });
});

describe("settings", () => {
  it("reads what storage kept, and takes defaults for anything missing or out of range", () => {
    expect(readSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings({ sensitivity: 99, invertMouse: true, volume: -1, edgeTurn: "fast" })).toEqual({ ...DEFAULT_SETTINGS, sensitivity: 20, invertMouse: true, volume: 0 });
  });

  it("turns them into console commands", () => {
    expect(settingsCommands({ sensitivity: 3.25, invertMouse: true, volume: 0.5, edgeTurn: 90 })).toEqual(["set sensitivity 3.25", "set m_pitch -0.022", "set volume 0.5"]);
  });
});

describe("commands", () => {
  it("host a deathmatch listening on the chat pipe", () => {
    const lines = hostCommands({ map: "lqdm6", fraglimit: 20, timelimit: 15 });
    expect(lines).toContain(`set sv_port_rtc "${PIPE_URL}"`);
    expect(lines).toContain("set deathmatch 3");
    expect(lines).toContain("set fraglimit 20");
    expect(lines).toContain("set timelimit 15");
    expect(lines.indexOf("map lqdm6")).toBeGreaterThan(lines.indexOf(`set sv_port_rtc "${PIPE_URL}"`));
  });

  it("join and leave over the pipe", () => {
    expect(joinCommands()).toContain(`connect ${PIPE_URL}`);
    expect(leaveCommands()).toEqual(["disconnect", 'set sv_port_rtc ""']);
  });

  it("the app's config shuts every other way out", () => {
    const cfg = appConfig(DEFAULT_SETTINGS, 'Bob"; quit', 13);
    expect(cfg).toContain('set net_ice_broker ""');
    expect(cfg).toContain("set sv_public 0");
    expect(cfg).toContain('set name "Bob quit"');
    expect(cfg).toContain("set cl_netfps 30");
    expect(cfg.split("\n").every((line) => !line.includes("quit") || line.startsWith("set name"))).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readPak, readZip, resampleWav, SOUND_RATE, writeZip } from "../scripts/data.mjs";

/** A mono PCM WAV, with a Quake loop (`cue ` at `loop`, LIST adtl ltxt of `length`) when asked. */
function wav(rate: number, bits: 8 | 16, samples: number, loop?: { start: number; length: number }): Buffer {
  const width = bits / 8;
  const data = Buffer.alloc(samples * width);
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((i / rate) * 2 * Math.PI * 440);
    if (bits === 8) data[i] = Math.round(v * 100 + 128);
    else data.writeInt16LE(Math.round(v * 20000), i * 2);
  }
  const chunk = (id: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, "latin1");
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * width, 8);
  fmt.writeUInt16LE(width, 12);
  fmt.writeUInt16LE(bits, 14);
  const parts = [chunk("fmt ", fmt)];
  if (loop) {
    const cue = Buffer.alloc(28);
    cue.writeUInt32LE(1, 0);
    cue.writeUInt32LE(loop.start, 4 + 4);
    cue.writeUInt32LE(loop.start, 4 + 20);
    parts.push(chunk("cue ", cue));
    const ltxt = Buffer.alloc(4 + 8 + 20);
    ltxt.write("adtl", 0, "latin1");
    ltxt.write("ltxt", 4, "latin1");
    ltxt.writeUInt32LE(20, 8);
    ltxt.writeUInt32LE(loop.length, 16);
    parts.push(chunk("LIST", ltxt));
  }
  parts.push(chunk("data", data));
  const body = Buffer.concat(parts);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write("WAVE", 8, "latin1");
  return Buffer.concat([riff, body]);
}

describe("resampleWav", () => {
  it("takes a fast sound down to 22,050 Hz, with its loop scaled", () => {
    const out = resampleWav(wav(44100, 16, 44100, { start: 1000, length: 20000 }));
    expect(out.readUInt32LE(24)).toBe(SOUND_RATE);
    const dataAt = out.indexOf("data", 12, "latin1");
    expect(out.readUInt32LE(dataAt + 4)).toBe(22050 * 2);
    const cueAt = out.indexOf("cue ", 12, "latin1");
    expect(out.readUInt32LE(cueAt + 8 + 4 + 20)).toBe(500);
    const ltxtAt = out.indexOf("ltxt", 12, "latin1");
    expect(out.readUInt32LE(ltxtAt + 12)).toBe(10000);
  });

  it("keeps the signal: a 440 Hz tone stays a tone of the same loudness", () => {
    const out = resampleWav(wav(48000, 16, 48000));
    const dataAt = out.indexOf("data", 12, "latin1") + 8;
    let peak = 0;
    for (let i = 1000; i < 20000; i++) peak = Math.max(peak, Math.abs(out.readInt16LE(dataAt + i * 2)));
    expect(peak).toBeGreaterThan(19000);
    expect(peak).toBeLessThan(21000);
  });

  it("leaves slow, 8-bit-at-22 kHz and odd files alone", () => {
    const slow = wav(11025, 16, 1000);
    expect(resampleWav(slow)).toBe(slow);
    const eight = wav(22050, 8, 1000);
    expect(resampleWav(eight)).toBe(eight);
    const odd = Buffer.from("RIFF\0\0\0\0WAVEjunk");
    expect(resampleWav(odd)).toBe(odd);
    expect(resampleWav(wav(44100, 8, 4410)).readUInt32LE(24)).toBe(SOUND_RATE);
  });
});

describe("pk3", () => {
  it("writes the same zip for the same files, and reads it back", () => {
    const files = new Map([
      ["progs.dat", Buffer.from("game code")],
      ["maps/b.bsp", Buffer.alloc(5000, 7)],
      ["maps/a.bsp", Buffer.from([1, 2, 3])],
    ]);
    const zip = writeZip(files);
    expect(writeZip(new Map([...files].reverse()))).toEqual(zip);
    const back = readZip(zip);
    expect([...back.keys()]).toEqual(["maps/a.bsp", "maps/b.bsp", "progs.dat"]);
    for (const [name, bytes] of files) expect(back.get(name)).toEqual(bytes);
  });

  it("the committed data is what data/files.txt and the maps ask for", () => {
    const listed = readFileSync(new URL("../data/files.txt", import.meta.url), "utf8").split("\n").filter(Boolean);
    expect([...listed].sort()).toEqual(listed);
    expect(new Set(listed).size).toBe(listed.length);
    const pk3 = readZip(readFileSync(new URL("../data/arena.pk3", import.meta.url)));
    for (const name of listed) expect(pk3.has(name), name).toBe(true);
    expect(pk3.has("progs.dat")).toBe(true);
    expect(pk3.has("quake.rc")).toBe(false);
  });

  it("reads a Quake pak", () => {
    const body = Buffer.from("hello");
    const header = Buffer.alloc(12);
    header.write("PACK", 0, "latin1");
    header.writeInt32LE(12 + body.length, 4);
    header.writeInt32LE(64, 8);
    const entry = Buffer.alloc(64);
    entry.write("gfx/x.lmp", 0, "latin1");
    entry.writeInt32LE(12, 56);
    entry.writeInt32LE(body.length, 60);
    expect(readPak(Buffer.concat([header, body, entry])).get("gfx/x.lmp")).toEqual(body);
  });
});

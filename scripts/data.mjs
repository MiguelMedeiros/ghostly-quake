// Builds the game data, data/arena.pk3, from LibreQuake's release (BSD-3-Clause art, GPL-2.0 game code): only what a
// deathmatch on the listed maps loads, with the sounds above 22,050 Hz resampled to 22,050 Hz so the whole app fits
// the 16 MiB a bundle may hold. The pk3 is a zip that FTEQW reads as it is; this script writes it the same way every
// time (sorted entries, a fixed date, fflate's deflate at level 9, which is plain JavaScript and so the same on every
// machine), so the same inputs always give the same bytes.
//
//   npm run gen:data              write data/arena.pk3 (downloads the two release archives once, into data/.cache/)
//   npm run gen:data -- --check   build it again and compare with the committed data/arena.pk3
//
// The list of files is data/files.txt: every file FTEQW opened while it loaded each deathmatch map, opened its menus
// and played (gathered once with a logging run of the engine), plus the menus' pictures and sounds.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "fflate";
import { inflateRawSync } from "node:zlib";

const RELEASE = "https://github.com/lavenderdotpet/LibreQuake/releases/download/v0.09-beta";
/** The release archives, by SHA-256. `lite` has the game data in pak0.pak and pak1.pak; `server` has the maps. */
export const ARCHIVES = {
  lite: { file: "lite.zip", sha256: "428e736b2f01d953e09a08c60bee975bdc4a0ac2219e97fa095c8af41754da83" },
  server: { file: "server.zip", sha256: "ccb593f7ff5e87e04f03dbf298960f91ffd7bfdac85d06d9ad1f9874dbc8d0f1" },
};
/**
 * The deathmatch maps the app carries, in the order the app lists them, with their LibreQuake names. Each takes its
 * .lit (coloured light) when the release has one.
 */
export const MAPS = [
  ["lqdm1", "Solstice"],
  ["lqdm2", "Torture Pit"],
  ["lqdm4", "Psychofuge"],
  ["lqdm6", "Ghost Quarter"],
  ["lqdm7", "Boomstick Basement"],
  ["lqdm8", "Alichar Sector"],
  ["lqdm10", "Lucifer's Gambit"],
  ["lqdm11", "The Wicked Night"],
  ["lqdm12", "Javelin"],
  ["lqdm13", "Death Provides No Return"],
];
/** Sounds above this rate are resampled to it. */
export const SOUND_RATE = 22050;

const root = fileURLToPath(new URL("..", import.meta.url));
const cache = resolve(root, "data/.cache");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function archive({ file, sha256: want }) {
  const path = resolve(cache, file);
  if (!existsSync(path)) {
    mkdirSync(cache, { recursive: true });
    const response = await fetch(`${RELEASE}/${file}`);
    if (!response.ok) throw new Error(`${file}: ${response.status}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = readFileSync(path);
  if (sha256(bytes) !== want) throw new Error(`${file} has SHA-256 ${sha256(bytes)}, expected ${want}`);
  return bytes;
}

/** A zip's files by name (stored or deflated entries; enough for the release archives). */
export function readZip(zip) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central directory");
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    if (method !== 0 && method !== 8) throw new Error(`${name}: compression method ${method}`);
    if (!name.endsWith("/")) files.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

/** A Quake pak's files by name. */
export function readPak(pak) {
  if (pak.toString("latin1", 0, 4) !== "PACK") throw new Error("not a pak");
  const offset = pak.readInt32LE(4);
  const length = pak.readInt32LE(8);
  const files = new Map();
  for (let i = 0; i < length / 64; i++) {
    const at = offset + i * 64;
    const name = pak.toString("latin1", at, at + 56).replace(/\0.*$/s, "");
    const start = pak.readInt32LE(at + 56);
    files.set(name, pak.subarray(start, start + pak.readInt32LE(at + 60)));
  }
  return files;
}

/** RIFF chunks of a WAV, in order. */
function chunks(wav) {
  const list = [];
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = wav.toString("latin1", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    list.push({ id, data: wav.subarray(at + 8, at + 8 + size) });
    at += 8 + size + (size & 1);
  }
  return list;
}

/**
 * The WAV at `rate` when it is PCM, mono, 8 or 16 bits and faster than that; otherwise the same bytes. A windowed sinc
 * filters below the new Nyquist frequency. The loop markers Quake reads (the `cue ` chunk's start and the `LIST`
 * `ltxt` length) are scaled with the samples, and other chunks are dropped.
 */
export function resampleWav(wav, rate = SOUND_RATE) {
  if (wav.toString("latin1", 0, 4) !== "RIFF" || wav.toString("latin1", 8, 12) !== "WAVE") return wav;
  const list = chunks(wav);
  const fmt = list.find((c) => c.id === "fmt ")?.data;
  const data = list.find((c) => c.id === "data")?.data;
  if (!fmt || !data || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1) return wav;
  const from = fmt.readUInt32LE(4);
  const bits = fmt.readUInt16LE(14);
  if (from <= rate || (bits !== 8 && bits !== 16)) return wav;
  const width = bits / 8;
  const n = Math.floor(data.length / width);
  const input = new Float64Array(n);
  for (let i = 0; i < n; i++) input[i] = bits === 8 ? (data[i] - 128) / 128 : data.readInt16LE(i * 2) / 32768;
  const ratio = rate / from;
  const outLength = Math.floor(n * ratio);
  const output = Buffer.alloc(outLength * width);
  const taps = 16;
  for (let o = 0; o < outLength; o++) {
    const center = o / ratio;
    const first = Math.ceil(center - taps / ratio);
    const last = Math.floor(center + taps / ratio);
    let sum = 0;
    let weight = 0;
    for (let i = Math.max(0, first); i <= Math.min(n - 1, last); i++) {
      const x = (i - center) * ratio;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / taps);
      sum += input[i] * sinc * window;
      weight += sinc * window;
    }
    const value = Math.max(-1, Math.min(1, weight ? sum / weight : 0));
    if (bits === 8) output[o] = Math.round(value * 127 + 128);
    else output.writeInt16LE(Math.round(value * 32767), o * 2);
  }
  const newFmt = Buffer.from(fmt.subarray(0, 16));
  newFmt.writeUInt32LE(rate, 4);
  newFmt.writeUInt32LE(rate * width, 8);
  const out = [["fmt ", newFmt]];
  const cue = list.find((c) => c.id === "cue ")?.data;
  if (cue && cue.length >= 28) {
    const scaled = Buffer.from(cue);
    for (let i = 0, count = cue.readUInt32LE(0); i < count && 4 + i * 24 + 24 <= cue.length; i++) {
      scaled.writeUInt32LE(Math.floor(cue.readUInt32LE(4 + i * 24 + 20) * ratio), 4 + i * 24 + 20);
      scaled.writeUInt32LE(Math.floor(cue.readUInt32LE(4 + i * 24 + 4) * ratio), 4 + i * 24 + 4);
    }
    out.push(["cue ", scaled]);
    const listChunk = list.find((c) => c.id === "LIST" && c.data.toString("latin1", 0, 4) === "adtl")?.data;
    if (listChunk) {
      const scaledList = Buffer.from(listChunk);
      for (let at = 4; at + 8 <= scaledList.length; ) {
        const id = scaledList.toString("latin1", at, at + 4);
        const size = scaledList.readUInt32LE(at + 4);
        if (id === "ltxt" && size >= 8) scaledList.writeUInt32LE(Math.floor(scaledList.readUInt32LE(at + 12) * ratio), at + 12);
        at += 8 + size + (size & 1);
      }
      out.push(["LIST", scaledList]);
    }
  }
  out.push(["data", output]);
  const body = Buffer.concat(out.flatMap(([id, bytes]) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, "latin1");
    head.writeUInt32LE(bytes.length, 4);
    return bytes.length & 1 ? [head, bytes, Buffer.alloc(1)] : [head, bytes];
  }));
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write("WAVE", 8, "latin1");
  return Buffer.concat([riff, body]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A zip of these files, sorted by name, deflated at level 9, dated 1980-01-01: the same files always give the same bytes. */
export function writeZip(files) {
  const names = [...files.keys()].sort();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const name of names) {
    const bytes = files.get(name);
    const deflated = Buffer.from(deflateSync(bytes, { level: 9, mem: 12 }));
    const store = deflated.length >= bytes.length;
    const body = store ? bytes : deflated;
    const nameBytes = Buffer.from(name, "latin1");
    const crc = crc32(bytes);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(store ? 0 : 8, 8);
    head.writeUInt16LE(0x21, 12); // 1980-01-01 00:00
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(bytes.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(store ? 0 : 8, 10);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(head, nameBytes, body);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

/** Every file of the pk3, by its path in the game. */
export async function gameFiles() {
  const lite = readZip(await archive(ARCHIVES.lite));
  const server = readZip(await archive(ARCHIVES.server));
  const paks = new Map([...readPak(lite.get("lite/id1/pak0.pak")), ...readPak(lite.get("lite/id1/pak1.pak"))]);
  const wanted = readFileSync(resolve(root, "data/files.txt"), "utf8").split("\n").filter(Boolean);
  const files = new Map();
  for (const name of wanted) {
    const bytes = paks.get(name) ?? lite.get(`lite/id1/${name}`);
    if (!bytes) throw new Error(`${name} is not in LibreQuake's paks or id1 folder`);
    files.set(name, name.endsWith(".wav") ? resampleWav(bytes) : Buffer.from(bytes));
  }
  for (const [map] of MAPS) {
    for (const ext of ["bsp", "lit"]) {
      const bytes = server.get(`server/maps/${map}.${ext}`);
      if (bytes) files.set(`maps/${map}.${ext}`, bytes);
      else if (ext === "bsp") throw new Error(`${map}.bsp is not in LibreQuake's server archive`);
    }
  }
  return files;
}

async function main() {
  const check = process.argv.includes("--check");
  const files = await gameFiles();
  const pk3 = writeZip(files);
  const out = resolve(root, "data/arena.pk3");
  console.log(`data/arena.pk3: ${files.size} files, ${pk3.length} bytes, sha256 ${sha256(pk3)}`);
  if (check) {
    const committed = readFileSync(out);
    if (!committed.equals(pk3)) {
      console.error(`differs from the committed data/arena.pk3 (${committed.length} bytes, sha256 ${sha256(committed)})`);
      process.exit(1);
    }
    console.log("the same bytes as the committed data/arena.pk3");
    return;
  }
  writeFileSync(out, pk3);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

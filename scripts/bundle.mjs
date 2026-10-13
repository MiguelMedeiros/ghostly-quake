// What the signed bundle holds, and whether it is this checkout's build: run it after `ghostly app publish`, before
// the bundle is committed. See docs/PUBLISHING.md.
//
//   npm run build && npm run check:bundle                 app.ghostlyapp at the repository root
//   npm run check:bundle -- --listing                     also prints the store's listing.json for it
//   npm run check:bundle -- <file>                        another bundle
//   npm run check:bundle -- --expect <sequence> --publisher <key>
//                                                         no bundle needed: the digest this build will have, signed by
//                                                         that publisher key under that sequence
//
// It reads the bundle's manifest (WISP 1200: "GHOSTLYAPP1", the manifest's length, the manifest) and checks that it
// is Arena under Arena's publisher key, that it says what ghostly-app.json says, and that its files are this build's,
// byte for byte. It does NOT check the signature: `ghostly app verify` does that, and the store's check does it again.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBundleFiles } from "./files.mjs";

/**
 * Arena's publisher key (public). It does not exist until the owner signs the first version: `ghostly app publish`
 * makes it then. Write it here in the commit that adds the first signed bundle; until then the check prints the key a
 * bundle was signed with and does not compare it.
 */
export const PUBLISHER = null;
export const REPO = "MiguelMedeiros/ghostly-quake";
export const BUNDLE = "app.ghostlyapp";
/** Where clients read newer bundles: this repository's HEAD. The manifest's `sources` names it. */
export const SOURCE = `https://raw.githubusercontent.com/${REPO}/HEAD/${BUNDLE}`;
/** The fields `ghostly app publish` writes into the manifest. */
const WRITTEN = ["ghostlyApp", "publisher", "sequence", "files"];
const MAGIC = Buffer.from("GHOSTLYAPP1");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("base64url");
/** JSON with every object's keys in order, to compare two values whatever order their keys were written in. */
const stable = (value) =>
  JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

/** A bundle's manifest and its digest (SHA-256 of the manifest's bytes, base64url: what a listing names). */
export function readManifest(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < MAGIC.length + 4 || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a .ghostlyapp bundle");
  const length = buffer.readUInt32BE(MAGIC.length);
  const manifestBytes = buffer.subarray(MAGIC.length + 4, MAGIC.length + 4 + length);
  if (manifestBytes.length !== length) throw new Error("the bundle is cut short");
  return { manifest: JSON.parse(manifestBytes.toString("utf8")), digest: sha256(manifestBytes) };
}

/**
 * A manifest's digest, from its fields: the SHA-256 of its canonical JSON (RFC 8785: keys in order, no spaces), which
 * is the bytes `ghostly app publish` signs.
 */
export const digestOf = (manifest) => sha256(Buffer.from(stable(manifest)));

/** The manifest `ghostly app publish` makes of ghostly-app.json and the built files, under a key and a sequence. */
export function expected(source, files, sequence, publisher) {
  return { ...source, ghostlyApp: 1, publisher, sequence, files: files.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: sha256(bytes) })) };
}

/** What is wrong with a bundle's manifest, given ghostly-app.json and the built files. Empty when nothing is. */
export function problems(manifest, source, files, publisher = PUBLISHER) {
  const found = [];
  if (publisher !== null && manifest.publisher !== publisher) found.push(`signed for another publisher key (${manifest.publisher}), not Arena's`);
  if (!Number.isSafeInteger(manifest.sequence) || manifest.sequence < 1) found.push(`sequence is ${JSON.stringify(manifest.sequence)}`);
  for (const key of new Set([...Object.keys(source), ...Object.keys(manifest)])) {
    if (WRITTEN.includes(key)) continue;
    if (stable(manifest[key]) !== stable(source[key])) found.push(`${key} is ${JSON.stringify(manifest[key])}, and ghostly-app.json says ${JSON.stringify(source[key])}`);
  }
  if (!(source.sources ?? []).includes(SOURCE)) found.push(`ghostly-app.json's sources does not name ${SOURCE}`);
  const listed = Array.isArray(manifest.files) ? manifest.files : [];
  const want = files.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: sha256(bytes) }));
  if (stable(listed.map((f) => f.path)) !== stable(want.map((f) => f.path))) {
    found.push(`holds ${listed.map((f) => f.path).join(", ") || "no file"}, not ${want.map((f) => f.path).join(", ")}`);
  } else {
    for (const [i, file] of want.entries()) {
      const got = listed[i];
      if (got.sha256 !== file.sha256 || got.size !== file.size) found.push(`its ${file.path} (${got.size} bytes, ${got.sha256}) is not this build's (${file.size} bytes, ${file.sha256})`);
    }
  }
  return found;
}

/** The store's listing.json for a bundle committed here at `commit`: the copy pinned to that commit first, then HEAD. */
export function listing(manifest, digest, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a full commit`);
  return {
    ref: `${manifest.publisher}/${manifest.name}`,
    sequence: manifest.sequence,
    digest,
    urls: [`https://cdn.jsdelivr.net/gh/${REPO}@${commit}/${BUNDLE}`, SOURCE],
    title: manifest.title,
    tagline: manifest.tagline,
    category: "Games",
    developer: "Ghostly",
    submitter: "Ghostly",
    repo: `https://github.com/${REPO}`,
    support: `https://github.com/${REPO}/issues`,
  };
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const args = process.argv.slice(2);
  const fail = (message) => {
    console.error(message);
    process.exit(1);
  };
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  let files;
  try {
    files = readBundleFiles();
  } catch (error) {
    fail(error.message);
  }
  const source = JSON.parse(readFileSync(resolve(root, "ghostly-app.json"), "utf8"));
  if (args.includes("--expect")) {
    const sequence = Number(value("--expect"));
    const publisher = value("--publisher") ?? PUBLISHER;
    if (!Number.isSafeInteger(sequence) || sequence < 1) fail("--expect takes the sequence the bundle will be signed under");
    if (!publisher) fail("--expect needs --publisher <key> until PUBLISHER in scripts/bundle.mjs is set");
    console.log(`Arena ${source.version} of this build, signed by ${publisher} as sequence ${sequence}, has digest ${digestOf(expected(source, files, sequence, publisher))}`);
    return;
  }
  const file = resolve(args.find((a, i) => !a.startsWith("--") && !["--expect", "--publisher"].includes(args[i - 1])) ?? resolve(root, BUNDLE));
  if (!existsSync(file)) fail(`no ${file}: sign the staged folder first (docs/PUBLISHING.md)`);
  const { manifest, digest } = readManifest(readFileSync(file));
  const found = problems(manifest, source, files);
  console.log(`${file}: ${manifest.name} ${manifest.version}, sequence ${manifest.sequence}, publisher ${manifest.publisher}, digest ${digest}`);
  if (PUBLISHER === null) console.log("PUBLISHER in scripts/bundle.mjs is not set yet: the publisher key was not compared");
  if (found.length) fail(found.map((p) => `problem: ${p}`).join("\n"));
  console.log("it is this checkout's build (the signature is for ghostly app verify to check)");
  if (!args.includes("--listing")) return;
  if (file !== resolve(root, BUNDLE)) fail(`--listing is for ${BUNDLE} at the repository root`);
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--", BUNDLE)) fail(`${BUNDLE} is not committed as it is: commit it first, the listing pins its commit`);
  const commit = git("log", "-1", "--format=%H", "--", BUNDLE);
  if (!commit) fail(`${BUNDLE} is not committed: commit it first, the listing pins its commit`);
  console.log(`\nlisting.json (the commit must be pushed to ${REPO}'s main before the store's check reads it):\n`);
  console.log(JSON.stringify(listing(manifest, digest, commit), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

// Prints the SHA-256 of each file the bundle will hold, in base64url: the form a signed bundle's manifest lists them in
// (`files[].sha256`), so a build can be checked against a published version with `ghostly app verify`. Also the total,
// against the 16 MiB a bundle may hold (exit 1 past it).
import { createHash } from "node:crypto";
import { BUNDLE_LIMIT, readBundleFiles } from "./files.mjs";

let total = 0;
for (const { path, bytes } of readBundleFiles()) {
  total += bytes.length;
  console.log(`${path} ${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("base64url")}`);
}
console.log(`total ${total} bytes of files, ${(total / 1024 / 1024).toFixed(2)} MiB of the 16 MiB a bundle may hold`);
if (total > BUNDLE_LIMIT) process.exit(1);

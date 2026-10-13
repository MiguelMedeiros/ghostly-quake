# Publishing a version of Arena

A version of Arena is published in three places, in this order:

1. **This repository** holds the signed bundle, `app.ghostlyapp`, at its root. The manifest's `sources` names it.
2. **The Ghostly store** ([ghostly-store](https://github.com/MiguelMedeiros/ghostly-store)) holds Arena's
   `listing.json`: the version (`sequence` and `digest`) and the URLs clients fetch it from.
3. **The store's signed index** names that listing. An Arena installed from the store updates only to the version the
   signed index lists (WISP 1200, Updates and rollback), so nothing reaches people before step 3.

Only the holder of Arena's publisher key can sign a version: Ghostly refuses an update signed by another key. The key
is never in this repository, in a pull request, in CI or in a chat. Everything up to "Sign" can be done by anyone and
is checked by CI; "Sign" and the store's index are the owner's steps.

| | |
|---|---|
| Manifest `name` | `arena` (the app's reference is `<publisher key>/arena`: it can never change after the first signature) |
| Publisher key file (owner's machine only) | `~/ghostly-keys/arena-publisher.key`, made by the first `ghostly app publish`. **Back it up**: an app is updated only with the key that signed it |
| Store folder | `apps/arena.<first 16 characters of the publisher key>/` |
| Published so far | 1.0.0 (sequence 1). See [CHANGES.md](../CHANGES.md) |

The bundle is about 14 MiB (`npm run digest`): the page, `game/engine.wasm.gz`, `game/arena.pk3` and `icon.png`. It is
under the 16 MiB a bundle may hold and the 20 MB jsDelivr serves.

## 1. Prepare the version (a pull request)

1. Raise `version` in `ghostly-app.json`, `package.json` and `package-lock.json` (`npm version <x.y.z>
   --no-git-tag-version` does the last two; `test/version.test.ts` fails when they differ). A version that changes the
   engine (`engine/`) or the data (`data/`) raises at least the minor version: both sides must run the same ones.
   Write `releaseNotes` in `ghostly-app.json`: one line, at most 500 characters.
2. Add the version to [CHANGES.md](../CHANGES.md).
3. Run everything:

   ```sh
   npm ci
   npm run typecheck
   npm test
   npx playwright install chromium webkit   # once
   npm run test:browser
   npm run gen:data -- --check
   lockf -k /tmp/ghostly-heavy.lock npm run engine -- --check   # needs Docker; CI's engine job runs it too
   ```

4. Tick every item of the README's [Checked by hand](../README.md#checked-by-hand), with the client versions.
5. Merge it. The commit on `main` is the one that is built and signed.

## 2. Build and stage

On the commit to publish, with a clean tree:

```sh
git switch main && git pull && git status --short     # nothing listed
npm ci && npm test && npm run build
npm run digest                    # each file's size and SHA-256, and the total
npm run stage                     # release/: index.html, game/, icon.png, ghostly-app.json
```

The build is reproducible: the digests `npm run digest` prints are the ones CI printed for that commit (the "Typecheck,
test, build" job's summary, and its `arena-dist` artifact). If they differ, stop.

`ghostly app publish` takes every file in the folder it is given, folders included, so it is run on `release/`,
never on the repository. `release/` is ignored by git.

## 3. Sign (the owner)

The Ghostly CLI must know the manifest's `view` (1.2.2 or later on npm, `@ghostlytools/cli`, does).

The first version makes the publisher key and is sequence 1:

```sh
ghostly app publish release --key ~/ghostly-keys/arena-publisher.key --out app.ghostlyapp --sequence 1 --pretty
chmod 600 ~/ghostly-keys/arena-publisher.key
ghostly app verify app.ghostlyapp --pretty
npm run check:bundle
```

Later versions leave `--sequence` out: `publish` reads the bundle at `--out`, raises its sequence by one, and refuses
when the key is not the one that signed it.

Check, before going on:

- `ghostly app verify` says `"valid": true`, `"ref": "<publisher key>/arena"`, the version and the sequence.
- `npm run check:bundle` says the bundle is this checkout's build: its files are `dist/` and `assets/icon.png` byte for
  byte, and its manifest says what `ghostly-app.json` says.
- The first time only, `publish` said `"keyCreated": true`. Copy the key it printed (`ref` before `/arena`) into
  `PUBLISHER` in `scripts/bundle.mjs`, and back the key file up. On later versions it must not say `keyCreated`: if it
  does, the key file's path was wrong; delete the new file and the bundle, and sign again with the right path.

A sequence is never signed twice.

## 4. Commit the bundle here

The bundle goes in a commit of its own, straight after the commit it was built from:

```sh
git add app.ghostlyapp scripts/bundle.mjs      # scripts/bundle.mjs only the first time (PUBLISHER)
git commit -m "Arena 1.0.0 (sequence 1)"
git push origin main
npm run check:bundle -- --listing     # prints the store's listing.json, pinned to that commit
```

Once it is pushed, both URLs of the listing answer (`raw.githubusercontent.com` caches `HEAD` for 5 minutes):

```sh
ghostly app verify https://raw.githubusercontent.com/MiguelMedeiros/ghostly-quake/HEAD/app.ghostlyapp
ghostly app verify https://cdn.jsdelivr.net/gh/MiguelMedeiros/ghostly-quake@<the commit>/app.ghostlyapp
```

## 5. List it in the store, and sign the index (the owner)

In a clone of [ghostly-store](https://github.com/MiguelMedeiros/ghostly-store), on a branch:

1. Write `apps/arena.<first 16 characters of the key>/listing.json` with what `npm run check:bundle -- --listing`
   printed (the jsDelivr URL pinned to the commit first, then `HEAD`).
2. Build and sign the index, in the same pull request:

   ```sh
   npm ci
   npm run build-index -- --out /tmp/ghostly-store.draft.json
   ghostly store sign /tmp/ghostly-store.draft.json --key ~/ghostly-keys/store.key --out .
   scripts/check.sh                                  # "The store is valid."
   git add apps/arena.* ghostly-store.json ghostly-store.sig
   git commit -m "Arena 1.0.0 (sequence 1)"
   ```

3. Open the pull request; its check fetches both URLs and verifies the bundle. Merge when it is green.

## Revoking a version

`ghostly app revoke . --key ~/ghostly-keys/arena-publisher.key --up-to <sequence>` (or `--digest <digest>`) writes
`ghostly-revoke.json` beside `app.ghostlyapp`. Commit it here, copy it to the store's folder for Arena, and sign the
index.

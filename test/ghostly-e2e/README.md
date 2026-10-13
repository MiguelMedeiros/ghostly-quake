# Arena in Ghostly's own end-to-end suite

Two specs for a checkout of [Ghostly](https://github.com/MiguelMedeiros/ghostly) (`dev`), copied here because they run
there, not here (they use its fixtures, its headless CLI and its builds). They sign a staged Arena with throwaway keys
made in a temporary folder, list it in a store signed the same way, and serve both at `raw.githubusercontent.com` URLs
from the test process: nothing leaves the machine, and no real key is touched.

```sh
# here
npm run build && npm run stage -- /tmp/arena-release
# in a Ghostly checkout
cp <this folder>/web-apps-arena.spec.ts e2e/web/apps-arena.spec.ts
ARENA_RELEASE=/tmp/arena-release ARENA_SHOTS=/tmp/arena-shots npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/apps-arena.spec.ts

cp <this folder>/desktop-macos-apps-arena.spec.ts e2e/desktop-macos/apps-arena.spec.ts
VITE_APPS_TEST=1 npm run desktop:macos:build
ARENA_RELEASE=/tmp/arena-release npx playwright test -c e2e/playwright.desktop-macos.config.ts e2e/desktop-macos/apps-arena.spec.ts
```

- **Web** (`web-apps-arena.spec.ts`): Ana installs Arena from the store, opens it in her chat with Bob; Bob installs it
  from her card; Ana hosts Solstice, Bob joins; both move and fire for 14 s; screenshots go to `ARENA_SHOTS`.
- **Desktop on macOS** (`desktop-macos-apps-arena.spec.ts`): two copies of the debug app (WKWebView), paired over a
  local Pkarr relay, both install Arena, open it in their chat (an `app-*` window each), A hosts and B joins. The debug
  build must be made with `VITE_APPS_TEST=1`, so its store fetcher reads the test's local server.

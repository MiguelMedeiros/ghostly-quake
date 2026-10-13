/**
 * Arena, a Ghostly mini-app: a deathmatch for two in a chat, on FTEQW with LibreQuake's data. The runner gives it
 * `window.ghostly` (the broker, src/vendor/miniApp.ts). Opened outside the runner (`npm run dev`), it runs alone on a
 * stand-in broker that reads the game files from the dev server.
 *
 * One side hosts: its engine runs the server and its own client; the contact's engine connects to it over the chat
 * (src/link.ts). The session (src/session.ts) decides who hosts and when a match ends.
 */
import { appConfig, DEFAULT_SETTINGS, hostCommands, joinCommands, leaveCommands, readSettings, settingsCommands, type Settings, startupScript } from "./config.ts";
import { Engine, type EngineFiles } from "./engine.ts";
import { EdgeTurn } from "./input.ts";
import { Link } from "./link.ts";
import { isTerms, type MapId, type MatchTerms } from "./protocol.ts";
import { Session } from "./session.ts";
import { fill, pickLanguage, stringsFor } from "./strings.ts";
import { Ui, type ViewModel } from "./ui.ts";
import { compatible } from "./version.ts";
import type { MiniAppApi, MiniAppJson } from "./vendor/miniApp.ts";
import "./style.css";

/** A broker that keeps nothing and reads the bundle's files from the dev server, for `vite` in a browser tab. */
function standIn(): MiniAppApi {
  const store = new Map<string, MiniAppJson>();
  return {
    context: async () => ({ version: "dev", inChat: false, peer: null }),
    file: async (path) => {
      const response = await fetch(`/${path}`);
      if (!response.ok) throw new Error("no-file");
      return response.arrayBuffer();
    },
    storage: {
      get: async (key) => store.get(key),
      set: async (key, value) => void store.set(key, value),
      delete: async (key) => void store.delete(key),
      keys: async () => [...store.keys()],
    },
    chat: { send: async () => Promise.reject(new Error("not-allowed")), on: () => () => {} },
    close: async () => {},
  };
}

const SETTINGS_KEY = "settings";
const TERMS_KEY = "terms";

async function main(): Promise<void> {
  const root = document.getElementById("app")!;
  const api = (window as { ghostly?: MiniAppApi }).ghostly ?? standIn();

  const link = new Link({ send: (frame) => api.chat.send(frame as unknown as MiniAppJson) });
  const engine = new Engine();
  let files: Promise<EngineFiles> | null = null;
  let booting: Promise<void> | null = null;
  let walking = false;
  let settings: Settings = DEFAULT_SETTINGS;
  let peerIncompatible = false;
  let myVersion = "";

  const view = (): ViewModel => ({
    phase,
    error,
    inChat,
    state: session.state,
    peer: session.peer,
    peerState: session.peerState,
    peerIncompatible,
    lastEnd: session.lastEnd,
    walking,
    engineStarting: booting !== null && !engine.running,
    settings,
    terms,
    stats: "",
  });
  const render = () => ui?.render(view());

  // Listening starts before anything is awaited (Session's constructor), so no frame from the contact is missed.
  const session = new Session(api, {
    state: () => render(),
    peer: (peer) => {
      peerIncompatible = peer !== null && myVersion !== "" && !compatible(myVersion, peer.version);
      render();
    },
    host: (match, terms) => void play(() => {
      link.start(match);
      engine.command(hostCommands(terms));
    }),
    join: (match) => void play(() => {
      link.start(match);
      engine.command(joinCommands());
    }),
    stop: () => {
      link.stop();
      engine.command(leaveCommands());
      render();
    },
    link: (frame) => link.receive(frame),
  });

  let phase: ViewModel["phase"] = "loading";
  let error: string | undefined;
  let inChat = false;
  let terms: MatchTerms = { map: "lqdm1", fraglimit: 10, timelimit: 10 };
  let ui: Ui | null = null;

  const context = await api.context();
  inChat = context.inChat;
  myVersion = context.version;
  const dark = context.theme ? context.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const language = pickLanguage(context.locale ?? navigator.language);
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  const strings = stringsFor(language);
  document.title = strings.title;

  try {
    settings = readSettings(await api.storage.get(SETTINGS_KEY));
    const kept = await api.storage.get(TERMS_KEY);
    if (isTerms(kept)) terms = kept;
  } catch {
    // Storage refused: the defaults stand.
  }

  ui = new Ui(root, strings, {
    host: (t) => {
      terms = t;
      void api.storage.set(TERMS_KEY, t as unknown as MiniAppJson).catch(() => {});
      session.lastEnd = null;
      session.host(t);
    },
    walk: (map: MapId) => {
      terms = { ...terms, map };
      walking = true;
      session.lastEnd = null;
      void play(() => engine.command(["disconnect", "set deathmatch 3", "set maxclients 1", `map ${map}`]));
    },
    join: () => {
      session.lastEnd = null;
      session.join();
    },
    decline: () => session.leave(),
    leave: () => {
      if (walking) {
        walking = false;
        engine.command(leaveCommands());
        render();
        return;
      }
      session.leave();
    },
    settings: (next) => {
      settings = next;
      engine.command(settingsCommands(next));
      void api.storage.set(SETTINGS_KEY, next as unknown as MiniAppJson).catch(() => {});
      render();
    },
  });

  // While the lobby covers the game, keys belong to the lobby: the engine listens on the window too.
  for (const type of ["keydown", "keyup", "keypress"]) {
    window.addEventListener(type, (event) => {
      if (ui!.lobbyShown) event.stopImmediatePropagation();
    }, true);
  }
  const edge = new EdgeTurn(ui.canvas, () => ({ speed: settings.edgeTurn, sensitivity: settings.sensitivity }));

  // The game files are read at once, so a match starts without waiting for them.
  files = Promise.all([api.file("game/engine.wasm.gz"), api.file("game/arena.pk3")]).then(([wasmGz, pk3]) => ({ wasmGz, pk3 }));
  files.then(
    () => {
      phase = "ready";
      render();
    },
    (e: unknown) => {
      phase = "failed";
      error = e instanceof Error ? e.message : String(e);
      render();
    },
  );
  render();
  await session.start();

  /** Boots the engine the first time, then runs `then` (the match's commands). */
  async function play(then: () => void): Promise<void> {
    try {
      if (!booting) {
        booting = (async () => {
          const loaded = await files!;
          render();
          const colour = session.state.kind === "playing" && !session.state.host ? 13 : 4;
          await engine.boot(ui!.canvas, loaded, { rc: startupScript(), cfg: appConfig(settings, context.name ?? "", colour) }, {
            net: { open: (s) => link.open(s), send: (p) => link.send(p), close: (s) => link.close(s) },
            onMouseLook: (on) => edge.setActive(on),
            onQuit: () => void api.close(),
          });
        })();
      }
      await booting;
      then();
      render();
      ui!.canvas.focus();
    } catch (e) {
      phase = "failed";
      error = e instanceof Error ? e.message : String(e);
      render();
    }
  }

  // The link's numbers, once a second.
  let frames = 0;
  let lastBytes = 0;
  const count = () => {
    frames++;
    requestAnimationFrame(count);
  };
  requestAnimationFrame(count);
  setInterval(() => {
    const bytes = link.stats.bytesIn + link.stats.bytesOut;
    const kbps = Math.round((bytes - lastBytes) / 102.4) / 10;
    lastBytes = bytes;
    const rtt = link.stats.srtt === null ? "–" : String(Math.round(link.stats.srtt));
    ui!.setStats(link.current ? fill(strings.stats, { rtt, fps: frames, kbps }) : `${frames} fps`);
    frames = 0;
  }, 1000);
}

void main();

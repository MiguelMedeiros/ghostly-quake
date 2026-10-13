/**
 * The engine, FTEQW compiled to WebAssembly (engine/dist, built by scripts/engine.mjs). Its JavaScript glue is not part
 * of this module: the build puts it in the page as a script of its own, ahead of this one, wrapped in
 * `window.ghostlyFte(Module)` (vite.config.ts), because the runner allows only the entry's own scripts and no eval.
 *
 * The engine gets every byte from the app: the wasm (the bundle's `game/engine.wasm.gz`, inflated here), the game
 * data (`game/arena.pk3`) and two small scripts the app writes, quake.rc and ghostly.cfg. Its network is the chat
 * pipe of src/link.ts, and anything else it tries to reach fails in the patched glue.
 */
import { gunzipSync } from "fflate";
import type { EngineSocket } from "./link.ts";

/** What `window.ghostlyFte` returns once the glue has set the engine going. */
export interface FteHandle {
  /** Types console commands into the engine. */
  cbuf(text: string): void;
  /** The engine takes commands (its video is up, which is when it hands the page its command callback). */
  ready(): boolean;
}

/** The emscripten Module the glue reads (only what Arena sets). */
export interface FteModule {
  canvas: HTMLCanvasElement;
  wasmBinary: ArrayBuffer;
  files: Record<string, ArrayBuffer>;
  arguments: string[];
  relativeMouse: boolean;
  onMouseLook(on: boolean): void;
  ghostlyNet: { open(socket: EngineSocket, protocol: string): void; send(packet: Uint8Array): void; close(socket: EngineSocket): void };
  print(text: string): void;
  printErr(text: string): void;
  setStatus(text: string): void;
  close(): void;
  postRun: (() => void)[];
}

declare global {
  interface Window {
    ghostlyFte?: (module: FteModule) => FteHandle;
  }
}

export interface EngineFiles {
  /** The bundle's game/engine.wasm.gz. */
  wasmGz: ArrayBuffer;
  /** The bundle's game/arena.pk3. */
  pk3: ArrayBuffer;
}

export interface EngineHooks {
  net: FteModule["ghostlyNet"];
  onMouseLook(on: boolean): void;
  /** The engine quit (its menu's Quit): it cannot start again in this page. */
  onQuit(): void;
  /** A line the engine printed. */
  onPrint?(line: string): void;
}

const ascii = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

export class Engine {
  private handle: FteHandle | null = null;

  /** Starts the engine and resolves once its main loop runs. */
  async boot(canvas: HTMLCanvasElement, files: EngineFiles, scripts: { rc: string; cfg: string }, hooks: EngineHooks): Promise<void> {
    const start = window.ghostlyFte;
    if (!start) throw new Error("the engine's glue is missing from the page");
    const wasm = gunzipSync(new Uint8Array(files.wasmGz));
    await new Promise<void>((resolve) => {
      this.handle = start({
        canvas,
        wasmBinary: wasm.buffer as ArrayBuffer,
        files: {
          "id1/arena.pk3": files.pk3,
          "id1/quake.rc": ascii(scripts.rc),
          "id1/ghostly.cfg": ascii(scripts.cfg),
        },
        arguments: ["-nohome", "-quake"],
        relativeMouse: true,
        onMouseLook: hooks.onMouseLook,
        ghostlyNet: hooks.net,
        print: (line) => hooks.onPrint?.(line),
        printErr: (line) => hooks.onPrint?.(line),
        setStatus: () => {},
        close: hooks.onQuit,
        postRun: [resolve],
      });
    });
    // The engine finishes starting in its first frames: commands typed before then would be lost.
    const handle = this.handle!;
    for (let waited = 0; !handle.ready(); waited += 50) {
      if (waited > 30_000) throw new Error("the engine did not start");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  get running(): boolean {
    return this.handle !== null;
  }

  /** Console commands, one a line. */
  command(lines: string[]): void {
    if (!this.handle || lines.length === 0) return;
    this.handle.cbuf(`${lines.join("\n")}\n`);
  }
}

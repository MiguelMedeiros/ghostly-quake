/**
 * The page around the engine: the lobby (host a match, the contact's invitation, settings, controls, credits) and,
 * while a match runs, a thin bar over the game with the match, the link's numbers and Leave. Every text a contact or
 * the client gives is set as text, never as markup.
 */
import { type Settings } from "./config.ts";
import { FRAG_LIMITS, MAP_IDS, type MapId, type MatchTerms, TIME_LIMITS } from "./protocol.ts";
import type { EndReason, SessionState } from "./session.ts";
import { type Strings, fill } from "./strings.ts";

/** LibreQuake's names for the maps the app carries (scripts/data.mjs). */
export const MAP_NAMES: Record<MapId, string> = {
  lqdm1: "Solstice",
  lqdm2: "Torture Pit",
  lqdm4: "Psychofuge",
  lqdm6: "Ghost Quarter",
  lqdm7: "Boomstick Basement",
  lqdm8: "Alichar Sector",
  lqdm10: "Lucifer's Gambit",
  lqdm11: "The Wicked Night",
  lqdm12: "Javelin",
  lqdm13: "Death Provides No Return",
};

export const SOURCE_URL = "https://github.com/MiguelMedeiros/ghostly-quake";

export interface ViewModel {
  phase: "loading" | "failed" | "ready";
  error?: string;
  inChat: boolean;
  state: SessionState;
  peer: { version: string } | null;
  peerState: "lobby" | "hosting" | "playing" | null;
  /** The contact's version cannot play with this one. */
  peerIncompatible: boolean;
  lastEnd: EndReason | null;
  /** Walking a map alone (no match). */
  walking: boolean;
  engineStarting: boolean;
  settings: Settings;
  terms: MatchTerms;
  stats: string;
}

export interface UiActions {
  host(terms: MatchTerms): void;
  walk(map: MapId): void;
  join(): void;
  decline(): void;
  leave(): void;
  settings(settings: Settings): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function select<T extends string | number>(label: string, values: readonly T[], current: T, text: (v: T) => string, onChange: (v: T) => void): HTMLLabelElement {
  const box = el("select");
  for (const value of values) box.append(el("option", { value: String(value), textContent: text(value), selected: value === current }));
  box.addEventListener("change", () => onChange(values.find((v) => String(v) === box.value)!));
  return el("label", { className: "field" }, el("span", { textContent: label }), box);
}

function slider(label: string, min: number, max: number, step: number, value: number, onChange: (v: number) => void): HTMLLabelElement {
  const input = el("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) });
  input.addEventListener("change", () => onChange(Number(input.value)));
  return el("label", { className: "field" }, el("span", { textContent: label }), input);
}

export class Ui {
  readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLElement;
  private readonly bar: HTMLElement;
  private terms: MatchTerms = { map: "lqdm1", fraglimit: 10, timelimit: 10 };
  private model: ViewModel | null = null;

  constructor(
    root: HTMLElement,
    private readonly strings: Strings,
    private readonly actions: UiActions,
  ) {
    this.canvas = el("canvas", { id: "canvas", tabIndex: 0 });
    this.canvas.setAttribute("aria-label", strings.title);
    this.overlay = el("div", { className: "overlay" });
    this.bar = el("div", { className: "bar" });
    root.append(this.canvas, this.bar, this.overlay);
  }

  /** Whether the lobby covers the game (keys then go to the lobby, not the engine). */
  get lobbyShown(): boolean {
    return !this.overlay.hidden;
  }

  render(model: ViewModel): void {
    this.model = model;
    this.terms = model.terms;
    const s = this.strings;
    const inGame = model.phase === "ready" && (model.walking || model.state.kind === "hosting" || model.state.kind === "playing");
    document.body.classList.toggle("in-game", inGame);
    this.overlay.hidden = inGame;
    this.bar.hidden = !inGame;
    this.renderBar(model);
    if (inGame) return;

    const panel = el("main", { className: "panel" });
    panel.append(el("h1", { textContent: s.title }), el("p", { className: "tagline", textContent: s.tagline }));
    if (model.phase === "loading" || model.engineStarting) {
      panel.append(el("p", { className: "status", textContent: model.engineStarting ? s.loadingEngine : s.loading }));
      this.overlay.replaceChildren(panel);
      return;
    }
    if (model.phase === "failed") {
      panel.append(el("p", { className: "status error", textContent: fill(s.failed, { error: model.error ?? "" }) }));
      this.overlay.replaceChildren(panel);
      return;
    }
    if (matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches) {
      panel.append(el("p", { className: "notice", textContent: s.needsKeyboard }));
    }
    if (model.lastEnd) panel.append(el("p", { className: "notice", textContent: s[`ended_${model.lastEnd}`] }));

    if (model.inChat) {
      const peerText = model.peerIncompatible
        ? fill(s.peerVersion, { version: model.peer?.version ?? "" })
        : !model.peer
          ? s.waitingPeer
          : model.peerState === "hosting"
            ? s.peerHosting
            : model.peerState === "playing"
              ? s.peerPlaying
              : s.peerHere;
      panel.append(el("p", { className: `status${model.peer && !model.peerIncompatible ? " online" : ""}`, textContent: peerText }));
    } else {
      panel.append(el("p", { className: "status", textContent: s.alone }));
    }

    if (model.state.kind === "invited" && !model.peerIncompatible) {
      const { terms } = model.state;
      const card = el("section", { className: "invitation" });
      card.append(
        el("p", { textContent: fill(s.invitation, { map: MAP_NAMES[terms.map], frags: terms.fraglimit, minutes: terms.timelimit }) }),
        el("div", { className: "actions" }, this.button(s.join, () => this.actions.join(), "primary"), this.button(s.decline, () => this.actions.decline())),
      );
      panel.append(card);
    }

    const form = el("section", { className: "host" });
    form.append(
      select(s.map, MAP_IDS, this.terms.map, (m) => MAP_NAMES[m], (map) => (this.terms = { ...this.terms, map })),
      el(
        "div",
        { className: "row" },
        select(s.frags, FRAG_LIMITS, this.terms.fraglimit, String, (fraglimit) => (this.terms = { ...this.terms, fraglimit })),
        select(s.minutes, TIME_LIMITS, this.terms.timelimit, (n) => fill(s.minutesValue, { n }), (timelimit) => (this.terms = { ...this.terms, timelimit })),
      ),
    );
    const canHost = model.inChat && !model.peerIncompatible;
    form.append(
      el(
        "div",
        { className: "actions" },
        ...(canHost ? [this.button(s.host, () => this.actions.host(this.terms), "primary")] : []),
        this.button(s.walk, () => this.actions.walk(this.terms.map)),
      ),
    );
    panel.append(form);

    const settings = model.settings;
    const change = (patch: Partial<Settings>) => this.actions.settings({ ...settings, ...patch });
    const invert = el("input", { type: "checkbox", checked: settings.invertMouse });
    invert.addEventListener("change", () => change({ invertMouse: invert.checked }));
    panel.append(
      el(
        "details",
        { className: "settings" },
        el("summary", { textContent: s.settings }),
        slider(s.sensitivity, 1, 20, 0.5, settings.sensitivity, (sensitivity) => change({ sensitivity })),
        slider(s.edgeTurn, 0, 360, 15, settings.edgeTurn, (edgeTurn) => change({ edgeTurn })),
        slider(s.volume, 0, 1, 0.05, settings.volume, (volume) => change({ volume })),
        el("label", { className: "check" }, invert, el("span", { textContent: s.invert })),
      ),
      el("details", { className: "controls" }, el("summary", { textContent: s.controls }), el("p", { textContent: s.controlsText })),
      el("footer", {}, el("p", { textContent: s.credits }), el("p", { textContent: `${s.source}: ${SOURCE_URL}` })),
    );
    this.overlay.replaceChildren(panel);
  }

  private renderBar(model: ViewModel): void {
    const s = this.strings;
    const state = model.state;
    const label =
      state.kind === "hosting" ? s.hosting : state.kind === "playing" ? fill(s.playing, { map: MAP_NAMES[state.terms.map] }) : MAP_NAMES[this.terms.map];
    this.bar.replaceChildren(
      el("span", { className: "label", textContent: label }),
      el("span", { className: "stats", textContent: model.stats }),
      this.button(s.leave, () => this.actions.leave()),
    );
  }

  /** The link's numbers, refreshed in place each second. */
  setStats(text: string): void {
    if (this.model) this.model.stats = text;
    const stats = this.bar.querySelector(".stats");
    if (stats) stats.textContent = text;
  }

  private button(text: string, onClick: () => void, kind = ""): HTMLButtonElement {
    const button = el("button", { type: "button", textContent: text, className: kind });
    button.addEventListener("click", onClick);
    return button;
  }
}

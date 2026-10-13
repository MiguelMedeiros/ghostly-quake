/**
 * Who hosts, who joins, and when a match ends, between the two sides of one chat. The engine and the page react to
 * the session's state; the session itself only exchanges frames (src/protocol.ts) and calls its listeners.
 *
 * One side hosts: it sends `host` with the terms and starts its server at once, so it can look around while it waits.
 * The other side sees the invitation and joins: it sends `join` and its engine connects. If both host at the same time,
 * the match with the lower id is kept and the other side joins it by itself. A side that leaves sends `leave`; when the
 * contact leaves, or closes the app, the match ends on this side too.
 */
import { type Frame, type MatchTerms, PROTOCOL, newMatchId, readFrame } from "./protocol.ts";
import type { MiniAppApi, MiniAppJson, MiniAppPeerEvent } from "./vendor/miniApp.ts";

export type SessionState =
  | { kind: "lobby" }
  | { kind: "hosting"; match: string; terms: MatchTerms }
  | { kind: "invited"; match: string; terms: MatchTerms }
  | { kind: "playing"; match: string; terms: MatchTerms; host: boolean };

/** Why the last match ended on this side, for the lobby's notice. */
export type EndReason = "left" | "contact-left" | "contact-closed" | "offline";

export interface SessionEvents {
  /** The state changed. */
  state(state: SessionState): void;
  /** Start the server for this match (this side hosts). */
  host(match: string, terms: MatchTerms): void;
  /** Connect to the contact's server for this match. */
  join(match: string, terms: MatchTerms): void;
  /** Stop playing: leave the server, or close it. */
  stop(reason: EndReason): void;
  /** A frame for the link (net, ping, pong). */
  link(frame: Frame): void;
  /** The contact's app opened or closed, or its version changed. */
  peer(peer: { version: string } | null): void;
}

export class Session {
  state: SessionState = { kind: "lobby" };
  peer: { version: string } | null = null;
  /** The contact's own state, from its last hello. */
  peerState: "lobby" | "hosting" | "playing" | null = null;
  lastEnd: EndReason | null = null;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(
    private readonly api: MiniAppApi,
    private readonly events: SessionEvents,
    private readonly makeId: () => string = () => newMatchId(),
  ) {
    // Listening starts here, before anything is awaited, so no frame is missed.
    this.unsubscribe.push(api.chat.on("message", (data: MiniAppJson) => this.onFrame(data)));
    this.unsubscribe.push(api.chat.on("peer", (event: MiniAppPeerEvent) => this.onPeer(event)));
  }

  /** Reads whether the contact has the app open already, and says hello. */
  async start(): Promise<void> {
    const context = await this.api.context();
    if (context.peer) this.onPeer({ open: true, version: context.peer.version });
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
  }

  /** This side hosts a match on these terms. */
  host(terms: MatchTerms): void {
    if (this.state.kind === "playing" || this.state.kind === "hosting") return;
    const match = this.makeId();
    // Invited already: the rule for two hosts at once decides now, since the contact will not send its match again.
    if (this.state.kind === "invited" && this.state.match < match) {
      this.join();
      return;
    }
    this.setState({ kind: "hosting", match, terms });
    this.events.host(match, terms);
    this.sendHost();
  }

  /** This side joins the match it was invited to. */
  join(): void {
    if (this.state.kind !== "invited") return;
    const { match, terms } = this.state;
    this.setState({ kind: "playing", match, terms, host: false });
    this.events.join(match, terms);
    void this.send({ t: "join", v: PROTOCOL, match });
  }

  /** This side leaves the match it hosts or plays (or turns down an invitation). */
  leave(): void {
    const state = this.state;
    if (state.kind === "lobby") return;
    if (state.kind === "invited") {
      this.setState({ kind: "lobby" });
      return;
    }
    void this.send({ t: "leave", v: PROTOCOL, match: state.match });
    this.end("left");
  }

  private end(reason: EndReason): void {
    this.lastEnd = reason;
    this.setState({ kind: "lobby" });
    this.events.stop(reason);
  }

  /** The contact left this side's match: the server stays, and the contact is invited again. */
  private hostAgain(state: { match: string; terms: MatchTerms }): void {
    this.setState({ kind: "hosting", match: state.match, terms: state.terms });
    this.sendHost();
  }

  private setState(state: SessionState): void {
    this.state = state;
    this.events.state(state);
    if (this.peer) void this.sendHello();
  }

  private sendHost(): void {
    if (this.state.kind === "hosting" || (this.state.kind === "playing" && this.state.host)) {
      void this.send({ t: "host", v: PROTOCOL, match: this.state.match, terms: this.state.terms });
    }
  }

  private sendHello(): Promise<void> {
    const state = this.state;
    const mine = state.kind === "hosting" ? "hosting" : state.kind === "playing" ? "playing" : "lobby";
    return this.send({ t: "hello", v: PROTOCOL, state: mine, ...(state.kind !== "lobby" && state.kind !== "invited" && { match: state.match }) });
  }

  private async send(frame: Frame): Promise<void> {
    try {
      await this.api.chat.send(frame as unknown as MiniAppJson);
    } catch {
      // Not live, or the peer closed: the peer event says so, and the next open says hello again.
    }
  }

  private onPeer(event: MiniAppPeerEvent): void {
    if (event.open) {
      const first = this.peer === null;
      this.peer = { version: event.version };
      this.events.peer(this.peer);
      if (first) {
        void this.sendHello();
        this.sendHost();
      }
      return;
    }
    this.peer = null;
    this.peerState = null;
    this.events.peer(null);
    const state = this.state;
    // A host keeps its server while the contact is away: the contact can join again when it comes back.
    if (state.kind === "invited") this.setState({ kind: "lobby" });
    else if (state.kind === "playing" && state.host) this.hostAgain(state);
    else if (state.kind === "playing") this.end("contact-closed");
  }

  private onFrame(data: MiniAppJson): void {
    const frame = readFrame(data);
    if (!frame) return;
    const state = this.state;
    switch (frame.t) {
      case "hello":
        this.peerState = frame.state;
        // The contact is back in its lobby while this side plays its match: the contact left it.
        if (state.kind === "playing" && frame.state === "lobby") {
          if (state.host) this.hostAgain(state);
          else this.end("contact-left");
        }
        if (state.kind === "invited" && frame.state === "lobby") this.setState({ kind: "lobby" });
        return;
      case "host":
        if (state.kind === "lobby" || state.kind === "invited") {
          this.setState({ kind: "invited", match: frame.match, terms: frame.terms });
        } else if (state.kind === "hosting" && frame.match !== state.match) {
          // Both hosted at once: the lower id is the match.
          if (frame.match < state.match) {
            this.events.stop("left");
            this.setState({ kind: "invited", match: frame.match, terms: frame.terms });
            this.join();
          }
        }
        return;
      case "join":
        if (state.kind === "hosting" && frame.match === state.match) {
          this.setState({ kind: "playing", match: state.match, terms: state.terms, host: true });
        }
        return;
      case "leave":
        if ((state.kind === "playing" || state.kind === "invited") && frame.match === state.match) {
          if (state.kind === "invited") this.setState({ kind: "lobby" });
          else if (state.host) this.hostAgain(state);
          else this.end("contact-left");
        }
        return;
      default:
        this.events.link(frame);
    }
  }
}

/**
 * The engine's network, carried over the chat: FTEQW's socket for `ws://ghostly.invalid/…` (engine/patches) hands its
 * packets here, and they go to the contact's Arena in `net` frames; frames from the contact go back into the socket.
 *
 * The chat allows 48 frames a second per app, and 50 requests a second to the broker for everything the app asks, so
 * packets are not sent one per frame. Packets the engine makes in one go (one engine frame) leave together, in as few
 * frames as fit, at most `rate` frames a second with bursts of `burst`; packets that cannot leave yet wait for the
 * next token. The engine's netcode (QuakeWorld's netchan) resends what it needs, so when the queue grows past what a
 * live game can use the oldest packets are dropped rather than sent late.
 */
import { type Frame, MAX_PACKET_BYTES, PROTOCOL, fromBase64, toBase64 } from "./protocol.ts";

/** The engine's side of the pipe: the socket object the engine's JavaScript keeps (`inq` is read by the engine). */
export interface EngineSocket {
  inq: Uint8Array[];
  err: number;
  con: number;
}

export interface LinkClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LinkOptions {
  /** Sends one frame to the peer (`ghostly.chat.send`). */
  send(frame: Frame): Promise<void>;
  clock?: LinkClock;
  /** Frames a second, on average. */
  rate?: number;
  /** Frames that may leave at once. */
  burst?: number;
  /** The JSON bytes one frame may carry: under the 32 KiB `chat.send` takes, with room for the frame's own keys. */
  frameBytes?: number;
  /** Packets kept waiting at most; past it the oldest are dropped. */
  queuePackets?: number;
  /** Milliseconds between two pings. */
  pingEvery?: number;
}

export interface LinkStats {
  framesOut: number;
  framesIn: number;
  packetsOut: number;
  packetsIn: number;
  bytesOut: number;
  bytesIn: number;
  /** Packets dropped before they left: the queue was full, or the chat refused the frame. */
  dropped: number;
  /** The last round trip over the chat, in milliseconds, and the median of the last few (what the page shows). */
  rtt: number | null;
  srtt: number | null;
  /** Why the last frame did not leave, if one did not. */
  lastError: string | null;
}

const realClock: LinkClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export class Link {
  readonly stats: LinkStats = { framesOut: 0, framesIn: 0, packetsOut: 0, packetsIn: 0, bytesOut: 0, bytesIn: 0, dropped: 0, rtt: null, srtt: null, lastError: null };
  private readonly sendFrame: (frame: Frame) => Promise<void>;
  private readonly clock: LinkClock;
  private readonly rate: number;
  private readonly burst: number;
  private readonly frameBytes: number;
  private readonly queuePackets: number;
  private readonly pingEvery: number;
  private match: string | null = null;
  private socket: EngineSocket | null = null;
  private queue: string[] = [];
  private tokens: number;
  private refilled: number;
  private flushQueued = false;
  private timer: unknown = null;
  private pinger: unknown = null;
  private pingN = 0;
  private parts: string[] = [];
  private rtts: number[] = [];

  constructor(options: LinkOptions) {
    this.sendFrame = options.send;
    this.clock = options.clock ?? realClock;
    this.rate = options.rate ?? 34;
    this.burst = options.burst ?? 4;
    this.frameBytes = options.frameBytes ?? 30 * 1024;
    this.queuePackets = options.queuePackets ?? 256;
    this.pingEvery = options.pingEvery ?? 2000;
    this.tokens = this.burst;
    this.refilled = this.clock.now();
  }

  /** The match whose packets this link carries; packets of any other are dropped. */
  get current(): string | null {
    return this.match;
  }

  start(match: string): void {
    this.stop();
    this.match = match;
    this.pinger = this.clock.setInterval(() => this.ping(), this.pingEvery);
  }

  stop(): void {
    this.match = null;
    this.queue = [];
    this.parts = [];
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    if (this.pinger !== null) this.clock.clearInterval(this.pinger);
    this.timer = this.pinger = null;
  }

  // The engine's side (Module.ghostlyNet).

  open(socket: EngineSocket): void {
    this.socket = socket;
  }

  close(socket: EngineSocket): void {
    if (this.socket === socket) this.socket = null;
  }

  /** A packet from the engine. */
  send(packet: Uint8Array): void {
    if (this.match === null || packet.length === 0 || packet.length > MAX_PACKET_BYTES) return;
    this.queue.push(toBase64(packet));
    if (this.queue.length > this.queuePackets) {
      const extra = this.queue.length - this.queuePackets;
      this.queue.splice(0, extra);
      this.stats.dropped += extra;
    }
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => {
        this.flushQueued = false;
        this.flush();
      });
    }
  }

  // The chat's side.

  /** A frame from the peer, already checked by readFrame. Answers pings; hands packets of the current match to the engine. */
  receive(frame: Frame): void {
    if (frame.t === "ping") {
      void this.deliver({ t: "pong", v: PROTOCOL, n: frame.n, at: frame.at });
      return;
    }
    if (frame.t === "pong") {
      const rtt = this.clock.now() - frame.at;
      if (rtt >= 0 && rtt < 60_000) {
        this.stats.rtt = rtt;
        this.rtts = [...this.rtts.slice(-4), rtt];
        const sorted = [...this.rtts].sort((a, b) => a - b);
        this.stats.srtt = sorted[Math.floor(sorted.length / 2)]!;
      }
      return;
    }
    if (frame.t !== "net" || frame.match !== this.match) return;
    this.stats.framesIn++;
    if (frame.part) {
      const [index, count] = frame.part;
      if (index !== this.parts.length) {
        this.parts = [];
        if (index !== 0) return;
      }
      this.parts.push(frame.p[0]!);
      if (this.parts.length < count) return;
      const whole = this.parts.map(fromBase64);
      this.parts = [];
      const length = whole.reduce((n, b) => n + b.length, 0);
      if (length > MAX_PACKET_BYTES) return;
      const packet = new Uint8Array(length);
      let at = 0;
      for (const b of whole) {
        packet.set(b, at);
        at += b.length;
      }
      this.push(packet);
      return;
    }
    for (const p of frame.p) this.push(fromBase64(p));
  }

  private push(packet: Uint8Array): void {
    this.stats.packetsIn++;
    this.stats.bytesIn += packet.length;
    if (this.socket) this.socket.inq.push(packet);
  }

  private refill(): void {
    const now = this.clock.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.refilled) * this.rate) / 1000);
    this.refilled = now;
  }

  /** Sends what waits, in as few frames as fit, while there are tokens; waits for the next token otherwise. */
  flush(): void {
    if (this.match === null) return;
    this.refill();
    while (this.queue.length && this.tokens >= 1) {
      const match = this.match;
      const first = this.queue[0]!;
      const empty = JSON.stringify({ t: "net", v: PROTOCOL, match, p: [] }).length;
      if (empty + first.length + 2 > this.frameBytes) {
        // One packet larger than a frame: it travels in parts, each a frame.
        const size = this.frameBytes - empty - 32;
        const chunk = size - (size % 4);
        const raw = fromBase64(this.queue.shift()!);
        const pieces: string[] = [];
        const rawChunk = (chunk / 4) * 3;
        for (let at = 0; at < raw.length; at += rawChunk) pieces.push(toBase64(raw.subarray(at, at + rawChunk)));
        pieces.forEach((piece, index) => this.emit({ t: "net", v: PROTOCOL, match, p: [piece], part: [index, pieces.length] }, index === 0 ? 1 : 0));
        this.tokens -= pieces.length;
        continue;
      }
      const packets: string[] = [];
      let bytes = empty;
      while (this.queue.length && bytes + this.queue[0]!.length + 3 <= this.frameBytes && packets.length < 64) {
        const next = this.queue.shift()!;
        bytes += next.length + 3;
        packets.push(next);
      }
      this.tokens -= 1;
      this.emit({ t: "net", v: PROTOCOL, match, p: packets }, packets.length);
    }
    if (this.queue.length && this.timer === null) {
      const wait = Math.max(1, Math.ceil(((1 - this.tokens) * 1000) / this.rate));
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        this.flush();
      }, wait);
    }
  }

  private emit(frame: Frame & { t: "net" }, packets: number): void {
    this.stats.framesOut++;
    this.stats.packetsOut += packets;
    for (const p of frame.p) this.stats.bytesOut += (p.length * 3) / 4;
    this.sendFrame(frame).then(
      () => (this.stats.lastError = null),
      (error: unknown) => {
        this.stats.dropped += packets;
        this.stats.lastError = error instanceof Error ? error.message : String(error);
      },
    );
  }

  private ping(): void {
    void this.deliver({ t: "ping", v: PROTOCOL, n: ++this.pingN, at: this.clock.now() });
  }

  /** A control frame (ping, pong): it takes a token when one is there, and goes anyway, since it is rare. */
  private async deliver(frame: Frame): Promise<void> {
    this.refill();
    this.tokens -= 1;
    try {
      await this.sendFrame(frame);
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : String(error);
    }
  }
}

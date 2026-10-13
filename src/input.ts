/**
 * Mouse look. A click in the game asks for the pointer lock, as FTEQW does on the web, and with it the mouse turns the
 * view as in any shooter (Esc gives it back). A Ghostly from before 2026-10-13 refuses the lock in its sandbox: there
 * the patched engine glue reads each mousemove's movementX/Y while the game wants the mouse (engine/patches), and,
 * since a pointer cannot pass the frame's edge, this keeps turning the view while it rests at the left or right edge,
 * by sending the engine the movement it would have had: `speed` degrees a second, at the person's sensitivity.
 */

/** The share of the frame's width, at each side, where the view keeps turning. */
export const EDGE = 0.06;
/** Degrees per mouse count at sensitivity 1: the engine's m_yaw. */
export const M_YAW = 0.022;

/** -1 at the left edge, 1 at the right edge, 0 elsewhere. */
export function edgeOf(x: number, width: number): -1 | 0 | 1 {
  if (width <= 0) return 0;
  if (x <= width * EDGE) return -1;
  if (x >= width * (1 - EDGE)) return 1;
  return 0;
}

/** The mouse counts that turn the view `degreesPerSecond` for `ms` milliseconds at this sensitivity. */
export function edgeCounts(degreesPerSecond: number, ms: number, sensitivity: number): number {
  if (sensitivity <= 0) return 0;
  return (degreesPerSecond * (ms / 1000)) / (sensitivity * M_YAW);
}

export class EdgeTurn {
  private active = false;
  private side: -1 | 0 | 1 = 0;
  private last = 0;
  private frame = 0;
  private remainder = 0;

  constructor(
    private readonly target: HTMLElement,
    private readonly settings: () => { speed: number; sensitivity: number },
  ) {
    target.addEventListener("mousemove", (event) => {
      if (event.isTrusted) this.side = edgeOf(event.clientX - target.getBoundingClientRect().left, target.clientWidth);
    });
    target.addEventListener("mouseleave", () => (this.side = 0));
    window.addEventListener("blur", () => (this.side = 0));
  }

  /** The engine wants the mouse (in game) or not (a menu, the console). */
  setActive(active: boolean): void {
    this.active = active;
    this.target.style.cursor = active ? "none" : "";
    if (!active) this.side = 0;
    if (active && !this.frame) {
      this.last = performance.now();
      this.frame = requestAnimationFrame((t) => this.tick(t));
    }
  }

  private tick(now: number): void {
    this.frame = 0;
    if (!this.active) return;
    const ms = Math.min(100, now - this.last);
    this.last = now;
    const { speed, sensitivity } = this.settings();
    if (this.side !== 0 && speed > 0 && !document.pointerLockElement) {
      const counts = edgeCounts(speed, ms, sensitivity) * this.side + this.remainder;
      const whole = Math.trunc(counts);
      this.remainder = counts - whole;
      if (whole !== 0) this.target.dispatchEvent(new MouseEvent("mousemove", { movementX: whole, movementY: 0, bubbles: true }));
    }
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }
}

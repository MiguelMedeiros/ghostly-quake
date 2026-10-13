import { describe, expect, it } from "vitest";
import { EDGE, edgeCounts, edgeOf, M_YAW } from "../src/input.ts";

describe("edge turning", () => {
  it("turns only at the left and right edges", () => {
    expect(edgeOf(0, 800)).toBe(-1);
    expect(edgeOf(800 * EDGE, 800)).toBe(-1);
    expect(edgeOf(400, 800)).toBe(0);
    expect(edgeOf(799, 800)).toBe(1);
    expect(edgeOf(10, 0)).toBe(0);
  });

  it("sends the mouse counts that turn the asked degrees a second at the person's sensitivity", () => {
    const counts = edgeCounts(180, 1000, 4);
    expect(counts * 4 * M_YAW).toBeCloseTo(180);
    expect(edgeCounts(180, 500, 4)).toBeCloseTo(counts / 2);
    expect(edgeCounts(180, 16, 0)).toBe(0);
  });
});

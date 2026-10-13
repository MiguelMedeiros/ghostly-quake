import { defineConfig } from "vitest/config";

/**
 * Locally, at most JOBS workers (default 2), so a test run leaves the machine usable. CI keeps Vitest's default.
 * `vitest --maxWorkers=<n>` still wins over this.
 */
const maxWorkers = process.env.CI ? undefined : Math.max(1, Number(process.env.JOBS) || 2);

export default defineConfig({
  test: { maxWorkers, include: ["test/**/*.test.ts"] },
});

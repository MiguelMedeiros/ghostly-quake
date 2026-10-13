/**
 * Real-browser checks of the built app (test/browser/*.spec.ts): two sides of one chat, each in a sandboxed frame
 * under the web runner's CSP, play a match over a test broker. Run `npm run build` first; `npm run test:browser` does
 * both. WebGL runs on SwiftShader, so no GPU is needed.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  testMatch: "*.spec.ts",
  timeout: 180_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // Each test runs two engines: one test at a time keeps the frame times honest.
  workers: 1,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});

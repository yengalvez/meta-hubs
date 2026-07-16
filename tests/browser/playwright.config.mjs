import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "../../output/playwright/browser-contracts",
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [
    ["list"],
    [
      "json",
      { outputFile: "../../output/playwright/browser-contracts/results.json" },
    ],
  ],
  projects: [
    {
      name: "desktop-chrome",
      use: { channel: "chrome", viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-chrome",
      testMatch: /cold-load\.spec\.mjs/,
      use: { ...devices["Pixel 7"], channel: "chrome" },
    },
  ],
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});

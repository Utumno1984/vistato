import { defineConfig, devices } from "@playwright/test";

import { FAKE_FIC_URL } from "./e2e/helpers/fake-fic/control";
import { FAKE_FIC_CLIENT_ID, FAKE_FIC_CLIENT_SECRET } from "./e2e/helpers/fake-fic/server";

const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Production build, like in deploy. Locally an already running server is reused.
  webServer: {
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    env: {
      // The e2e server runs on http://localhost: the session cookie cannot be Secure there.
      SESSION_COOKIE_SECURE: "false",
      APP_ORIGIN: `http://localhost:${PORT}`,
      // Fatture in Cloud is the fake started by the global setup (fake credentials, not secrets).
      FIC_API_BASE_URL: FAKE_FIC_URL,
      FIC_OAUTH_AUTHORIZE_URL: `${FAKE_FIC_URL}/oauth/authorize`,
      FIC_OAUTH_TOKEN_URL: `${FAKE_FIC_URL}/oauth/token`,
      FIC_OAUTH_REVOKE_URL: `${FAKE_FIC_URL}/oauth/revoke`,
      FIC_CLIENT_ID: FAKE_FIC_CLIENT_ID,
      FIC_CLIENT_SECRET: FAKE_FIC_CLIENT_SECRET,
      FIC_REDIRECT_URI: `http://localhost:${PORT}/api/integrations/fic/callback`,
    },
    timeout: 180_000,
  },
});

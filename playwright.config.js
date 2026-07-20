const { defineConfig } = require('@playwright/test');
const path = require('path');

const backendDir = path.join(__dirname, 'backend');
require(require.resolve('dotenv', { paths: [backendDir] })).config({
  path: path.join(backendDir, '.env')
});

const port = Number(process.env.E2E_PORT || 3100);
const baseURL = `http://127.0.0.1:${port}`;

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45000,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'list',
  globalSetup: require.resolve('./tests/e2e/global-setup'),
  globalTeardown: require.resolve('./tests/e2e/global-teardown'),
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  webServer: {
    command: 'node backend/server.js',
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    env: {
      ...process.env,
      PORT: String(port),
      BASE_URL: baseURL,
      FRONTEND_URL: baseURL,
      NODE_ENV: 'test',
      DISABLE_AUTOMATIONS: 'true'
    }
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]
});

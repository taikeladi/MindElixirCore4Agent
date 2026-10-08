import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.ts', timeout: 30000,
  workers: 1, fullyParallel: false, reporter: 'list',
  outputDir: './test-results',
  use: { ...devices['Desktop Chrome'], channel: process.env.MEC_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), baseURL: 'http://127.0.0.1:23335', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'node personal/server.mjs --port 23335',
    cwd: resolve(import.meta.dirname, '..'),
    url: 'http://127.0.0.1:23335/api/health', reuseExistingServer: false,
    env: { MINDMAP_DATA_DIR: resolve(tmpdir(), `mec-browser-test-${process.pid}-${Date.now()}`) },
  },
})

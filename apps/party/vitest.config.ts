import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 30_000,
    // Request logs are noise in test output; failures still show assertion details.
    onConsoleLog: (msg) => !msg.includes('[party'),
  },
})

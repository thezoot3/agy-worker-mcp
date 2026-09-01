import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Real-agy verification (`docs/05-live-verification.md`). Kept in its own
 * config so `npm test` can never pick these up and spend quota: the default
 * config's `include` is `test/**\/*.test.ts`, and every file here is
 * `*.live.ts`.
 */
function jsToTsResolver() {
  return {
    name: 'agy-worker-js-to-ts',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      if (!importer) return null
      if (!source.startsWith('.') || !source.endsWith('.js')) return null
      const candidate = resolve(dirname(importer), source.slice(0, -3) + '.ts')
      return existsSync(candidate) ? candidate : null
    },
  }
}

export default defineConfig({
  plugins: [jsToTsResolver()],
  test: {
    environment: 'node',
    include: ['test/live/**/*.live.ts'],
    // A real model round trip is slow and must never be raced.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: 'forks',
    fileParallelism: false,
    maxConcurrency: 1,
    globals: false,
  },
})

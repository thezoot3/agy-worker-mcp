import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * NodeNext-style `./foo.js` specifiers point at `./foo.ts` on disk. Vite already
 * does this rewrite for most cases; this plugin makes it deterministic so a
 * Vite version bump cannot silently break every test import.
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
    include: ['test/**/*.test.ts'],
    // agy round trips and process-group kills are slow; unit tests stay fast.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Detached runners + SQLite locks make parallel file-level isolation fragile.
    pool: 'forks',
    globals: false,
  },
})

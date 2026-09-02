import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import type { ToolContext } from './context.js'
import { createContext } from './context.js'
import { registerAllTools } from './tools/index.js'
import { SERVER_INSTRUCTIONS } from './instructions.js'

/**
 * The stdio MCP server. One process per connected client (`docs/01` 결정 1) —
 * there is no daemon and no shared broker; coordination happens entirely through
 * the project SQLite database and the job directories.
 *
 * Capabilities are `{ tools: {} }` only. No resources, no prompts.
 */

export interface CreateServerOptions {
  ctx: ToolContext
  version: string
}

/** Build the server and register the nine tools. */
export function createServer(opts: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: 'agy-worker-mcp', version: opts.version },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  )
  // What the client declared at `initialize`. The SDK only fills these in once
  // the handshake completed, so read them per call rather than snapshotting at
  // construction time.
  opts.ctx.getClient = () => {
    const impl = server.server.getClientVersion()
    const caps = server.server.getClientCapabilities()
    if (!impl && !caps) return null
    return {
      name: impl?.name ?? null,
      version: impl?.version ?? null,
      capabilities: caps ? (caps as Record<string, unknown>) : null,
    }
  }

  registerAllTools(server, opts.ctx)
  return server
}

/** `dist/server.js` entry point. Connects a `StdioServerTransport` and stays up. */
export async function main(): Promise<void> {
  const ctx = createContext()
  const server = createServer({ ctx, version: ctx.version })

  let shuttingDown = false
  const handleSignal = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    shutdown(ctx)
    process.exit(0)
  }
  process.on('SIGINT', handleSignal)
  process.on('SIGTERM', handleSignal)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

/** Close the store and flush state. Registered on SIGINT/SIGTERM. */
export function shutdown(ctx: ToolContext): void {
  try {
    ctx.store.close()
  } catch {
    // best effort — the process is exiting either way
  }
}

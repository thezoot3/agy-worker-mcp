/**
 * `agy_capabilities.client` — what the connected MCP client declared.
 *
 * A caller deciding how to wait on a long job needs to know whether *this*
 * connection negotiated the protocol's optional background-task feature, and
 * that is a per-client fact the server can only learn at `initialize`. These
 * tests drive the real `createServer` over a linked in-memory transport, so
 * what comes back is the SDK's own view of the handshake, not a stub.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyEnv, makeProject, type TestProject } from './helpers.js'

let project: TestProject

beforeEach(() => {
  project = makeProject()
  applyEnv(project, 'happy')
})

afterEach(() => {
  delete process.env.AGY_FAKE_SCENARIO
})

async function capabilitiesVia(clientCapabilities: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { createContext } = await import('../../src/server/context.js')
  const { createServer } = await import('../../src/server/server.js')

  const ctx = createContext()
  const server = createServer({ ctx, version: ctx.version })
  const client = new Client({ name: 'test-client', version: '1.2.3' }, { capabilities: clientCapabilities })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const res = (await client.callTool({ name: 'agy_capabilities', arguments: {} })) as {
      content: Array<{ text: string }>
    }
    return JSON.parse(res.content[0]!.text) as Record<string, unknown>
  } finally {
    await client.close()
    await server.close()
    ctx.store.close()
  }
}

describe('agy_capabilities reports the connected client', () => {
  it('carries the client name, version, and its declared capabilities', async () => {
    const caps = await capabilitiesVia({})
    expect(caps.client).toEqual({ name: 'test-client', version: '1.2.3', capabilities: {} })
  })

  it('shows a negotiated optional feature — the answer to "can this client take a background task"', async () => {
    const caps = await capabilitiesVia({ tasks: {} })
    expect((caps.client as { capabilities: Record<string, unknown> }).capabilities).toHaveProperty('tasks')
  })

  it('is null when the handlers are driven with no client attached', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const { handleCapabilities } = await import('../../src/server/tools/capabilities.js')

    const ctx = createContext()
    try {
      const reply = await handleCapabilities(ctx, {})
      expect(JSON.parse(reply.content[0]!.text).client).toBeNull()
    } finally {
      ctx.store.close()
    }
  })
})

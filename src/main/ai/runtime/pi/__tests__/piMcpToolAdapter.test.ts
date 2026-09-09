import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import type { McpServer as McpServerEntity } from '@shared/data/types/mcpServer'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  refreshTools: vi.fn()
}))

vi.mock('@application', () => ({
  application: { get: () => ({ refreshTools: mocks.refreshTools }) }
}))
vi.mock('@data/services/McpServerService', () => ({
  mcpServerService: { findByIdOrName: vi.fn() }
}))

const { buildMcpToolDefinitions } = await import('../piMcpToolAdapter')

// The adapter's execute never reads the pi-only execution context; a stub satisfies the signature.
const stubCtx = {} as ExtensionContext

function createServer(tools: Tool[]): McpServer {
  const server = new McpServer({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: 'ok' }] as CallToolResult['content']
  }))
  return server
}

const slowTool: Tool = {
  name: 'slow-tool',
  description: 'a slow tool',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } }
}

// The call options live client-side and never reach the wire, so the only observable
// seam is Client.prototype.callTool's third argument.
function spyCallTool(result: Partial<CallToolResult> = { content: [{ type: 'text', text: 'ok' }] }) {
  return vi.spyOn(Client.prototype, 'callTool').mockResolvedValue(result as CallToolResult)
}

async function buildSingleServerBridge(config?: McpServerEntity) {
  return buildMcpToolDefinitions({
    'srv-1': { name: 'srv-1', instance: createServer([slowTool]), ...(config ? { config } : {}) }
  })
}

const abort = new AbortController().signal

describe('buildMcpToolDefinitions call options', () => {
  it('passes the configured per-server timeout to client.callTool', async () => {
    const spy = spyCallTool()
    const bridge = await buildSingleServerBridge({ timeout: 180 } as McpServerEntity)
    await bridge.tools[0].execute('call-1', { value: 'x' }, abort, undefined, stubCtx)

    const options = spy.mock.calls[0][2]
    expect(options).toMatchObject({ timeout: 180_000, resetTimeoutOnProgress: false })
    expect(options?.onprogress).toBeUndefined()
    expect(options?.signal).toBe(abort)
  })

  it('enables progress-based extension with a progress handler for long-running servers', async () => {
    const spy = spyCallTool()
    const bridge = await buildSingleServerBridge({ timeout: 180, longRunning: true } as McpServerEntity)
    await bridge.tools[0].execute('call-1', { value: 'x' }, abort, undefined, stubCtx)

    const options = spy.mock.calls[0][2]
    expect(options).toMatchObject({
      timeout: 180_000,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: 10 * 60 * 1000
    })
    // The handler must exist so the SDK attaches a progressToken; the bridge relays
    // upstream progress into it to keep resetting the timer.
    expect(options?.onprogress).toBeTypeOf('function')
  })

  it('keeps the 60s default for servers without a config (built-ins)', async () => {
    const spy = spyCallTool()
    const bridge = await buildSingleServerBridge(undefined)
    await bridge.tools[0].execute('call-1', { value: 'x' }, abort, undefined, stubCtx)

    const options = spy.mock.calls[0][2]
    expect(options).toMatchObject({ timeout: 60_000, resetTimeoutOnProgress: false })
    expect(options?.maxTotalTimeout).toBeUndefined()
    expect(options?.onprogress).toBeUndefined()
  })
})

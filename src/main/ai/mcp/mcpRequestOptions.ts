import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'

/** The slice of per-server config that governs tool-call timeouts. */
export interface McpCallPolicy {
  /** User-configured timeout in seconds; falls back to the SDK's 60s default. */
  timeout?: number
  /** Long Running Mode: progress notifications reset the timer, up to a 10min ceiling. */
  longRunning?: boolean
}

/**
 * Derive MCP SDK RequestOptions from per-server user config.
 * Single source of truth — consumed by McpRuntimeService and the Pi/dsh session bridges,
 * so the three call paths can never drift on timeout policy again (#20266).
 */
export function resolveMcpRequestOptions(policy?: McpCallPolicy): RequestOptions {
  return {
    timeout: policy?.timeout ? policy.timeout * 1000 : 60_000,
    resetTimeoutOnProgress: policy?.longRunning ?? false,
    maxTotalTimeout: policy?.longRunning ? 10 * 60 * 1000 : undefined
  }
}

/**
 * Build the full client.callTool options for a per-server policy, shared by the session
 * bridges. The no-op onprogress exists only to make the SDK attach a progressToken so
 * resetTimeoutOnProgress can work — the MCP bridge relays upstream progress into it.
 */
export function buildMcpCallOptions(policy: McpCallPolicy | undefined, signal?: AbortSignal): RequestOptions {
  const options = resolveMcpRequestOptions(policy)
  return {
    signal,
    ...options,
    onprogress: options.resetTimeoutOnProgress ? () => {} : undefined
  }
}

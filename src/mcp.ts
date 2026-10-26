import { gatewayURL, type Gateway } from './gateway.js'

export const MCP_NAME = 'fleet-litellm'

export type RemoteMcpConfig = {
  type: 'remote'
  url: string
  headers: { 'x-litellm-api-key': string }
  oauth: false
  enabled?: boolean
  disabled?: boolean
}

export function remoteMcpConfig(gateway: Gateway, v2: boolean): RemoteMcpConfig {
  return {
    type: 'remote',
    url: gatewayURL(gateway.baseURL, 'mcp'),
    headers: { 'x-litellm-api-key': `Bearer ${gateway.apiKey}` },
    oauth: false,
    ...(v2 ? { disabled: false } : { enabled: true }),
  }
}

export function sameMcpConfig(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const left = a as Partial<RemoteMcpConfig>; const right = b as Partial<RemoteMcpConfig>
  return left.type === 'remote' && right.type === 'remote' && left.url === right.url
    && left.headers?.['x-litellm-api-key'] === right.headers?.['x-litellm-api-key']
}

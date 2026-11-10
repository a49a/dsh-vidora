import type { AgentLike } from '../services/privacy.js'

export interface ContentBlock {
  type: 'text'
  text: string
}

export interface ToolExecutionLike {
  signal: AbortSignal
  agent?: AgentLike
}

export interface ToolCallPresentation {
  card: 'generic'
  title: string
  kind?: 'read' | 'edit' | 'other'
  rawInput?: unknown
  locations?: Array<{ path: string; line?: number }>
}

export interface JsonSchemaNode {
  type?: string
  description?: string
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode
  enum?: Array<string | number>
  additionalProperties?: boolean
  oneOf?: JsonSchemaNode[]
  minimum?: number
  maximum?: number
  default?: unknown
}

export interface VidoraToolDefinition {
  name: string
  description: string
  parameters: JsonSchemaNode
  output: {
    schema: JsonSchemaNode
    render(args: Record<string, unknown>, value: Record<string, unknown>): ContentBlock[]
  }
  presentCall?(args: Record<string, unknown>): ToolCallPresentation | undefined
  execute(args: Record<string, unknown>, exec: ToolExecutionLike): Promise<Record<string, unknown>>
}

export interface ToolRegistrationOptions {
  when?(context: {
    agent: unknown
    modelSelection: { provider: string; model: string; reasoningEffort?: string }
    signal: AbortSignal
  }): boolean | Promise<boolean>
}

export interface ToolGuardContext {
  name: string
  arguments: unknown
  agent?: AgentLike
}

export interface ToolRegistryLike {
  register(definition: VidoraToolDefinition, options?: ToolRegistrationOptions): () => void
  guard?(guard: (execution: ToolGuardContext) => string | undefined): () => void
}

export interface LlmLike {
  stream(options: unknown): AsyncIterable<unknown>
  listProviders?(): Array<{ id: string; name: string }>
}

export interface PluginContextLike {
  tools: ToolRegistryLike
  effect?(callback: () => (() => unknown) | Promise<() => unknown>): unknown
  inject?(dependencies: string[], callback: (ctx: PluginContextLike) => unknown): unknown
  llm?: LlmLike
  logger?(name: string): {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
    debug(message: string): void
  }
}

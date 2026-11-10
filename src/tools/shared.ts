import type { JsonSchemaNode } from './types.js'
import { formatClock } from '../core/time.js'

export function obj(
  properties: Record<string, JsonSchemaNode>,
  required: string[] = [],
): JsonSchemaNode {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }
}

export function str(description: string, extra: Partial<JsonSchemaNode> = {}): JsonSchemaNode {
  return { type: 'string', description, ...extra }
}

export function num(description: string, extra: Partial<JsonSchemaNode> = {}): JsonSchemaNode {
  return { type: 'number', description, ...extra }
}

export function int(description: string, extra: Partial<JsonSchemaNode> = {}): JsonSchemaNode {
  return { type: 'integer', description, ...extra }
}

export function bool(description: string, extra: Partial<JsonSchemaNode> = {}): JsonSchemaNode {
  return { type: 'boolean', description, ...extra }
}

export function enumStr(description: string, values: string[], extra: Partial<JsonSchemaNode> = {}): JsonSchemaNode {
  return { type: 'string', description, enum: values, ...extra }
}

export function arr(description: string, items: JsonSchemaNode): JsonSchemaNode {
  return { type: 'array', description, items }
}

export function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function taskStatusLine(task: {
  id: string
  status: string
  stage: string
  progress: { processed_ms: number; total_ms: number; completed_chunks: number; total_chunks: number }
}): string {
  const percent = task.progress.total_ms > 0
    ? Math.min(100, Math.round((task.progress.processed_ms / task.progress.total_ms) * 100))
    : 0
  const chunks = task.progress.total_chunks > 0
    ? `${task.progress.completed_chunks}/${task.progress.total_chunks} 段`
    : '尚未分段'
  return `${task.id} · ${task.status} · ${task.stage} · ${percent}% · ${formatClock(task.progress.processed_ms)}/${task.progress.total_ms > 0 ? formatClock(task.progress.total_ms) : '未知'} · ${chunks}`
}

export function privacyFooter(strictLocal: boolean, trusted: boolean): string {
  if (!strictLocal) return '严格本地模式：关闭'
  return trusted ? '严格本地模式：当前会话模型已列入本地信任列表' : '严格本地模式：当前会话模型未列入本地信任列表，正文读取工具不可用'
}

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { LlmConfig, PrivacyConfig } from '../config.js'
import type { DocumentLlmInfo } from '../core/types.js'

export interface LocalLlmHealth {
  configured: boolean
  mode: LlmConfig['mode']
  reachable: boolean
  local: boolean
  endpoint: string | null
  models: string[]
  error: string | null
}

export interface LocalLlmCompletionInput {
  system: string
  prompt: string
  signal?: AbortSignal
  maxTokens?: number
}

export interface LocalLlmClient {
  readonly info: DocumentLlmInfo
  completeJson(input: LocalLlmCompletionInput): Promise<unknown>
  health(): Promise<LocalLlmHealth>
}

export class LocalLlmError extends Error {
  readonly code: string
  raw?: string

  constructor(message: string, code = 'LOCAL_LLM_ERROR') {
    super(message)
    this.name = 'LocalLlmError'
    this.code = code
  }
}

export interface HarnessLlmLike {
  stream(options: {
    provider: string
    model: string
    messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>
    system?: string
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
  }): AsyncIterable<{
    type: string
    text?: string
    reason?: { kind?: string; failure?: { message?: string; code?: string } }
  }>
  listProviders?(): Array<{ id: string; name: string }>
}

export function createLocalLlmClient(
  llm: LlmConfig,
  privacy: PrivacyConfig,
  harness?: HarnessLlmLike,
): LocalLlmClient | null {
  if (llm.mode === 'off') return null
  if (llm.mode === 'ollama') return new OllamaClient(llm)
  if (llm.mode === 'openai') return new OpenAiCompatibleClient(llm)
  return new HarnessClient(llm, privacy, harness)
}

export async function checkLocalLlm(
  llm: LlmConfig,
  privacy: PrivacyConfig,
  harness?: HarnessLlmLike,
): Promise<LocalLlmHealth> {
  const client = createLocalLlmClient(llm, privacy, harness)
  if (!client) {
    return {
      configured: false,
      mode: 'off',
      reachable: false,
      local: false,
      endpoint: null,
      models: [],
      error: 'llm.mode is "off"; ASR and export remain available.',
    }
  }
  try {
    return await client.health()
  } catch (error) {
    return {
      configured: true,
      mode: llm.mode,
      reachable: false,
      local: false,
      endpoint: llm.baseUrl || null,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

abstract class HttpJsonClient implements LocalLlmClient {
  abstract readonly info: DocumentLlmInfo

  constructor(
    protected readonly config: LlmConfig,
    protected readonly endpoint: string,
  ) {}

  abstract completeJson(input: LocalLlmCompletionInput): Promise<unknown>
  abstract health(): Promise<LocalLlmHealth>

  protected async requestJson(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      await assertLocalEndpoint(url, this.config.allowNonLoopback)
    } catch (error) {
      throw new LocalLlmError(
        error instanceof Error ? error.message : String(error),
        'LOCAL_LLM_ENDPOINT_BLOCKED',
      )
    }
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await fetch(url, { ...init, signal: combined, redirect: 'error' })
    } catch (error) {
      if (signal?.aborted) throw abortError()
      const cause = (error as { cause?: { code?: string; message?: string } }).cause
      throw new LocalLlmError(
        `无法连接本地 LLM（${url}）：${cause?.message || (error instanceof Error ? error.message : String(error))}`,
        'LOCAL_LLM_UNREACHABLE',
      )
    }
    const text = await response.text()
    if (text.length > 32 * 1024 * 1024) {
      throw new LocalLlmError('本地 LLM 返回内容过大，已拒绝读取', 'LOCAL_LLM_RESPONSE_TOO_LARGE')
    }
    if (!response.ok) {
      // Do not include the response body: some servers echo the prompt, which
      // may contain transcript text. The caller gets a stable status code.
      throw new LocalLlmError(
        `本地 LLM 返回 HTTP ${response.status}`,
        'LOCAL_LLM_HTTP_ERROR',
      )
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new LocalLlmError('本地 LLM 返回了非 JSON 响应', 'LOCAL_LLM_INVALID_JSON')
    }
  }
}

class OllamaClient extends HttpJsonClient {
  readonly info: DocumentLlmInfo

  constructor(config: LlmConfig) {
    super(config, normalizeBaseUrl(config.baseUrl))
    this.info = {
      provider: 'ollama',
      model: config.model || '(未配置)',
      endpoint: this.endpoint,
      local: syntacticLoopback(this.endpoint),
      prompt_version: 'vidora-notes-v1',
    }
  }

  async completeJson(input: LocalLlmCompletionInput): Promise<unknown> {
    if (!this.config.model) {
      throw new LocalLlmError('llm.model 未配置；请先在本机安装并指定 Ollama 模型', 'LOCAL_LLM_NOT_CONFIGURED')
    }
    const payload = {
      model: this.config.model,
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.prompt },
      ],
      options: {
        temperature: this.config.temperature,
        num_predict: input.maxTokens ?? this.config.maxOutputTokens,
      },
    }
    const response = await this.requestJson(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }, input.signal) as { message?: { content?: unknown } }
    const content = response?.message?.content
    if (typeof content !== 'string') {
      throw new LocalLlmError('Ollama 响应缺少 message.content', 'LOCAL_LLM_INVALID_RESPONSE')
    }
    if (process.env.VIDORA_DEBUG_LLM === '1') console.error('[vidora debug] ollama raw:', content.slice(0, 4000))
    return parseJsonObject(content)
  }

  async health(): Promise<LocalLlmHealth> {
    const local = await assertLocalEndpoint(this.endpoint, this.config.allowNonLoopback)
    try {
      const response = await this.requestJson(`${this.endpoint}/api/tags`, { method: 'GET' }) as {
        models?: Array<{ name?: string; model?: string }>
      }
      const models = (response.models ?? [])
        .map(item => item.name || item.model)
        .filter((value): value is string => typeof value === 'string')
        .sort()
      return {
        configured: true,
        mode: 'ollama',
        reachable: true,
        local,
        endpoint: this.endpoint,
        models,
        error: models.length === 0 ? 'Ollama 已运行，但没有已安装模型' : null,
      }
    } catch (error) {
      return {
        configured: true,
        mode: 'ollama',
        reachable: false,
        local,
        endpoint: this.endpoint,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

class OpenAiCompatibleClient extends HttpJsonClient {
  readonly info: DocumentLlmInfo

  constructor(config: LlmConfig) {
    const base = normalizeOpenAiBase(config.baseUrl)
    super(config, base)
    this.info = {
      provider: 'openai-compatible',
      model: config.model || '(未配置)',
      endpoint: this.endpoint,
      local: syntacticLoopback(this.endpoint),
      prompt_version: 'vidora-notes-v1',
    }
  }

  async completeJson(input: LocalLlmCompletionInput): Promise<unknown> {
    if (!this.config.model) {
      throw new LocalLlmError('llm.model 未配置；请指定本地 OpenAI 兼容服务的模型 ID', 'LOCAL_LLM_NOT_CONFIGURED')
    }
    const payload: Record<string, unknown> = {
      model: this.config.model,
      stream: false,
      temperature: this.config.temperature,
      max_tokens: input.maxTokens ?? this.config.maxOutputTokens,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.prompt },
      ],
      response_format: { type: 'json_object' },
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`
    let response: unknown
    try {
      response = await this.requestJson(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }, input.signal)
    } catch (error) {
      if (!(error instanceof LocalLlmError) || !error.message.includes('HTTP 400')) throw error
      delete payload.response_format
      response = await this.requestJson(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }, input.signal)
    }
    const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })
      ?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new LocalLlmError('OpenAI 兼容响应缺少 choices[0].message.content', 'LOCAL_LLM_INVALID_RESPONSE')
    }
    if (process.env.VIDORA_DEBUG_LLM === '1') console.error('[vidora debug] openai raw:', content.slice(0, 4000))
    return parseJsonObject(content)
  }

  async health(): Promise<LocalLlmHealth> {
    const local = await assertLocalEndpoint(this.endpoint, this.config.allowNonLoopback)
    try {
      const response = await this.requestJson(`${this.endpoint}/models`, {
        method: 'GET',
        headers: this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {},
      }) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string; name?: string }> }
      const models = (response.data ?? response.models ?? [])
        .map(item => (item as { id?: string; name?: string }).id ?? (item as { id?: string; name?: string }).name)
        .filter((value): value is string => typeof value === 'string')
        .sort()
      return {
        configured: true,
        mode: 'openai',
        reachable: true,
        local,
        endpoint: this.endpoint,
        models,
        error: models.length === 0 ? '端点已响应，但没有列出模型' : null,
      }
    } catch (error) {
      return {
        configured: true,
        mode: 'openai',
        reachable: false,
        local,
        endpoint: this.endpoint,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

class HarnessClient implements LocalLlmClient {
  readonly info: DocumentLlmInfo

  constructor(
    private readonly config: LlmConfig,
    private readonly privacy: PrivacyConfig,
    private readonly harness?: HarnessLlmLike,
  ) {
    this.info = {
      provider: 'harness',
      model: config.harnessModel || '(未配置)',
      local: privacy.trustedLocalProviders.includes(config.harnessProvider)
        && (
          privacy.trustedLocalModels.length === 0
          || privacy.trustedLocalModels.includes(config.harnessModel)
        ),
      prompt_version: 'vidora-notes-v1',
    }
  }

  async completeJson(input: LocalLlmCompletionInput): Promise<unknown> {
    if (!this.harness) {
      throw new LocalLlmError(
        'Harness LLM 服务不可用；请改用 llm.mode="ollama" 或 "openai"',
        'LOCAL_LLM_NOT_CONFIGURED',
      )
    }
    if (!this.config.harnessProvider || !this.config.harnessModel) {
      throw new LocalLlmError('llm.harnessProvider / llm.harnessModel 未配置', 'LOCAL_LLM_NOT_CONFIGURED')
    }
    if (
      !this.privacy.trustedLocalProviders.includes(this.config.harnessProvider)
      || (
        this.privacy.trustedLocalModels.length > 0
        && !this.privacy.trustedLocalModels.includes(this.config.harnessModel)
      )
    ) {
      throw new LocalLlmError(
        'Harness 模型未列入 privacy.trustedLocalProviders/trustedLocalModels，严格本地模式拒绝发送正文',
        'LOCAL_LLM_UNTRUSTED',
      )
    }
    let text = ''
    try {
      for await (const chunk of this.harness.stream({
        provider: this.config.harnessProvider,
        model: this.config.harnessModel,
        system: input.system,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: input.prompt }],
        }],
        maxTokens: input.maxTokens ?? this.config.maxOutputTokens,
        temperature: this.config.temperature,
        ...(input.signal ? { signal: input.signal } : {}),
      })) {
        if (input.signal?.aborted) throw abortError()
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
        } else if (chunk.type === 'finish') {
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            throw new LocalLlmError(
              chunk.reason.failure?.message || `模型流结束：${chunk.reason.kind}`,
              'LOCAL_LLM_HARNESS_FAILED',
            )
          }
        }
      }
    } catch (error) {
      if (error instanceof LocalLlmError) throw error
      if (input.signal?.aborted) throw abortError()
      throw new LocalLlmError(
        `Harness 本地模型调用失败：${error instanceof Error ? error.message : String(error)}`,
        'LOCAL_LLM_HARNESS_FAILED',
      )
    }
    return parseJsonObject(text)
  }

  async health(): Promise<LocalLlmHealth> {
    const providers = this.harness?.listProviders?.() ?? []
    const trusted = this.privacy.trustedLocalProviders.includes(this.config.harnessProvider)
    const registered = providers.some(provider => provider.id === this.config.harnessProvider)
    return {
      configured: true,
      mode: 'harness',
      reachable: Boolean(this.harness) && registered && trusted,
      local: trusted,
      endpoint: null,
      models: providers.map(provider => provider.id),
      error: !this.harness
        ? 'Harness LLM 服务未挂载'
        : !registered
          ? `provider ${this.config.harnessProvider || '(未配置)'} 未注册`
          : !trusted
            ? 'provider 未列入 privacy.trustedLocalProviders'
            : null,
    }
  }
}

export async function assertLocalEndpoint(urlString: string, allowNonLoopback: boolean): Promise<boolean> {
  let url: URL
  try {
    url = new URL(urlString)
  } catch {
    throw new LocalLlmError(`无效的本地 LLM 地址：${urlString}`, 'LOCAL_LLM_INVALID_ENDPOINT')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LocalLlmError('本地 LLM 只允许 http/https', 'LOCAL_LLM_INVALID_ENDPOINT')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (hostname === 'localhost') {
    addresses = ['127.0.0.1']
  } else if (isIP(hostname)) {
    addresses = [hostname]
  } else {
    try {
      addresses = (await lookup(hostname, { all: true })).map(item => item.address)
    } catch {
      throw new LocalLlmError(`无法解析本地 LLM 主机：${hostname}`, 'LOCAL_LLM_INVALID_ENDPOINT')
    }
  }
  const allLocal = addresses.length > 0 && addresses.every(isLoopbackAddress)
  if (!allLocal && !allowNonLoopback) {
    throw new LocalLlmError(
      `拒绝连接非回环 LLM 端点 ${url.origin}。如确为本地信任服务，请显式设置 llm.allowNonLoopback=true。`,
      'LOCAL_LLM_ENDPOINT_BLOCKED',
    )
  }
  return allLocal
}

function syntacticLoopback(urlString: string): boolean {
  try {
    const hostname = new URL(urlString).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (hostname === 'localhost') return true
    if (hostname === '::1') return true
    if (hostname.startsWith('127.')) return true
    return false
  } catch {
    return false
  }
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
  if (normalized.startsWith('::ffff:127.')) return true
  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number)
    return parts[0] === 127
  }
  return false
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizeOpenAiBase(value: string): string {
  const base = normalizeBaseUrl(value)
  return /\/v1$/i.test(base) ? base : `${base}/v1`
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  try {
    return JSON.parse(unfenced) as unknown
  } catch {
    const start = unfenced.indexOf('{')
    const end = unfenced.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1)) as unknown
      } catch {
        // fall through
      }
    }
    const error = new LocalLlmError('本地 LLM 输出不是有效 JSON', 'LOCAL_LLM_INVALID_JSON')
    error.raw = unfenced.slice(0, 8000)
    throw error
  }
}

function abortError(): LocalLlmError {
  const error = new LocalLlmError('请求已取消', 'ABORTED')
  error.name = 'AbortError'
  return error
}

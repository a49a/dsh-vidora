import type { VidoraConfig } from './config.js'
import { Config } from './config.js'
import { VidoraRuntime } from './services/runtime.js'
import { createVidoraTools } from './tools/index.js'
import type { LlmLike, PluginContextLike } from './tools/types.js'

export { Config, normalizeConfig, defaultDataDir } from './config.js'
export type { VidoraConfig } from './config.js'
export { VidoraRuntime } from './services/runtime.js'
export { DataStore } from './storage/data-store.js'
export { WorkerManager, WorkerError } from './services/worker-manager.js'
export { TaskManager, VidoraTaskError } from './services/task-manager.js'
export { DocumentService, DocumentServiceError } from './services/document-service.js'
export { LocalLlmError, checkLocalLlm, createLocalLlmClient } from './services/local-llm.js'
export { PrivacyPolicy, PrivacyError } from './services/privacy.js'
export { parseTranscript, parseDocument, DataValidationError } from './core/transcript.js'
export { renderDocumentMarkdown, renderTranscriptMarkdown, renderTranscriptTxt } from './core/markdown.js'
export { renderSrt } from './core/srt.js'
export type * from './core/types.js'
export type { VidoraToolDefinition } from './tools/types.js'

export const name = 'vidora'
export const inject = ['tools']

/**
 * Cordis plugin entry point.
 *
 * No Harness package is imported at runtime: the tool objects use the
 * documented raw JSON Schema shape, so an external profile can load this
 * package without resolving second copies of Cordis or dsh-tools.
 */
export function apply(ctx: PluginContextLike, config: VidoraConfig): void {
  const runtime = new VidoraRuntime(config)
  const logger = ctx.logger?.('vidora')

  const register = () => {
    const registrations = createVidoraTools(runtime).map(({ definition, options }) => (
      ctx.tools.register(definition, options)
    ))
    return () => {
      for (const dispose of registrations.reverse()) {
        try {
          dispose()
        } catch {
          // disposal must not mask other cleanup
        }
      }
    }
  }

  if (ctx.effect) {
    ctx.effect(() => {
      void runtime.ready().catch(error => {
        logger?.error(`Vidora initialization failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      const unregister = register()
      const unguard = ctx.tools.guard?.(execution => runtime.privacy.guardToolCall(
        execution.name,
        execution.arguments,
        execution.agent,
      ))
      return async () => {
        unregister()
        unguard?.()
        await runtime.dispose()
      }
    })
  } else {
    void runtime.ready().catch(error => {
      logger?.error(`Vidora initialization failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    register()
    ctx.tools.guard?.(execution => runtime.privacy.guardToolCall(
      execution.name,
      execution.arguments,
      execution.agent,
    ))
  }

  // Harness LLM reuse is optional. It is only ever called when llm.mode is
  // "harness" and the provider is explicitly listed as a trusted local route.
  ctx.inject?.(['llm'], child => {
    runtime.setHarness((child.llm as LlmLike | undefined) ?? null)
    return () => runtime.setHarness(null)
  })
}

export default { name, inject, Config, apply }

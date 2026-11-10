import type { VidoraRuntime } from '../services/runtime.js'
import type { ToolRegistrationOptions, VidoraToolDefinition } from './types.js'
import { createTranscribeTool } from './transcribe.js'
import { createTaskStatusTool } from './task-status.js'
import { createCancelTaskTool } from './cancel-task.js'
import { createGetTranscriptTool } from './get-transcript.js'
import { createGenerateNotesTool } from './generate-notes.js'
import { createGetDocumentTool } from './get-document.js'
import { createExportTool } from './export.js'
import { createListModelsTool } from './list-models.js'

export interface RegisteredTool {
  definition: VidoraToolDefinition
  options?: ToolRegistrationOptions
}

export function createVidoraTools(runtime: VidoraRuntime): RegisteredTool[] {
  const contentReadOptions: ToolRegistrationOptions = {
    when(context) {
      return runtime.privacy.isTrusted(context.modelSelection)
    },
  }
  return [
    { definition: createTranscribeTool(runtime) },
    { definition: createTaskStatusTool(runtime) },
    { definition: createCancelTaskTool(runtime) },
    { definition: createListModelsTool(runtime) },
    { definition: createGetTranscriptTool(runtime), options: contentReadOptions },
    { definition: createGetDocumentTool(runtime), options: contentReadOptions },
    { definition: createGenerateNotesTool(runtime) },
    { definition: createExportTool(runtime) },
  ]
}

import type { VidoraRuntime } from '../services/runtime.js'
import { resolveMediaFile } from '../services/security.js'
import type { VidoraToolDefinition } from './types.js'
import { arr, bool, obj, str, text } from './shared.js'
import { basename } from 'node:path'

export function createTranscribeTool(runtime: VidoraRuntime): VidoraToolDefinition {
  return {
    name: 'vidora_transcribe',
    description: [
      'Create a local Vidora transcription task for an audio/video file (MP3, WAV, FLAC, M4A, MP4, MKV, WebM, ...).',
      'ASR runs entirely on this machine with Qwen3-ASR; no audio or subtitle is uploaded.',
      'By default it waits for the local task to finish and returns metadata only, never transcript text. Set wait=false for a purely asynchronous task.',
      'A local session model (privacy.trustedLocalProviders) is required by the separate content-reading tools.',
    ].join(' '),
    parameters: obj({
      path: { ...str('Absolute or workspace-relative path to a local audio/video file.'), },
      model: str('ASR model id. Defaults to asr.defaultModel (qwen3-asr-0.6b).', {
        enum: ['qwen3-asr-0.6b', 'qwen3-asr-1.7b'],
      }),
      language: str('Language hint: auto (default), zh, en, yue, or another Qwen-supported name.'),
      align: bool('Request Qwen3-ForcedAligner timestamps. Falls back to segment-level timestamps when the aligner is unavailable.'),
      force: bool('Ignore a completed local cache entry and run ASR again.'),
      context: str('Optional domain hint for recognition, e.g. course topic and expected terminology. Never include secrets.'),
      resumeTaskId: str('Resume an interrupted/cancelled task from its last checkpoint instead of starting a new one.'),
      wait: bool('Wait until the task reaches a terminal state (default true). Set false to return immediately and poll vidora_task_status.'),
    }, ['path']),
    output: {
      schema: obj({
        task_id: str('Task id for vidora_task_status.'),
        status: str('queued, running, completed, failed, cancelled, or interrupted.'),
        stage: str('Current stage.'),
        project_id: str('Local Vidora project id.'),
        transcript_id: str('Transcript id, or empty until completed.'),
        transcript_path: str('Local transcript JSON path, or empty.'),
        segment_count: num('Completed segment count, or 0.'),
        detected_language: str('Detected language code, or empty.'),
        processing_ms: num('ASR processing time, or 0.'),
        cached: bool('True when a completed local transcript was reused.'),
        deduplicated: bool('True when an equivalent active task already existed.'),
        source_path: str('Canonical local source path.'),
        source_sha256: str('Content hash used for cache/deduplication.'),
        size_bytes: num('Source bytes.'),
        duration_ms: num('Duration when known.'),
        model: str('ASR model id.'),
        language: str('Language hint.'),
        align: bool('Whether alignment was requested and available.'),
        warnings: arr('Warnings', str('Warning')),
        error_message: str('Failure message, or empty.'),
      }, [
        'task_id', 'status', 'stage', 'project_id', 'transcript_id', 'transcript_path', 'cached',
        'deduplicated', 'source_path', 'source_sha256', 'size_bytes', 'duration_ms', 'model',
        'language', 'align', 'warnings', 'error_message', 'segment_count', 'detected_language',
        'processing_ms',
      ]),
      render(_args, value) {
        const lines: string[] = []
        if (value.cached === true) {
          lines.push(`Vidora 命中本地缓存：${String(value.transcript_id)}`)
          lines.push(`Transcript ID：${String(value.transcript_id)}`)
          lines.push(`来源：${String(value.source_path)}`)
          lines.push(`转写稿：${String(value.transcript_path)}`)
          lines.push(`片段数：${String(value.segment_count)}；识别语言：${String(value.detected_language || value.language)}`)
        } else if (value.status === 'failed') {
          lines.push(`Vidora 任务失败：${String(value.error_message)}`)
          lines.push(`任务：${String(value.task_id)}`)
        } else {
          lines.push(`Vidora 任务：${String(value.task_id)}（${String(value.status)} / ${String(value.stage)}）`)
          lines.push(`来源：${String(value.source_path)}`)
          lines.push(`模型：${String(value.model)}；语言：${String(value.language)}；对齐：${value.align === true ? '是' : '否'}`)
          lines.push(`项目：${String(value.project_id)}`)
          if (value.transcript_id) lines.push(`Transcript ID：${String(value.transcript_id)}`)
          if (value.transcript_path) lines.push(`转写稿：${String(value.transcript_path)}`)
          if (value.status === 'completed') {
            lines.push(`片段数：${String(value.segment_count)}；识别语言：${String(value.detected_language || value.language)}；处理耗时：${String(value.processing_ms)} ms`)
          }
          if (value.status === 'running' || value.status === 'queued') {
            lines.push('ASR 在本地后台运行。使用 vidora_task_status 查询实际进度；任务不会因为切换会话而中断。')
          }
        }
        const warnings = Array.isArray(value.warnings) ? value.warnings : []
        for (const warning of warnings.slice(0, 5)) lines.push(`提示：${String(warning)}`)
        return text(lines.join('\n'))
      },
    },
    presentCall(args) {
      if (typeof args.path !== 'string') return undefined
      return {
        card: 'generic',
        title: `Vidora 转写：${basename(args.path)}`,
        kind: 'read',
        rawInput: args,
        locations: [{ path: args.path }],
      }
    },
    async execute(args, exec) {
      await runtime.ready()
      const path = typeof args.path === 'string' ? args.path : ''
      const media = await resolveMediaFile(path, runtime.config.paths)
      runtime.privacy.addSensitivePath(media.path)
      const result = await runtime.tasks.create({
        media,
        ...(typeof args.model === 'string' ? { model: args.model } : {}),
        ...(typeof args.language === 'string' ? { language: args.language } : {}),
        ...(typeof args.align === 'boolean' ? { align: args.align } : {}),
        ...(typeof args.force === 'boolean' ? { force: args.force } : {}),
        ...(typeof args.context === 'string' ? { context: args.context } : {}),
        ...(typeof args.resumeTaskId === 'string' ? { resumeTaskId: args.resumeTaskId } : {}),
        signal: exec.signal,
      })
      let task = result.task
      if (args.wait !== false && !result.cached) {
        task = await waitForTerminal(runtime, task.id, exec.signal)
      }
      return {
        task_id: task.id,
        status: task.status,
        stage: task.stage,
        project_id: task.project_id,
        transcript_id: task.transcript_id || '',
        transcript_path: task.transcript_path || '',
        segment_count: task.result?.segment_count ?? 0,
        detected_language: task.result?.language ?? '',
        processing_ms: task.result?.processing_ms ?? 0,
        cached: result.cached,
        deduplicated: result.deduplicated,
        source_path: task.source.path,
        source_sha256: task.source.sha256,
        size_bytes: task.source.size_bytes,
        duration_ms: task.source.duration_ms ?? 0,
        model: task.model,
        language: task.params.language,
        align: Boolean(task.aligner),
        warnings: result.warnings,
        error_message: task.error?.message ?? '',
      }
    },
  }
}

async function waitForTerminal(runtime: VidoraRuntime, taskId: string, signal: AbortSignal) {
  const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
  while (true) {
    if (signal.aborted) {
      const error = new Error('工具调用已取消；Vidora 后台任务仍在运行')
      error.name = 'AbortError'
      throw error
    }
    const task = await runtime.tasks.getStatus(taskId)
    if (task && terminal.has(task.status)) return task
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1000))
  }
}

function num(description: string) {
  return { type: 'number', description }
}

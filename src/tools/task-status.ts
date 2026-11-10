import type { VidoraRuntime } from '../services/runtime.js'
import type { VidoraToolDefinition } from './types.js'
import { arr, bool, num, obj, str, text, taskStatusLine } from './shared.js'

export function createTaskStatusTool(runtime: VidoraRuntime): VidoraToolDefinition {
  return {
    name: 'vidora_task_status',
    description: [
      'Query a Vidora local transcription task: stage, real processed audio duration, total duration, chunks, status, and error.',
      'This tool never returns transcript text and is safe to call from a remote Harness model.',
      'Omit taskId to query the most recent task.',
    ].join(' '),
    parameters: obj({
      taskId: str('Task id returned by vidora_transcribe. Omit for the latest task.'),
    }),
    output: {
      schema: obj({
        task_id: str('Task id.'),
        status: str('queued, running, cancelling, completed, failed, cancelled, or interrupted.'),
        stage: str('preparing, decoding, segmenting, transcribing, aligning, or terminal state.'),
        progress_percent: num('Processed audio / total audio, based on real completed work.'),
        processed_ms: num('Processed media milliseconds.'),
        total_ms: num('Total media milliseconds when known.'),
        completed_chunks: num('Completed ASR chunks.'),
        total_chunks: num('Total planned ASR chunks.'),
        source_path: str('Local source path.'),
        project_id: str('Project id.'),
        transcript_id: str('Transcript id, or empty.'),
        transcript_path: str('Transcript JSON path, or empty.'),
        created_at: str('Creation time.'),
        updated_at: str('Last update time.'),
        error_code: str('Error code, or empty.'),
        error_message: str('Error message, or empty.'),
        resumable: bool('Whether a checkpoint can be resumed.'),
        warnings: arr('Warnings', str('Warning')),
        privacy_note: str('Strict-local status note.'),
      }, [
        'task_id', 'status', 'stage', 'progress_percent', 'processed_ms', 'total_ms',
        'completed_chunks', 'total_chunks', 'source_path', 'project_id', 'transcript_id',
        'transcript_path', 'created_at', 'updated_at', 'error_code', 'error_message',
        'resumable', 'warnings', 'privacy_note',
      ]),
      render(_args, value) {
        const lines = [taskStatusLine({
          id: String(value.task_id),
          status: String(value.status),
          stage: String(value.stage),
          progress: {
            processed_ms: Number(value.processed_ms),
            total_ms: Number(value.total_ms),
            completed_chunks: Number(value.completed_chunks),
            total_chunks: Number(value.total_chunks),
          },
        })]
        if (value.transcript_id) lines.push(`Transcript ID：${String(value.transcript_id)}`)
        if (value.transcript_path) lines.push(`转写稿：${String(value.transcript_path)}`)
        if (value.error_message) lines.push(`错误：${String(value.error_code)} ${String(value.error_message)}`)
        if (value.resumable === true) {
          lines.push('该任务保留了检查点。可调用 vidora_transcribe 并传入 resumeTaskId 恢复。')
        }
        const warnings = Array.isArray(value.warnings) ? value.warnings : []
        for (const warning of warnings.slice(0, 4)) lines.push(`提示：${String(warning)}`)
        lines.push(String(value.privacy_note))
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      await runtime.ready()
      const taskId = typeof args.taskId === 'string' && args.taskId.trim() ? args.taskId.trim() : undefined
      const task = await runtime.tasks.getStatus(taskId)
      if (!task) {
        throw new Error(taskId ? `找不到任务：${taskId}` : '还没有 Vidora 任务')
      }
      const percent = task.progress.total_ms > 0
        ? Math.min(100, Math.round((task.progress.processed_ms / task.progress.total_ms) * 100))
        : 0
      return {
        task_id: task.id,
        status: task.status,
        stage: task.stage,
        progress_percent: percent,
        processed_ms: task.progress.processed_ms,
        total_ms: task.progress.total_ms,
        completed_chunks: task.progress.completed_chunks,
        total_chunks: task.progress.total_chunks,
        source_path: task.source.path,
        project_id: task.project_id,
        transcript_id: task.transcript_id,
        transcript_path: task.transcript_path,
        created_at: task.created_at,
        updated_at: task.updated_at,
        error_code: task.error?.code ?? '',
        error_message: task.error?.message ?? '',
        resumable: task.resumable,
        warnings: task.warnings,
        privacy_note: runtime.config.privacy.strictLocal
          ? '严格本地模式：任务元数据可返回；正文不会通过此工具返回。'
          : '严格本地模式已关闭。',
      }
    },
  }
}


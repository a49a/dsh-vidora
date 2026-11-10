import type { VidoraRuntime } from '../services/runtime.js'
import type { VidoraToolDefinition } from './types.js'
import { bool, obj, str, text } from './shared.js'

export function createCancelTaskTool(runtime: VidoraRuntime): VidoraToolDefinition {
  return {
    name: 'vidora_cancel_task',
    description: [
      'Cancel a running or queued Vidora local transcription task.',
      'The worker stops between safe checkpoints; the task remains resumable.',
      'This tool returns metadata only, never transcript text.',
    ].join(' '),
    parameters: obj({
      taskId: str('Task id returned by vidora_transcribe.'),
    }, ['taskId']),
    output: {
      schema: obj({
        task_id: str('Task id.'),
        status: str('Task status after the cancel request.'),
        stage: str('Task stage after the cancel request.'),
        resumable: bool('Whether the checkpoint can be resumed.'),
        message: str('Human-readable result.'),
      }, ['task_id', 'status', 'stage', 'resumable', 'message']),
      render(_args, value) {
        return text(`${String(value.message)}\n${String(value.task_id)} · ${String(value.status)} · ${String(value.stage)}`)
      },
    },
    async execute(args) {
      await runtime.ready()
      const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : ''
      if (!taskId) throw new Error('taskId 必须是非空字符串')
      const task = await runtime.tasks.cancel(taskId)
      return {
        task_id: task.id,
        status: task.status,
        stage: task.stage,
        resumable: task.resumable,
        message: task.status === 'cancelled'
          ? '任务已取消；检查点保留，可恢复。'
          : task.status === 'completed'
            ? '任务已经完成，未执行取消。'
            : `取消请求已提交，当前状态：${task.status}。`,
      }
    },
  }
}

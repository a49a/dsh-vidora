import type { VidoraRuntime } from '../services/runtime.js'
import type { VidoraToolDefinition } from './types.js'
import { arr, bool, num, obj, str, text } from './shared.js'

export function createListModelsTool(runtime: VidoraRuntime): VidoraToolDefinition {
  return {
    name: 'vidora_list_models',
    description: [
      'Report Vidora local readiness: installed Qwen3-ASR/aligner models, device, FFmpeg, Python Worker, local LLM health, and strict-local privacy status.',
      'Also reports whether the current Harness session model is trusted to read transcript/document bodies.',
      'Metadata only; no transcript text is returned. Set probe=true to start the Worker and query device/model status.',
    ].join(' '),
    parameters: obj({
      probe: bool('Start/reuse the Python Worker and query runtime status (may take a few seconds).'),
    }),
    output: {
      schema: obj({
        data_dir: str('Vidora data directory.'),
        models: arr('Model availability', obj({
          id: str('Model id.'),
          role: str('asr or aligner.'),
          installed: bool('Whether the local weights look present.'),
          path: str('Local directory.'),
          bytes: num('Installed bytes.'),
          expected_bytes: num('Approximate download size.'),
          source: str('Trusted upstream repository.'),
          license: str('Model license.'),
        }, ['id', 'role', 'installed', 'path', 'bytes', 'expected_bytes', 'source', 'license'])),
        ffmpeg_version: str('FFmpeg version line, or empty.'),
        python_version: str('Python version line, or empty.'),
        worker_running: bool('Whether the Python Worker is currently running.'),
        worker_pid: num('Worker pid, or 0.'),
        worker_device: str('Device selected by the Worker, or empty.'),
        worker_torch: str('PyTorch version, or empty.'),
        worker_model_loaded: str('Loaded ASR model, or empty.'),
        worker_aligner_loaded: str('Loaded aligner model, or empty.'),
        worker_running_task: str('Running task id, or empty.'),
        worker_queued_tasks: num('Queued task count.'),
        worker_last_error: str('Last Worker error, or empty.'),
        llm_mode: str('off, ollama, openai, or harness.'),
        llm_configured: bool('Whether a local LLM is configured.'),
        llm_reachable: bool('Whether the local LLM endpoint answered.'),
        llm_local: bool('Whether the endpoint/trust assertion is local.'),
        llm_model: str('Configured local model id, or empty.'),
        llm_endpoint: str('Configured endpoint, or empty.'),
        llm_models: arr('Models advertised by the endpoint', str('Model id')),
        llm_error: str('Local LLM health error, or empty.'),
        strict_local: bool('Whether strict local mode is enabled.'),
        untrusted_file_tool_policy: str('block-data-path, block-all, or off.'),
        session_trusted: bool('Whether the current session model may read content.'),
        session_model: str('Current provider/model, or empty.'),
        trusted_providers: arr('Trusted local provider ids', str('Provider')),
        trusted_models: arr('Trusted local model ids', str('Model')),
        setup_hints: arr('Setup hints', str('Hint')),
      }, [
        'data_dir', 'models', 'ffmpeg_version', 'python_version', 'worker_running',
        'worker_pid', 'worker_device', 'worker_torch', 'worker_model_loaded',
        'worker_aligner_loaded', 'worker_running_task', 'worker_queued_tasks',
        'worker_last_error', 'llm_mode', 'llm_configured', 'llm_reachable', 'llm_local',
        'llm_model', 'llm_endpoint', 'llm_models', 'llm_error', 'strict_local',
        'session_trusted', 'session_model', 'trusted_providers', 'trusted_models',
        'setup_hints',
      ]),
      render(_args, value) {
        const lines = [
          `Vidora 本地状态：${String(value.data_dir)}`,
          `FFmpeg：${String(value.ffmpeg_version || '未找到')}`,
          `Python：${String(value.python_version || '未找到')}`,
          `Worker：${value.worker_running === true ? `运行中 pid=${String(value.worker_pid)} 设备=${String(value.worker_device || '未报告')}` : '未运行'}`,
        ]
        const models = Array.isArray(value.models) ? value.models : []
        for (const model of models) {
          const record = model as Record<string, unknown>
          lines.push(`模型 ${String(record.id)}：${record.installed === true ? '已安装' : '未安装'}（${String(record.path)}）`)
        }
        lines.push(`本地 LLM：${String(value.llm_mode)}${value.llm_configured === true ? ` / ${String(value.llm_model)}` : '（未配置）'}${value.llm_reachable === true ? '，可用' : ''}`)
        if (value.llm_error) lines.push(`LLM 状态：${String(value.llm_error)}`)
        lines.push(
          value.strict_local === true
            ? `严格本地：开启；当前会话 ${String(value.session_model || '未记录')} ${value.session_trusted === true ? '已信任' : '不信任（正文工具隐藏）'}`
            : '严格本地：关闭',
        )
        lines.push(`不可信会话文件工具策略：${String(value.untrusted_file_tool_policy)}`)
        const hints = Array.isArray(value.setup_hints) ? value.setup_hints : []
        for (const hint of hints) lines.push(`准备：${String(hint)}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      await runtime.ready()
      const probe = args.probe === true
      const models = await runtime.modelAvailability()
      const llm = await runtime.llmHealth()
      const privacy = runtime.privacyFor(exec.agent)
      let workerRunning = runtime.worker.isRunning()
      let workerStatus: Awaited<ReturnType<typeof runtime.worker.getStatus>> | null = null
      let workerError = ''
      if (probe) {
        try {
          await runtime.worker.ensureStarted()
          workerRunning = true
          workerStatus = await runtime.worker.getStatus()
        } catch (error) {
          workerError = error instanceof Error ? error.message : String(error)
        }
      } else if (workerRunning) {
        try {
          workerStatus = await runtime.worker.getStatus()
        } catch (error) {
          workerError = error instanceof Error ? error.message : String(error)
        }
      }
      const init = runtime.worker.getInitResult()
      const ffmpegVersion = init?.ffmpeg.version ?? await runtime.ffmpegVersion() ?? ''
      const pythonVersion = init?.python_version ?? await runtime.pythonVersion() ?? ''
      const hints: string[] = []
      const missingAsr = models.find(model => model.role === 'asr' && !model.installed)
      if (missingAsr) {
        hints.push(`安装 ${missingAsr.id}：npm run prepare:models -- --model ${missingAsr.id} --yes（来源 ${missingAsr.repo}，约 ${formatBytes(missingAsr.expectedBytes)}）`)
      }
      const missingAligner = models.find(model => model.role === 'aligner' && !model.installed)
      if (missingAligner && runtime.config.asr.align) {
        hints.push(`安装对齐模型：npm run prepare:models -- --model ${missingAligner.id} --yes（来源 ${missingAligner.repo}，约 ${formatBytes(missingAligner.expectedBytes)}）`)
      }
      if (!ffmpegVersion) hints.push('安装 FFmpeg（macOS: brew install ffmpeg；Windows/Linux 使用系统包管理器）')
      if (!llm.configured) hints.push('未配置本地 LLM：设置 llm.mode=ollama/openai/harness 后可生成 AI 讲义；ASR/导出不受影响。')
      if (llm.configured && !llm.reachable) hints.push(`本地 LLM 不可用：${llm.error ?? '请检查端点与模型'}`)
      if (privacy.description.strictLocal && !privacy.trusted) {
        hints.push('当前 Harness 模型未列入 privacy.trustedLocalProviders，因此 vidora_get_transcript / vidora_get_document 被隐藏。')
      }
      return {
        data_dir: runtime.config.dataDir,
        models: models.map(model => ({
          id: model.id,
          role: model.role,
          installed: model.installed,
          path: model.path,
          bytes: model.bytes,
          expected_bytes: model.expectedBytes,
          source: model.repo,
          license: model.license,
        })),
        ffmpeg_version: ffmpegVersion,
        python_version: pythonVersion,
        worker_running: workerRunning,
        worker_pid: workerStatus?.pid ?? runtime.worker.getPid() ?? 0,
        worker_device: workerStatus?.device ?? init?.device.selected ?? '',
        worker_torch: init?.device.torch ?? '',
        worker_model_loaded: workerStatus?.model_loaded ?? init?.model_loaded ?? '',
        worker_aligner_loaded: workerStatus?.aligner_loaded ?? '',
        worker_running_task: workerStatus?.running_task_id ?? '',
        worker_queued_tasks: workerStatus?.queued_tasks ?? 0,
        worker_last_error: workerError || workerStatus?.last_error || '',
        llm_mode: runtime.config.llm.mode,
        llm_configured: llm.configured,
        llm_reachable: llm.reachable,
        llm_local: llm.local,
        llm_model: runtime.config.llm.mode === 'harness'
          ? runtime.config.llm.harnessModel
          : runtime.config.llm.model,
        llm_endpoint: llm.endpoint ?? '',
        llm_models: llm.models,
        llm_error: llm.error ?? '',
        strict_local: runtime.config.privacy.strictLocal,
        untrusted_file_tool_policy: runtime.config.privacy.untrustedFileToolPolicy,
        session_trusted: privacy.trusted,
        session_model: privacy.selection ? `${privacy.selection.provider}/${privacy.selection.model}` : '',
        trusted_providers: runtime.config.privacy.trustedLocalProviders,
        trusted_models: runtime.config.privacy.trustedLocalModels,
        setup_hints: hints,
      }
    },
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${bytes} B`
}

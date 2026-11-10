#!/usr/bin/env node
/**
 * Real local ASR integration test.
 *
 * Runs the actual Python Worker, Qwen3-ASR, FFmpeg, and Qwen3-ForcedAligner.
 * No ASR result is mocked. Requires installed models and the worker venv.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { normalizeConfig } from '../dist/config.js'
import { VidoraRuntime } from '../dist/services/runtime.js'
import { parseTranscript } from '../dist/core/transcript.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const audio = args.find(value => !value.startsWith('-'))
const dataDir = optionValue(args, '--data-dir') || join(root, 'testdata', 'results', `run-${stamp()}`)
const modelsDir = optionValue(args, '--models-dir') || join(homedir(), 'Library', 'Application Support', 'Vidora', 'models')
const device = optionValue(args, '--device') || 'auto'
const model = optionValue(args, '--model') || 'qwen3-asr-0.6b'
const align = !args.includes('--no-align')
const cancelAfterMs = Number(optionValue(args, '--cancel-after-ms') || 0)
const cancelAfterChunks = Number(optionValue(args, '--cancel-after-chunks') || 0)
const resumeAfterCancel = args.includes('--resume')
const crashAfterChunks = Number(optionValue(args, '--crash-after-chunks') || 0)

if (!audio) {
  console.error('用法：node scripts/real-asr-test.mjs /path/to/audio.m4a [--device mps] [--no-align] [--cancel-after-ms 30000]')
  process.exit(2)
}
const input = resolve(audio)
const inputStat = await stat(input)
const config = normalizeConfig({
  dataDir,
  worker: { workerDir: join(root, 'python-worker') },
  asr: { modelsDir, device, align, defaultModel: model },
  tasks: { autoResume: false, progressPersistIntervalMs: 500, keepTempFiles: false },
  paths: { maxDurationMinutes: 180 },
  privacy: { strictLocal: true },
  llm: { mode: 'off' },
})
const runtime = new VidoraRuntime(config)
await runtime.ready()
const started = Date.now()
let result
try {
  const created = await runtime.tasks.create({
    media: { path: input, size: inputStat.size, extension: extname(input) },
    model,
    align,
  })
  console.log(`task=${created.task.id} project=${created.task.project_id} cached=${created.cached}`)
  if (created.cached && created.transcript) {
    await report(created.transcript, created.task, true)
  } else {
    let last = ''
    const deadline = Date.now() + 3 * 60 * 60 * 1000
    let cancelled = false
    let cancelRequested = false
    let crashRequested = false
    while (Date.now() < deadline) {
      await sleep(1000)
      const task = await runtime.tasks.getStatus(created.task.id)
      if (!task) continue
      const line = `${task.status} ${task.stage} ${task.progress.processed_ms}/${task.progress.total_ms} chunks=${task.progress.completed_chunks}/${task.progress.total_chunks}`
      if (line !== last) {
        console.log(line)
        last = line
      }
      const cancelTriggered = (cancelAfterChunks > 0 && task.stage === 'transcribing' && task.progress.completed_chunks >= cancelAfterChunks)
        || (cancelAfterMs > 0 && task.progress.processed_ms >= 1000)
      if (crashAfterChunks > 0 && !crashRequested && task.stage === 'transcribing' && task.progress.completed_chunks >= crashAfterChunks) {
        crashRequested = true
        const pid = runtime.worker.getPid()
        console.log(`killing worker pid=${pid} after ${task.progress.completed_chunks} chunks...`)
        if (pid) process.kill(pid, 'SIGKILL')
      }
      if (cancelTriggered && !cancelRequested) {
        cancelRequested = true
        cancelled = true
        console.log('requesting cancel...')
        const after = await runtime.tasks.cancel(task.id)
        console.log(`cancel result: ${after.status}`)
        result = { status: after.status, error: after.error, task: after, cancelled_at_chunks: after.progress.completed_chunks }
        if (resumeAfterCancel && after.status === 'cancelled') {
          console.log('resuming from checkpoint...')
          const resumedTask = await runtime.tasks.resumeTask(task.id)
          console.log(`resume queued: ${resumedTask.status}`)
          result = null
          cancelled = false
          continue
        }
      }
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) {
        if (task.status === 'interrupted' && resumeAfterCancel) {
          console.log('resuming interrupted task after worker exit...')
          const resumedTask = await runtime.tasks.resumeTask(task.id)
          console.log(`resume queued: ${resumedTask.status}`)
          result = null
          continue
        }
        if (task.status === 'completed') {
          const transcript = parseTranscript(JSON.parse(await readFile(task.transcript_path, 'utf8')))
          await report(transcript, task, false)
        } else {
          result = { status: task.status, error: task.error, task }
          console.log(JSON.stringify(result, null, 2))
        }
        break
      }
    }
    if (!result) {
      const task = await runtime.tasks.getStatus(created.task.id)
      result = { status: task?.status ?? 'timeout', task }
    }
    // Cache probe: a second identical request must not start a new ASR run.
    if (result?.status === 'completed' && !cancelAfterMs) {
      const again = await runtime.tasks.create({
        media: { path: input, size: inputStat.size, extension: extname(input) },
        model,
        align,
      })
      console.log(`cache probe: cached=${again.cached} task=${again.task.id}`)
      result.cacheProbe = { cached: again.cached, taskId: again.task.id }
    }
  }
} finally {
  await runtime.dispose()
}
const output = {
  ...result,
  elapsed_ms: Date.now() - started,
  data_dir: dataDir,
  audio: input,
  config: { model, align, device },
}
await mkdir(join(root, 'testdata', 'results'), { recursive: true })
const resultPath = join(root, 'testdata', 'results', `real-asr-${stamp()}.json`)
await writeFile(resultPath, JSON.stringify(output, null, 2) + '\n', 'utf8')
console.log(`result: ${resultPath}`)

async function report(transcript, task, cached) {
  const memory = transcript.stats.peak_memory_mb
  const text = transcript.segments.map(segment => segment.text).join('')
  result = {
    status: 'completed',
    cached,
    task_id: task.id,
    transcript_id: transcript.id,
    transcript_path: task.transcript_path,
    language: transcript.language,
    model: transcript.model,
    duration_ms: transcript.source.duration_ms,
    segment_count: transcript.segments.length,
    aligned_segments: transcript.segments.filter(segment => segment.timing_status === 'aligned').length,
    processing_ms: transcript.stats.processing_ms,
    realtime_factor: transcript.stats.realtime_factor,
    peak_memory_mb: memory,
    warnings: transcript.warnings,
    text_preview: text.slice(0, 500),
    segments_preview: transcript.segments.slice(0, 3),
  }
  console.log(`transcript=${transcript.id} language=${transcript.language} segments=${transcript.segments.length}`)
  console.log(`processing_ms=${transcript.stats.processing_ms} rtf=${transcript.stats.realtime_factor} peak_mb=${memory}`)
  console.log(`preview: ${text.slice(0, 200)}`)
}

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

#!/usr/bin/env node
import { join, resolve } from 'node:path'
import { defaultDataDir, normalizeConfig } from '../dist/config.js'
import { DataStore } from '../dist/storage/data-store.js'
import { VidoraRuntime } from '../dist/services/runtime.js'

const args = process.argv.slice(2)
const command = args[0] || 'help'
const dataDir = resolve(optionValue(args, '--data-dir') || process.env.VIDORA_DATA_DIR || defaultDataDir())
const config = normalizeConfig({
  dataDir,
  asr: { modelsDir: optionValue(args, '--models-dir') || join(dataDir, 'models') },
  llm: llmConfigFromArgs(),
})

if (command === 'help' || args.includes('--help') || args.includes('-h')) {
  console.log(`Vidora CLI

用法：
  vidora doctor [--probe] [--data-dir DIR]
  vidora models [--data-dir DIR]
  vidora cleanup [--older-than DAYS] [--dry-run] [--data-dir DIR]
  vidora paths [--data-dir DIR]

当前数据目录：${dataDir}
`)
  process.exit(0)
}

if (command === 'paths') {
  console.log(JSON.stringify({
    data_dir: dataDir,
    models_dir: config.asr.modelsDir,
    projects: join(dataDir, 'projects'),
    tasks: join(dataDir, 'tasks'),
    logs: join(dataDir, 'logs'),
  }, null, 2))
  process.exit(0)
}

if (command === 'cleanup') {
  const olderThan = Number(optionValue(args, '--older-than') || 7)
  const dryRun = args.includes('--dry-run')
  const store = new DataStore(config)
  await store.init()
  const result = await store.cleanup({ olderThanDays: olderThan, dryRun })
  console.log(JSON.stringify({ data_dir: dataDir, older_than_days: olderThan, dry_run: dryRun, ...result }, null, 2))
  process.exit(0)
}

if (command === 'models' || command === 'doctor') {
  const runtime = new VidoraRuntime(config)
  try {
    await runtime.ready()
    const models = await runtime.modelAvailability()
    const ffmpeg = await runtime.ffmpegVersion()
    const python = await runtime.pythonVersion()
    const llm = await runtime.llmHealth()
    let worker = null
    if (command === 'doctor' && args.includes('--probe')) {
      try {
        await runtime.worker.ensureStarted()
        worker = await runtime.worker.getStatus()
      } catch (error) {
        worker = { error: error instanceof Error ? error.message : String(error) }
      }
    }
    console.log(JSON.stringify({
      data_dir: dataDir,
      models,
      ffmpeg,
      python,
      worker,
      llm,
      strict_local: config.privacy.strictLocal,
      trusted_providers: config.privacy.trustedLocalProviders,
    }, null, 2))
  } finally {
    await runtime.dispose()
  }
  process.exit(0)
}

console.error(`未知命令：${command}`)
process.exit(2)

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function llmConfigFromArgs() {
  const mode = optionValue(args, '--llm-mode')
  if (!mode) return { mode: 'off' }
  return {
    mode,
    model: optionValue(args, '--llm-model') || '',
    baseUrl: optionValue(args, '--llm-base-url') || '',
    harnessProvider: optionValue(args, '--harness-provider') || '',
    harnessModel: optionValue(args, '--harness-model') || '',
  }
}

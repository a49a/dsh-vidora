#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workerDir = join(root, 'python-worker')
const args = process.argv.slice(2)
const yes = args.includes('--yes') || args.includes('-y')
const endpoint = optionValue(args, '--endpoint') || process.env.VIDORA_HF_ENDPOINT || process.env.HF_ENDPOINT || 'https://huggingface.co'
const models = collectModels(args)
const dataDir = resolve(optionValue(args, '--data-dir') || process.env.VIDORA_DATA_DIR || defaultDataDir())
const modelsDir = resolve(optionValue(args, '--dest') || join(dataDir, 'models'))
const python = optionValue(args, '--python') || (process.platform === 'win32'
  ? join(workerDir, '.venv', 'Scripts', 'python.exe')
  : join(workerDir, '.venv', 'bin', 'python'))
const downloader = join(workerDir, 'download_models.py')

const catalog = {
  'qwen3-asr-0.6b': { repo: 'Qwen/Qwen3-ASR-0.6B', size: '1.9 GB' },
  'qwen3-asr-1.7b': { repo: 'Qwen/Qwen3-ASR-1.7B', size: '4.7 GB' },
  'qwen3-forced-aligner-0.6b': { repo: 'Qwen/Qwen3-ForcedAligner-0.6B', size: '1.9 GB' },
}

async function main() {
  if (models.length === 0) {
    console.log('用法：node scripts/prepare-models.mjs --model qwen3-asr-0.6b [--model qwen3-forced-aligner-0.6b] --yes')
    console.log('可用模型：')
    for (const [id, item] of Object.entries(catalog)) {
      console.log(`  ${id}: ${item.repo} (~${item.size})`)
    }
    return
  }
  for (const model of models) {
    if (!(model in catalog)) fail(`未知模型：${model}`)
  }
  if (!(await exists(python))) {
    fail(`找不到 Worker Python：${python}\n请先运行 node scripts/install-worker.mjs --yes`)
  }
  if (!(await exists(downloader))) fail(`找不到下载脚本：${downloader}`)
  await mkdir(modelsDir, { recursive: true })
  console.log('Vidora 模型准备')
  console.log(`  来源:   ${endpoint}`)
  console.log(`  目标:   ${modelsDir}`)
  console.log(`  Python: ${python}`)
  for (const model of models) {
    const item = catalog[model]
    console.log(`  - ${model}: ${item.repo}, 约 ${item.size}, 许可证 Apache-2.0`)
  }
  console.log('')
  console.log('模型权重只会写入上述目录。下载需要网络；推理过程保持离线。')
  if (!yes) {
    const confirmed = await confirm('确认下载模型权重？[y/N] ')
    if (!confirmed) {
      console.log('已取消。')
      return
    }
  }
  const childArgs = [downloader, '--dest', modelsDir, '--endpoint', endpoint, '--yes']
  for (const model of models) childArgs.push('--model', model)
  await new Promise((resolvePromise, reject) => {
    const child = spawn(python, childArgs, { cwd: workerDir, stdio: 'inherit', env: { ...process.env, HF_ENDPOINT: endpoint } })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`模型下载失败，退出码 ${code}`))
    })
  })
  console.log('\n模型已准备。再次运行 vidora_list_models 检查安装状态。')
}

function defaultDataDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Vidora')
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Vidora')
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'vidora')
}

function collectModels(argv) {
  const result = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--model') {
      const value = argv[index + 1]
      if (!value) fail('--model 需要模型 id')
      result.push(value)
      index += 1
    }
  }
  if (result.length === 0 && argv.includes('--all')) result.push(...Object.keys(catalog))
  return [...new Set(result)]
}

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function fail(message) {
  console.error(`\n${message}`)
  process.exit(1)
}

async function confirm(prompt) {
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(prompt)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

main().catch(error => {
  console.error(`\n模型准备失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

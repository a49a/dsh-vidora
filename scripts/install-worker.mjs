#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workerDir = join(root, 'python-worker')
const venvDir = join(workerDir, '.venv')
const requirements = join(workerDir, 'requirements.txt')
const args = process.argv.slice(2)
const yes = args.includes('--yes') || args.includes('-y')
const systemSitePackages = args.includes('--system-site-packages')
const requestedPython = optionValue(args, '--python') || process.env.VIDORA_PYTHON || 'python3'

const pythonPath = process.platform === 'win32'
  ? join(venvDir, 'Scripts', 'python.exe')
  : join(venvDir, 'bin', 'python')
const pipPath = process.platform === 'win32'
  ? join(venvDir, 'Scripts', 'pip.exe')
  : join(venvDir, 'bin', 'pip')

async function main() {
  console.log('Vidora Python Worker 安装计划')
  console.log(`  Python:   ${requestedPython}`)
  console.log(`  虚拟环境: ${venvDir}`)
  console.log(`  依赖文件: ${requirements}`)
  console.log('  此脚本只修改上述虚拟环境，不修改全局 Python。')
  console.log('')
  if (!(await exists(requirements))) fail(`找不到依赖文件：${requirements}`)
  const version = await runCapture(requestedPython, ['--version'])
  console.log(`检测到 ${version.trim()}`)
  const py = parsePythonVersion(version)
  if (py[0] < 3 || (py[0] === 3 && py[1] < 9)) fail('需要 Python 3.9 或更高版本')
  if (!yes) {
    const confirmed = await confirm('继续创建虚拟环境并安装依赖？[y/N] ')
    if (!confirmed) {
      console.log('已取消。')
      return
    }
  }
  await mkdir(workerDir, { recursive: true })
  if (!(await exists(pythonPath))) {
    const venvArgs = ['-m', 'venv']
    if (systemSitePackages) venvArgs.push('--system-site-packages')
    venvArgs.push(venvDir)
    await run(requestedPython, venvArgs, { label: '创建虚拟环境' })
  } else {
    console.log('虚拟环境已存在，复用。')
  }
  await run(pythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel', 'setuptools'], { label: '升级 pip' })
  await run(pythonPath, ['-m', 'pip', 'install', '-r', requirements], { label: '安装运行时依赖' })
  // qwen-asr's metadata pulls the Gradio demo stack; install only the package
  // itself. Its runtime imports are covered by requirements.txt.
  await run(pythonPath, ['-m', 'pip', 'install', '--no-deps', 'qwen-asr==0.0.6'], { label: '安装 qwen-asr' })
  const verify = await runCapture(pythonPath, ['-c', [
    'import sys, torch, transformers, numpy, soundfile, librosa',
    'import qwen_asr',
    'print("python", sys.version.split()[0])',
    'print("torch", torch.__version__)',
    'print("transformers", transformers.__version__)',
    'print("qwen-asr", getattr(qwen_asr, "__version__", "unknown"))',
    'print("mps", bool(torch.backends.mps.is_available()))',
  ].join('; ')])
  console.log('')
  console.log('验证通过：')
  console.log(verify.trim())
  console.log('')
  console.log('下一步：')
  console.log('  1. node scripts/prepare-models.mjs --model qwen3-asr-0.6b --yes')
  console.log('  2. node scripts/prepare-models.mjs --model qwen3-forced-aligner-0.6b --yes')
  console.log('  3. 将 worker.pythonPath 指向上面的 python（或让插件自动发现 python-worker/.venv）')
}

async function run(command, commandArgs, options = {}) {
  console.log(`\n$ ${command} ${commandArgs.join(' ')}`)
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: workerDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
      },
    })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${options.label || '命令'}失败，退出码 ${code}`))
    })
  })
}

async function runCapture(command, commandArgs, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: workerDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolvePromise(stdout || stderr)
      else reject(new Error(`${command} 失败（${code}）：${stderr || stdout}`))
    })
    if (options.timeoutMs) setTimeout(() => child.kill('SIGKILL'), options.timeoutMs).unref?.()
  })
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

function parsePythonVersion(text) {
  const match = text.match(/Python\s+(\d+)\.(\d+)/i)
  if (!match) return [0, 0]
  return [Number(match[1]), Number(match[2])]
}

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function fail(message) {
  throw new Error(message)
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
  console.error(`\n安装失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

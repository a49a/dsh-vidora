#!/usr/bin/env node
/**
 * Generate real speech fixtures with macOS `say` (default Tingting, zh_CN).
 * This is synthetic speech, not a substitute for a human course recording;
 * the real-ASR test report records exactly which fixture was used.
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHINESE_PARAGRAPH = `同学们好，这一部分我们继续讨论操作系统中的内存管理。虚拟内存通过地址映射，把进程使用的虚拟地址转换为物理地址。页表保存虚拟页到物理页的映射，而 TLB 用来加速地址转换。当发生缺页异常时，操作系统会选择一个页面进行淘汰，必要时把它写回磁盘。LRU 是一种常见的页面置换算法，但实际系统中经常使用 Clock 算法来近似 LRU。我们还要区分内部碎片和外部碎片，理解分页、分段以及段页式管理的取舍。{n}`

const MIXED_PARAGRAPH = `This part reviews the virtual memory pipeline in a Chinese operating systems course. 虚拟内存通过 paging 把虚拟地址 virtual address 转换为物理地址 physical address。页表 page table 记录映射，TLB 缓存最近的 translation。发生 page fault 时，内核会选择 victim page 并执行 replacement。LRU 和 Clock 都是页面置换算法，而 copy-on-write 可以延迟物理页分配。我们还会讨论 memory-mapped files、swap、NUMA 以及 cache coherence。请记住 throughput、latency 和 fairness 之间的权衡。{n}`

function optionValue(argv, key) {
  const index = argv.indexOf(key)
  return index >= 0 ? argv[index + 1] : undefined
}

async function run(command, commandArgs) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)))
  })
}

async function capture(command, commandArgs) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolvePromise(stdout.trim()) : reject(new Error(stderr || `${command} exited ${code}`)))
  })
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const minutes = Number(optionValue(args, '--minutes') || 5)
const name = optionValue(args, '--name') || `lecture-${minutes}m`
const voice = optionValue(args, '--voice') || 'Tingting'
const rate = Number(optionValue(args, '--rate') || 180)
const mixed = args.includes('--mixed')
const audioDir = join(root, 'testdata', 'audio')
const textPath = join(audioDir, `${name}.txt`)
const aiffPath = join(audioDir, `${name}.aiff`)
const m4aPath = join(audioDir, `${name}.m4a`)
const mp3Path = join(audioDir, `${name}.mp3`)
const targetChars = Math.ceil(minutes * (mixed ? 560 : 290))
const paragraph = mixed ? MIXED_PARAGRAPH : CHINESE_PARAGRAPH
const parts = []
let chars = 0
let index = 1
while (chars < targetChars) {
  const header = `第${index}部分。`
  const body = paragraph.replaceAll('{n}', String(index))
  parts.push(header + body)
  chars += header.length + body.length
  index += 1
}
const text = parts.join('\n\n')
await mkdir(audioDir, { recursive: true })
await writeFile(textPath, `${text}\n`, 'utf8')
console.log(`脚本：${textPath}（${chars} 字符，目标 ${minutes} 分钟）`)
await run('say', ['-v', voice, '-r', String(rate), '-f', textPath, '-o', aiffPath])
await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiffPath, '-c:a', 'aac', '-b:a', '128k', m4aPath])
await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiffPath, '-codec:a', 'libmp3lame', '-b:a', '128k', mp3Path])
const duration = await capture('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', m4aPath])
console.log(`完成：${m4aPath}（${Number(duration).toFixed(1)} 秒）`)
console.log(`MP3：${mp3Path}`)


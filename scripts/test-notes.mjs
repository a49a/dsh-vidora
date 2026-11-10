#!/usr/bin/env node
/**
 * Real local-LLM notes generation test against a running OpenAI-compatible
 * loopback server (llama.cpp, Ollama OpenAI mode, LM Studio, etc.).
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { normalizeConfig } from '../dist/config.js'
import { DataStore } from '../dist/storage/data-store.js'
import { DocumentService } from '../dist/services/document-service.js'

const args = process.argv.slice(2)
const dataDir = resolve(optionValue(args, '--data-dir') || '')
const transcriptId = optionValue(args, '--transcript-id')
const modes = (optionValue(args, '--modes') || 'concise').split(',').filter(Boolean)
const baseUrl = optionValue(args, '--base-url') || 'http://127.0.0.1:8090/v1'
const model = optionValue(args, '--model') || 'qwen2.5-1.5b-instruct'
const force = args.includes('--force')
if (!dataDir || dataDir === resolve('')) {
  console.error('用法：node scripts/test-notes.mjs --data-dir <run-dir> [--transcript-id id] [--modes concise,review] [--base-url ...] [--model ...]')
  process.exit(2)
}
const config = normalizeConfig({
  dataDir,
  asr: { modelsDir: join(dataDir, 'models') },
  llm: {
    mode: 'openai',
    baseUrl,
    model,
    maxContextChars: 12000,
    maxOutputTokens: 4096,
    timeoutMs: 600000,
  },
  privacy: { strictLocal: true, trustedLocalProviders: ['vidora-local'] },
  document: { defaultMode: 'concise', maxCharsPerWindow: 12000 },
})
const store = new DataStore(config)
const transcript = transcriptId
  ? await store.findTranscriptById(transcriptId)
  : await latestTranscript(store)
if (!transcript) throw new Error(`Transcript not found: ${transcriptId}`)
const service = new DocumentService(config, store, (await import('../dist/services/local-llm.js')).createLocalLlmClient(config.llm, config.privacy))
for (const mode of modes) {
  const started = Date.now()
  const result = await service.generate({ transcript, mode, force })
  const markdown = await readFile(result.markdownPath, 'utf8')
  const citations = (markdown.match(/#seg-/g) || []).length
  console.log(`\n[${mode}] document=${result.document.id} cached=${result.cached}`)
  console.log(`title=${result.document.title}`)
  console.log(`blocks=${result.document.blocks.length} sections=${result.document.blocks.filter(block => block.type === 'section').length}`)
  console.log(`citations=${citations} invalid=${result.document.stats.invalid_citations} warnings=${result.document.warnings.length}`)
  console.log(`path=${result.markdownPath}`)
  console.log(`elapsed_ms=${Date.now() - started}`)
  console.log('--- markdown preview ---')
  console.log(markdown.slice(0, 2400))
  const again = await service.generate({ transcript, mode, force: false })
  console.log(`cache check: cached=${again.cached} same=${again.document.id === result.document.id}`)
}

function optionValue(argv, key) {
  const index = argv.indexOf(key)
  return index >= 0 ? argv[index + 1] : undefined
}

async function latestTranscript(store) {
  const projects = await store.recentProjects(20)
  for (const project of projects) {
    const latest = await store.latestTranscript(project.project_id)
    if (latest) return latest
  }
  throw new Error('No transcript found in data directory')
}

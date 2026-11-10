import assert from 'node:assert/strict'
import test from 'node:test'
import { NotesEngine } from '../dist/services/notes-engine.js'
import { makeTranscript } from './fixtures.mjs'

const documentConfig = {
  defaultMode: 'concise',
  maxCharsPerWindow: 4000,
  maxWindows: 20,
  includeFrontMatter: true,
}

function fakeClient(response, mode = 'json') {
  return {
    info: {
      provider: 'ollama',
      model: 'fake-local',
      endpoint: 'http://127.0.0.1:11434',
      local: true,
      prompt_version: 'vidora-notes-v1',
    },
    async completeJson() {
      return typeof response === 'function' ? response() : response
    },
    async health() {
      return { configured: true, mode: 'ollama', reachable: true, local: true, endpoint: '', models: [], error: null }
    },
    mode,
  }
}

test('validates citations and builds deterministic section blocks', async () => {
  const transcript = makeTranscript()
  const engine = new NotesEngine(documentConfig, fakeClient({
    title: '虚拟内存课程',
    sections: [
      {
        title: '地址转换',
        content: '虚拟内存通过页表完成地址转换。',
        bullets: ['TLB 加速转换'],
        questions: [],
        checklist: [],
        source_segment_ids: ['seg-000001', 'invented-id'],
      },
      {
        title: '地址转换',
        content: '重复章节应合并。',
        source_segment_ids: ['seg-000002'],
      },
    ],
    key_terms: [
      { term: 'TLB', definition: '地址转换缓存', source_segment_ids: ['seg-000001'] },
    ],
  }))
  const { document } = await engine.generate({ transcript, mode: 'concise' })
  assert.equal(document.title, '虚拟内存课程')
  const sections = document.blocks.filter(block => block.type === 'section')
  assert.equal(sections.length, 1)
  assert.deepEqual(sections[0].source_segment_ids.sort(), ['seg-000001', 'seg-000002'])
  assert.equal(sections[0].uncertain, undefined)
  assert.equal(document.stats.invalid_citations, 1)
  assert.match(sections[0].content, /TLB 加速转换/)
  assert.match(document.blocks.find(block => block.type === 'key_terms').content, /TLB/)
})

test('marks sections without real citations as uncertain', async () => {
  const transcript = makeTranscript()
  const engine = new NotesEngine(documentConfig, fakeClient({
    title: '课程',
    sections: [
      {
        title: '没有来源',
        content: '模型猜测的内容',
        source_segment_ids: ['invented'],
      },
    ],
    key_terms: [],
  }))
  const { document } = await engine.generate({ transcript, mode: 'concise' })
  const section = document.blocks.find(block => block.type === 'section')
  assert.equal(section.uncertain, true)
  assert.deepEqual(section.source_segment_ids, [])
  assert.ok(document.warnings.some(warning => warning.includes('缺少可验证来源')))
})

test('transcript mode preserves every segment and falls back to original text', async () => {
  const transcript = makeTranscript()
  const engine = new NotesEngine(documentConfig, fakeClient({
    segments: [
      { id: 'seg-000001', text: '第一段（整理后）。' },
      // seg-000002 intentionally omitted: fallback must keep the original.
    ],
  }))
  const { document } = await engine.generate({ transcript, mode: 'transcript' })
  const text = document.blocks.map(block => block.content).join('\n')
  assert.match(text, /第一段（整理后）。/)
  assert.match(text, /Second segment\./)
  assert.equal(document.mode, 'transcript')
})

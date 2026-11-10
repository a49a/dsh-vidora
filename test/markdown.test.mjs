import assert from 'node:assert/strict'
import test from 'node:test'
import { renderDocumentMarkdown, renderTranscriptMarkdown, sanitizeGeneratedMarkdown } from '../dist/core/markdown.js'
import { makeDocument, makeTranscript } from './fixtures.mjs'

test('renders deterministic Markdown with portable source links', () => {
  const transcript = makeTranscript()
  const document = makeDocument()
  const markdown = renderDocumentMarkdown(document, transcript, {
    transcriptHref: 'transcripts/tr-test.json',
  })
  assert.match(markdown, /^---\ntitle: "测试讲义"/)
  assert.match(markdown, /## 虚拟内存/)
  assert.match(markdown, /来源：\[00:01\]\(transcripts\/tr-test\.json#seg-000001\)/)
  assert.match(markdown, /## 关键术语/)
  assert.match(markdown, /\*\*TLB\*\*/)
})

test('marks uncertain blocks and escapes active HTML', () => {
  const transcript = makeTranscript()
  const document = makeDocument({
    blocks: [{
      id: 'block-001',
      type: 'section',
      title: 'Unsafe',
      content: '<script>alert(1)</script>\n\n普通内容 [x](javascript:alert(1))',
      source_segment_ids: [],
      uncertain: true,
    }],
  })
  const markdown = renderDocumentMarkdown(document, transcript)
  assert.doesNotMatch(markdown, /<script>/)
  assert.match(markdown, /&lt;script>/)
  assert.doesNotMatch(markdown, /javascript:alert/)
  assert.match(markdown, /来源不确定/)
})

test('renders a readable transcript with timestamps', () => {
  const markdown = renderTranscriptMarkdown(makeTranscript())
  assert.match(markdown, /# 转写稿/)
  assert.match(markdown, /\*\*\[00:01\]\*\* 第一段。/)
  assert.match(markdown, /第二段|Second segment/)
})

test('sanitizer keeps ordinary Markdown', () => {
  const value = sanitizeGeneratedMarkdown('## 标题\n\n- 列表\n\n```js\nconst x = 1 < 2\n```')
  assert.match(value, /## 标题/)
  assert.match(value, /const x = 1 < 2/)
})

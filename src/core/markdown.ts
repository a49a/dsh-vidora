import { basename } from 'node:path'
import type { DocumentBlock, Transcript, VidoraDocument } from './types.js'
import { citationsFor, segmentMap } from './transcript.js'
import { formatClock } from './time.js'

export interface RenderOptions {
  includeFrontMatter?: boolean
  transcriptHref?: string
  generatedNote?: string
}

export function renderDocumentMarkdown(
  document: VidoraDocument,
  transcript: Transcript,
  options: RenderOptions = {},
): string {
  const transcriptHref = options.transcriptHref ?? `transcripts/${transcript.id}.json`
  const lines: string[] = []
  if (options.includeFrontMatter !== false) {
    lines.push('---')
    lines.push(`title: ${quote(document.title)}`)
    lines.push('vidora: 1')
    lines.push(`document_id: ${quote(document.id)}`)
    lines.push(`transcript_id: ${quote(document.transcript_id)}`)
    lines.push(`mode: ${quote(document.mode)}`)
    lines.push(`language: ${quote(document.language)}`)
    lines.push(`source: ${quote(basename(transcript.source.path))}`)
    lines.push(`source_sha256: ${quote(transcript.source.sha256)}`)
    lines.push(`generated_at: ${quote(document.created_at)}`)
    lines.push(`llm_provider: ${quote(document.llm.provider)}`)
    lines.push(`llm_model: ${quote(document.llm.model)}`)
    lines.push(`llm_local: ${document.llm.local ? 'true' : 'false'}`)
    lines.push('---')
    lines.push('')
  }

  lines.push(`# ${document.title}`)
  lines.push('')
  lines.push(
    `> 本文由 Vidora 在本地生成。转写模型：${transcript.model}；文档模式：${modeLabel(document.mode)}。`,
  )
  if (document.warnings.length > 0) {
    lines.push('>')
    for (const warning of document.warnings.slice(0, 5)) {
      lines.push(`> 注意：${sanitizeInline(warning)}`)
    }
  }
  lines.push('')

  const keyTermBlocks: DocumentBlock[] = []
  for (const block of document.blocks) {
    if (block.type === 'key_terms') {
      keyTermBlocks.push(block)
      continue
    }
    renderBlock(lines, block, transcript, transcriptHref)
  }

  if (keyTermBlocks.length > 0) {
    lines.push('## 关键术语')
    lines.push('')
    for (const block of keyTermBlocks) {
      const sanitized = sanitizeGeneratedMarkdown(block.content)
      for (const line of sanitized.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) lines.push(trimmed)
      }
      const citation = citationsFor(block, transcript, transcriptHref)
      if (citation) lines.push('', citation)
      lines.push('')
    }
  }

  if (options.generatedNote) {
    lines.push('---')
    lines.push('')
    lines.push(`_${sanitizeInline(options.generatedNote)}_`)
    lines.push('')
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

function renderBlock(
  lines: string[],
  block: DocumentBlock,
  transcript: Transcript,
  transcriptHref: string,
): void {
  const level = Math.max(2, Math.min(6, block.level ?? 2))
  if (block.type === 'section') {
    if (block.title) {
      lines.push(`${'#'.repeat(level)} ${sanitizeInline(block.title)}`)
      lines.push('')
    }
    if (block.content.trim()) {
      lines.push(sanitizeGeneratedMarkdown(block.content))
      lines.push('')
    }
  } else if (block.type === 'paragraph') {
    lines.push(sanitizeGeneratedMarkdown(block.content))
    lines.push('')
  } else if (block.type === 'list') {
    lines.push(sanitizeGeneratedMarkdown(block.content))
    lines.push('')
  } else if (block.type === 'code') {
    lines.push('```')
    lines.push(block.content)
    lines.push('```')
    lines.push('')
  } else if (block.type === 'formula') {
    lines.push('$$')
    lines.push(block.content)
    lines.push('$$')
    lines.push('')
  } else if (block.type === 'callout') {
    for (const line of block.content.split('\n')) lines.push(`> ${line}`)
    lines.push('')
  }

  if (block.uncertain) {
    lines.push('> 来源不确定：该段内容缺少可验证的转写片段引用。')
    lines.push('')
  }
  const citation = citationsFor(block, transcript, transcriptHref)
  if (citation) {
    lines.push(citation)
    lines.push('')
  }
}

export function renderTranscriptMarkdown(
  transcript: Transcript,
  options: { title?: string; includeFrontMatter?: boolean } = {},
): string {
  const lines: string[] = []
  if (options.includeFrontMatter !== false) {
    lines.push('---')
    lines.push(`title: ${quote(options.title ?? `转写稿：${basename(transcript.source.path)}`)}`)
    lines.push('vidora: 1')
    lines.push(`transcript_id: ${quote(transcript.id)}`)
    lines.push(`source: ${quote(basename(transcript.source.path))}`)
    lines.push(`source_sha256: ${quote(transcript.source.sha256)}`)
    lines.push(`model: ${quote(transcript.model)}`)
    lines.push(`language: ${quote(transcript.language)}`)
    lines.push(`generated_at: ${quote(transcript.created_at)}`)
    lines.push('---')
    lines.push('')
  }
  lines.push(`# ${options.title ?? '转写稿'}`)
  lines.push('')
  lines.push(
    `> 原始转写；模型 ${transcript.model}，语言 ${transcript.language}，共 ${transcript.segments.length} 段。`,
  )
  lines.push('')
  for (const segment of transcript.segments) {
    const timing = segment.timing_status === 'uncertain' ? '（时间不确定）' : ''
    lines.push(`**[${formatClock(segment.start_ms)}]${timing}** ${sanitizeInline(segment.text)}`)
    lines.push('')
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

export function renderTranscriptTxt(transcript: Transcript, timestamps = true): string {
  if (!timestamps) {
    return `${transcript.segments.map(segment => segment.text).join('\n')}\n`
  }
  return `${transcript.segments
    .map(segment => `[${formatClock(segment.start_ms)}] ${segment.text}`)
    .join('\n')}\n`
}

export function modeLabel(mode: VidoraDocument['mode']): string {
  switch (mode) {
    case 'concise':
      return '精简讲义'
    case 'detailed':
      return '详细讲义'
    case 'transcript':
      return '可读转写'
    case 'review':
      return '复习提纲'
  }
}

/** Quote a value as a YAML double-quoted scalar (JSON strings are valid YAML). */
export function quote(value: string): string {
  return JSON.stringify(value)
}

/** Keep generated Markdown readable while neutralizing active HTML and JS URLs. */
export function sanitizeGeneratedMarkdown(input: string): string {
  return input
    .replace(/\u0000/g, '')
    .replace(/<\s*(script|iframe|object|embed|form|style|link|meta|base)\b[^>]*>/gi, match => `&lt;${match.slice(1)}`)
    .replace(/(\]\s*\(\s*)javascript:/gi, '$1#')
    .replace(/(\]\s*\(\s*)data:text\/html/gi, '$1#')
    .trim()
}

export function sanitizeInline(input: string): string {
  return sanitizeGeneratedMarkdown(input)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\u0000/g, '')
    .trim()
}

export interface CitationCoverage {
  cited: Set<string>
  unknown: string[]
}

export function citationCoverage(document: VidoraDocument, transcript: Transcript): CitationCoverage {
  const known = segmentMap(transcript)
  const cited = new Set<string>()
  const unknown = new Set<string>()
  for (const block of document.blocks) {
    for (const id of block.source_segment_ids) {
      if (known.has(id)) cited.add(id)
      else unknown.add(id)
    }
  }
  return { cited, unknown: [...unknown] }
}

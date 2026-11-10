export interface ModelCatalogEntry {
  id: string
  repo: string
  directory: string
  approxBytes: number
  label: string
  description: string
  license: string
}

export const ASR_MODELS: Record<string, ModelCatalogEntry> = {
  'qwen3-asr-0.6b': {
    id: 'qwen3-asr-0.6b',
    repo: 'Qwen/Qwen3-ASR-0.6B',
    directory: 'Qwen3-ASR-0.6B',
    approxBytes: 1_876_091_704,
    label: 'Qwen3-ASR-0.6B',
    description: 'Default. Chinese/English/mixed speech, 52 languages and dialects, lighter local inference.',
    license: 'Apache-2.0',
  },
  'qwen3-asr-1.7b': {
    id: 'qwen3-asr-1.7b',
    repo: 'Qwen/Qwen3-ASR-1.7B',
    directory: 'Qwen3-ASR-1.7B',
    approxBytes: 4_712_026_646,
    label: 'Qwen3-ASR-1.7B',
    description: 'Higher quality, more memory and compute. Optional upgrade.',
    license: 'Apache-2.0',
  },
}

export const ALIGNER_MODELS: Record<string, ModelCatalogEntry> = {
  'qwen3-forced-aligner-0.6b': {
    id: 'qwen3-forced-aligner-0.6b',
    repo: 'Qwen/Qwen3-ForcedAligner-0.6B',
    directory: 'Qwen3-ForcedAligner-0.6B',
    approxBytes: 1_835_544_544,
    label: 'Qwen3-ForcedAligner-0.6B',
    description: 'Word/character timestamps for 11 languages, including Chinese and English.',
    license: 'Apache-2.0',
  },
}

export function modelEntry(id: string): ModelCatalogEntry | undefined {
  return ASR_MODELS[id] ?? ALIGNER_MODELS[id]
}

export function isSupportedAsrModel(id: string): boolean {
  return id in ASR_MODELS
}

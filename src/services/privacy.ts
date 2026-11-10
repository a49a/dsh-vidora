import { isAbsolute, relative } from 'node:path'
import type { PrivacyConfig } from '../config.js'

export interface ModelSelectionLike {
  provider: string
  model: string
}

export interface AgentLike {
  model?: {
    current(): Readonly<ModelSelectionLike> | undefined
  }
}

export class PrivacyError extends Error {
  readonly code = 'VIDORA_PRIVACY_BLOCKED'

  constructor(message: string) {
    super(message)
    this.name = 'PrivacyError'
  }
}

const FILE_TOOL_NAMES = new Set([
  'bash', 'bash_persistent', 'shell', 'terminal', 'pwsh', 'pwsh_persistent',
  'read', 'read_file', 'write', 'write_file', 'edit', 'apply_patch',
  'str_replace_editor', 'glob', 'grep', 'list_dir', 'job', 'jobs',
])

export class PrivacyPolicy {
  private readonly sensitivePaths = new Set<string>()

  constructor(
    private readonly config: PrivacyConfig,
    private readonly dataDir = '',
  ) {}

  addSensitivePath(path: string): void {
    if (typeof path !== 'string' || !path.trim()) return
    this.sensitivePaths.add(path)
    this.sensitivePaths.add(path.replaceAll(' ', '\\ '))
    const rel = relative(process.cwd(), path)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      this.sensitivePaths.add(rel)
      this.sensitivePaths.add(`./${rel}`)
      this.sensitivePaths.add(rel.replaceAll(' ', '\\ '))
    }
  }

  isTrusted(selection: Readonly<ModelSelectionLike> | undefined | null): boolean {
    if (!this.config.strictLocal) return true
    if (!selection) return false
    if (!this.config.trustedLocalProviders.includes(selection.provider)) return false
    if (
      this.config.trustedLocalModels.length > 0
      && !this.config.trustedLocalModels.includes(selection.model)
    ) {
      return false
    }
    return true
  }

  currentSelection(agent: AgentLike | undefined): Readonly<ModelSelectionLike> | undefined {
    try {
      return agent?.model?.current()
    } catch {
      return undefined
    }
  }

  isCurrentSessionTrusted(agent: AgentLike | undefined): boolean {
    return this.isTrusted(this.currentSelection(agent))
  }

  assertContentReadAllowed(agent: AgentLike | undefined): void {
    if (this.isCurrentSessionTrusted(agent)) return
    const selection = this.currentSelection(agent)
    const actual = selection ? `${selection.provider}/${selection.model}` : '未记录'
    throw new PrivacyError(
      `严格本地模式已阻止读取正文：当前会话模型为 ${actual}，不在 privacy.trustedLocalProviders 中。`
      + ' 请切换到已确认在本地运行的模型，或使用本机文件路径直接查看/导出结果。',
    )
  }

  /**
   * Runtime guard for non-Vidora tools. Even when content tools are hidden, a
   * remote agent may try to read transcript.json through bash/read/grep. This
   * guard denies calls that mention the Vidora data directory or known Vidora
   * file names. It is defense in depth, not a filesystem sandbox; see
   * docs/security.md for residual risks.
   */
  guardToolCall(
    name: string,
    args: unknown,
    agent: AgentLike | undefined,
  ): string | undefined {
    if (!this.config.strictLocal) return undefined
    if (name.startsWith('vidora_')) return undefined
    if (this.isCurrentSessionTrusted(agent)) return undefined
    if (this.config.untrustedFileToolPolicy === 'off') return undefined
    if (this.config.untrustedFileToolPolicy === 'block-all') {
      if (FILE_TOOL_NAMES.has(name)) {
        return 'Vidora strict-local mode: file and shell tools are disabled for this untrusted session. '
          + 'Switch to a trusted local model or use vidora_export and open the file locally.'
      }
      return undefined
    }
    if (!FILE_TOOL_NAMES.has(name)) return undefined
    const text = safeStringify(args).slice(0, 20000)
    if (!text) return undefined
    const references = [...this.dataReferences(), ...this.sensitivePaths]
    if (references.some(value => text.includes(value))) {
      return 'Vidora strict-local mode: this untrusted session may not read or write Vidora transcript/document paths. '
        + 'Use vidora_export to create a file and open it locally, or switch to a trusted local model.'
    }
    return undefined
  }

  private dataReferences(): string[] {
    const values = new Set<string>([
      'transcript.json',
      'document.json',
      'checkpoint.json',
      'source.json',
      'notes.md',
      '/projects/prj-',
      '/tasks/task-',
    ])
    if (this.dataDir) {
      values.add(this.dataDir)
      values.add(this.dataDir.replaceAll(' ', '\\ '))
      values.add(this.dataDir.replaceAll('\\', '/'))
      if (this.dataDir.startsWith(process.env.HOME || '~')) {
        values.add(`~${this.dataDir.slice((process.env.HOME || '').length)}`)
      }
    }
    return [...values].filter(Boolean)
  }

  describe(selection?: Readonly<ModelSelectionLike> | null): {
    strictLocal: boolean
    trusted: boolean
    selection: string | null
    trustedProviders: string[]
    trustedModels: string[]
    untrustedFileToolPolicy: string
  } {
    return {
      strictLocal: this.config.strictLocal,
      trusted: this.isTrusted(selection),
      selection: selection ? `${selection.provider}/${selection.model}` : null,
      trustedProviders: [...this.config.trustedLocalProviders],
      trustedModels: [...this.config.trustedLocalModels],
      untrustedFileToolPolicy: this.config.untrustedFileToolPolicy,
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

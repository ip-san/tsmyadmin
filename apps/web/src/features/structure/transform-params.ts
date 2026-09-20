import type { ColumnTransformBody, TransformKind } from '@tsmyadmin/shared'

/** What the form holds for a transformation's options, as typed. */
export interface TransformParams {
  template: string
  start: string
  length: string
  trueText: string
  falseText: string
  format: string
  prefix: string
  suffix: string
  pattern: string
  message: string
}

export const EMPTY_PARAMS: TransformParams = {
  template: '',
  start: '0',
  length: '10',
  trueText: '',
  falseText: '',
  format: 'YYYY-MM-DD HH:mm',
  prefix: '',
  suffix: '',
  pattern: '',
  message: '',
}

const nonEmpty = <K extends string>(key: K, value: string) => (value.trim() !== '' ? { [key]: value.trim() } : {})
const whole = (text: string, fallback: number) => {
  const n = Math.floor(Number(text))
  return Number.isFinite(n) ? n : fallback
}

/** The options a kind takes, from the form: the fields another kind uses are left out of what is saved. */
export function transformOptions(
  kind: TransformKind,
  p: TransformParams
): Partial<Omit<ColumnTransformBody, 'database' | 'table' | 'column' | 'kind' | 'schema'>> {
  switch (kind) {
    case 'link':
    case 'imagelink':
      return nonEmpty('template', p.template)
    case 'substring':
      return { start: Math.max(0, whole(p.start, 0)), length: Math.max(1, whole(p.length, 1)) }
    case 'boolean':
      return { ...nonEmpty('trueText', p.trueText), ...nonEmpty('falseText', p.falseText) }
    case 'date':
      return nonEmpty('format', p.format)
    case 'affix':
      // Spaces around the text count here: a suffix of " 円" is what was asked for.
      return {
        ...(p.prefix !== '' ? { prefix: p.prefix } : {}),
        ...(p.suffix !== '' ? { suffix: p.suffix } : {}),
      }
    case 'pattern':
      return { ...nonEmpty('pattern', p.pattern), ...nonEmpty('message', p.message) }
    default:
      return {}
  }
}

/** A short line saying how a transformation is set, for the list. */
export function describeOptions(t: ColumnTransformBody): string {
  switch (t.kind) {
    case 'link':
    case 'imagelink':
      return t.template ?? ''
    case 'substring':
      return `${t.start ?? 0}+${t.length ?? ''}`
    case 'boolean':
      return [t.trueText, t.falseText].filter(Boolean).join(' / ')
    case 'date':
      return t.format ?? ''
    case 'affix':
      return `${t.prefix ?? ''}…${t.suffix ?? ''}`
    case 'pattern':
      return t.pattern ?? ''
    default:
      return ''
  }
}

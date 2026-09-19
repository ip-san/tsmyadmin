import { type FilterOp, LIST_OPS, NO_VALUE_OPS } from '@tsmyadmin/shared'

/** Whether the operator takes what is typed: nothing, one value, or a comma-separated list. */
export function valueShape(op: FilterOp | ''): 'none' | 'one' | 'list' {
  if (op === '' || NO_VALUE_OPS.has(op)) return 'none'
  return LIST_OPS.has(op) ? 'list' : 'one'
}

/** The typed text as a condition's value: IN takes "1, 2, 3", BETWEEN "low, high". */
export function conditionValue(op: FilterOp, text: string): { value?: string; values?: string[] } {
  const shape = valueShape(op)
  if (shape === 'none') return {}
  if (shape === 'one') return { value: text }
  return {
    values: text
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  }
}

/** A condition's value back as the text to edit. */
export function conditionText(c: { value?: unknown; values?: readonly unknown[] | undefined }): string {
  if (c.values) return c.values.map((v) => (v === null ? '' : String(v))).join(', ')
  return c.value === undefined || c.value === null ? '' : String(c.value)
}

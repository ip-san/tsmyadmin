import type { ColumnSpec } from '@tsmyadmin/shared'
import { expect } from 'vitest'
import { AdapterError } from '../types.ts'

/** A column definition with every field spelled out, overridden as needed. */
export const col = (name: string, dataType: string, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({
  name,
  dataType,
  nullable: true,
  default: null,
  autoIncrement: false,
  comment: null,
  collation: null,
  onUpdate: null,
  check: null,
  generated: null,
  ...extra,
})

/** Runs `run` and checks it throws an AdapterError with this code and a message matching. */
export const refuses = (run: () => unknown, code: string, message: RegExp) => {
  try {
    run()
  } catch (e) {
    expect(e).toBeInstanceOf(AdapterError)
    expect((e as AdapterError).code).toBe(code)
    expect((e as AdapterError).message).toMatch(message)
    return
  }
  throw new Error('expected a refusal')
}

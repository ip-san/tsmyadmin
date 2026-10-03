/**
 * Spec consistency: structural checks that catch "added but not covered" drift.
 * Add a test here whenever a class of bug slips through that a cheap structural check would have caught.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADAPTER_METHOD_NAMES } from '../types.ts'

// The suite is `conformance.ts` (the runner) and one file per group in `conformance/`: every describe is in one of them.
const conformanceDir = join(import.meta.dirname, 'conformance')
const conformanceSource = [
  join(import.meta.dirname, 'conformance.ts'),
  ...readdirSync(conformanceDir).map((f) => join(conformanceDir, f)),
]
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')

describe('Spec consistency: adapter', () => {
  it('every DatabaseAdapter method has a describe block in the conformance suite', () => {
    for (const method of ADAPTER_METHOD_NAMES) {
      expect(conformanceSource, `the conformance suite lacks describe('${method}')`).toContain(`describe('${method}'`)
    }
  })

  it('the conformance suite also covers the DDL builder and the SQL exporter', () => {
    expect(conformanceSource).toContain("describe('ddl'")
    expect(conformanceSource).toContain("describe('export'")
    expect(conformanceSource).toContain("describe('users'")
  })

  it('mysql and postgres implement the same module set including export', () => {
    for (const dialect of ['mysql', 'postgres']) {
      expect(() => readFileSync(join(import.meta.dirname, '..', dialect, 'export.ts'))).not.toThrow()
    }
  })

  it('mysql and postgres implement the same module set', () => {
    const expected = [
      'adapter.ts',
      'ddl.ts',
      'introspect.ts',
      'values.ts',
      'export.ts',
      'users.ts',
      'server.ts',
      'routines.ts',
    ]
    for (const dialect of ['mysql', 'postgres']) {
      for (const file of expected) {
        expect(() => readFileSync(join(import.meta.dirname, '..', dialect, file))).not.toThrow()
      }
    }
  })
})

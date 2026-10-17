import { describe, expect, it } from 'vitest'
import { collationNames } from './collations.ts'

describe('collationNames', () => {
  it('reads the collation column wherever the server puts it', () => {
    expect(
      collationNames({
        columns: ['charset', 'collation', 'isDefault'],
        rows: [
          ['utf8mb4', 'utf8mb4_bin', ''],
          ['latin1', 'latin1_swedish_ci', 'Yes'],
        ],
      })
    ).toEqual(['utf8mb4_bin', 'latin1_swedish_ci'])
    expect(
      collationNames({
        columns: ['collation', 'provider', 'encoding'],
        rows: [
          ['C', 'libc', null],
          ['und-x-icu', 'icu', null],
        ],
      })
    ).toEqual(['C', 'und-x-icu'])
  })

  it('leaves out empty names, and is empty before the catalog arrives or without a collation column', () => {
    expect(collationNames({ columns: ['collation'], rows: [[null], [''], ['C']] })).toEqual(['C'])
    expect(collationNames(undefined)).toEqual([])
    expect(collationNames({ columns: ['name', 'type'], rows: [['btree', 'index']] })).toEqual([])
  })
})

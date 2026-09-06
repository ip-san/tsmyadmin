import { describe, expect, it } from 'vitest'
import { tooLongIdentifier } from './identifiers.ts'

describe('tooLongIdentifier', () => {
  it('measures MySQL in characters and PostgreSQL in bytes, only on name-carrying keys', () => {
    const ok = 'x'.repeat(63)
    expect(tooLongIdentifier({ op: 'createDatabase', name: ok }, 'mysql')).toBeNull()
    expect(tooLongIdentifier({ op: 'createDatabase', name: 'x'.repeat(64) }, 'mysql')).toBeNull()
    expect(tooLongIdentifier({ op: 'createDatabase', name: 'x'.repeat(65) }, 'mysql')).toEqual({
      name: 'x'.repeat(65),
      max: 64,
    })
    expect(tooLongIdentifier({ op: 'createDatabase', name: 'x'.repeat(64) }, 'postgres')).toEqual({
      name: 'x'.repeat(64),
      max: 63,
    })
    // 22 three-byte characters are 66 bytes: over the PostgreSQL limit, well within MySQL's.
    const kana = 'あ'.repeat(22)
    expect(tooLongIdentifier({ op: 'renameTable', table: 't', newName: kana }, 'postgres')?.name).toBe(kana)
    expect(tooLongIdentifier({ op: 'renameTable', table: 't', newName: kana }, 'mysql')).toBeNull()
    // Comments, defaults and hosts are not identifiers; column names are.
    expect(
      tooLongIdentifier({ op: 'x', comment: 'c'.repeat(200), user: { name: 'u', host: 'h'.repeat(100) } }, 'mysql')
    ).toBeNull()
    expect(tooLongIdentifier({ op: 'addIndex', columns: [{ name: 'c'.repeat(70) }] }, 'mysql')?.max).toBe(64)
    expect(tooLongIdentifier({ user: 'u'.repeat(70) }, 'postgres')?.max).toBe(63)
  })
})

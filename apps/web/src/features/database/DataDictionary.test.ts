import { describe, expect, it } from 'vitest'
import { referencesOf } from './DataDictionary.tsx'

describe('referencesOf', () => {
  it('names what each column of a foreign key points at, pairwise', () => {
    const refs = referencesOf({
      foreignKeys: [
        {
          name: 'fk',
          columns: ['a', 'b'],
          refNamespace: { database: 'd' },
          refTable: 'r',
          refColumns: ['x', 'y'],
          onUpdate: null,
          onDelete: null,
        },
      ],
    })
    expect([...refs]).toEqual([
      ['a', 'r.x'],
      ['b', 'r.y'],
    ])
  })
})

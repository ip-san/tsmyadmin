import { describe, expect, it } from 'vitest'
import { filterKeyValues } from './KeyValueTable.tsx'

const items = [
  { name: 'max_connections', value: '151', description: null },
  { name: 'work_mem', value: '4MB', description: 'Sets the memory for sorts' },
]

describe('filterKeyValues', () => {
  it('matches name or description, case-insensitively', () => {
    expect(filterKeyValues(items, 'MAX').map((i) => i.name)).toEqual(['max_connections'])
    expect(filterKeyValues(items, 'sorts').map((i) => i.name)).toEqual(['work_mem'])
    expect(filterKeyValues(items, '  ')).toHaveLength(2)
  })
})

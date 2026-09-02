import type { TableInfo } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { filterTables } from './TableList.tsx'

const t = (name: string): TableInfo => ({
  name,
  kind: 'table',
  rowEstimate: null,
  engine: null,
  comment: null,
  sizeBytes: null,
})

describe('filterTables', () => {
  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const tables = [t('Users'), t('orders'), t('user_roles')]
    expect(filterTables(tables, 'USER').map((x) => x.name)).toEqual(['Users', 'user_roles'])
    expect(filterTables(tables, '  ')).toHaveLength(3)
  })
})

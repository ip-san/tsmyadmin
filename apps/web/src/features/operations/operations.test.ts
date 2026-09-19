import { describe, expect, it } from 'vitest'
import { textColumns } from './CollationOrderForm.tsx'
import { copiedForeignKeys } from './CopyTableForm.tsx'

describe('operations helpers', () => {
  it('lists the text columns (not generated ones) with their types', () => {
    const col = (name: string, dataType: string, generated = false) =>
      ({ name, dataType, generated: generated ? { expression: 'x', stored: true } : null }) as never
    expect(
      textColumns({ columns: [col('id', 'int'), col('name', 'varchar(20)'), col('g', 'text', true), col('b', 'text')] })
    ).toEqual([
      { name: 'name', dataType: 'varchar(20)' },
      { name: 'b', dataType: 'text' },
    ])
  })

  it("names the copy's foreign keys after it and keeps what they reference and their actions", () => {
    const [fk] = copiedForeignKeys(
      {
        foreignKeys: [
          {
            name: 'fk_user',
            columns: ['user_id'],
            refNamespace: { database: 'shop', schema: 'public' },
            refTable: 'users',
            refColumns: ['id'],
            onUpdate: 'NO ACTION',
            onDelete: 'cascade',
          },
        ],
      },
      't_copy'
    )
    expect(fk).toEqual({
      name: 't_copy_fk_user',
      columns: ['user_id'],
      refTable: 'users',
      refDatabase: 'shop',
      refSchema: 'public',
      refColumns: ['id'],
      onUpdate: 'NO ACTION',
      onDelete: 'CASCADE',
    })
  })
})

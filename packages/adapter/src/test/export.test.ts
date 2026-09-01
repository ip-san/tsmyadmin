import { describe, expect, it } from 'vitest'
import { mysqlExporter } from '../mysql/export.ts'
import { pgExporter } from '../postgres/export.ts'

const ns = { database: 'db', schema: 'app' }
const rows = [
  [1, "it's", null, { $bin: 'AQI=' }, true],
  [2, 'plain', 3.5, null, false],
]

describe('SqlExporter.insert', () => {
  it('renders one multi-row INSERT per batch with quoted identifiers and escaped literals', () => {
    expect(mysqlExporter.insert(ns, 'we`ird', ['id', 's', 'n', 'b', 'f'], rows)).toMatchSnapshot()
    expect(pgExporter.insert(ns, 'we"ird', ['id', 's', 'n', 'b', 'f'], rows)).toMatchSnapshot()
  })

  it('returns an empty string for no rows', () => {
    expect(mysqlExporter.insert(ns, 't', ['a'], [])).toBe('')
    expect(pgExporter.insert(ns, 't', ['a'], [])).toBe('')
  })

  it('never lets a value close the statement', () => {
    const evil = "'); DROP TABLE users; --"
    for (const e of [mysqlExporter, pgExporter]) {
      const sql = e.insert(ns, 't', ['a'], [[evil]])
      expect(sql.split('DROP TABLE')).toHaveLength(2)
      expect(sql).toMatch(/\('''\); DROP TABLE users; --'\);$/)
    }
  })
})

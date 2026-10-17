import { describe, expect, it } from 'vitest'
import { PLAN_SQL, plan, reads } from '../test/explain-plans/load.ts'
import { needsFormat1, parseMysqlPlan } from './explain.ts'

describe('parseMysqlPlan', () => {
  describe.each(['mysql-8-4', 'mariadb-10-11', 'mariadb-11-4'])('format 1 (%s)', (server) => {
    it('names the tables behind their aliases, with the index each is read by', () => {
      expect(reads(parseMysqlPlan(plan(`${server}-q1`), PLAN_SQL.q1))).toEqual([
        'users as u by uq_users_email lookup',
        'posts as p by fk_posts_user lookup',
      ])
    })

    it('reads an index range under a sort', () => {
      const p = parseMysqlPlan(plan(`${server}-q2`), PLAN_SQL.q2)
      expect(p.op).toBe('Sort')
      expect(p.children.map((c) => c.op)).toEqual(['Table'])
      expect(reads(p)).toEqual(['users by idx_users_name range'])
      expect(p.children[0]).toMatchObject({ indexColumns: ['name'], estRows: 1 })
      expect(p.children[0]?.detail).toContain('like')
    })

    it('says which table an UPDATE changes, and how it finds the rows', () => {
      const p = parseMysqlPlan(plan(`${server}-q4`), PLAN_SQL.q4)
      expect(p).toMatchObject({ op: 'Update', table: 'posts', index: 'PRIMARY', access: 'range' })
    })
  })

  it('follows the subqueries of format 1, and covering index reads', () => {
    expect(reads(parseMysqlPlan(plan('mysql-8-4-q3'), PLAN_SQL.q3))).toEqual([
      'posts by fk_posts_user fullIndexScan covering',
      'users as u by PRIMARY lookup',
      'posts as p by fk_posts_user lookup covering',
    ])
  })

  it("leaves MariaDB's own tables unnamed, and reads what is materialized into them", () => {
    const p = parseMysqlPlan(plan('mariadb-10-11-q3'), PLAN_SQL.q3)
    expect(reads(p)).toEqual([
      'users as u by idx_users_name fullIndexScan covering',
      'posts by fk_posts_user fullIndexScan covering',
      'posts as p by fk_posts_user lookup covering',
    ])
    expect(p.detail).toBe('(subquery#2) desc')
  })

  it('reads format 2, where the tables are named by the server', () => {
    expect(reads(parseMysqlPlan(plan('mysql-9-q1'), ''))).toEqual(['posts as p by fk_posts_user lookup'])
    const p = parseMysqlPlan(plan('mysql-9-q3'), '')
    expect(reads(p)).toEqual([
      'posts by fk_posts_user fullIndexScan covering',
      'users as u by PRIMARY lookup',
      'posts as p by fk_posts_user lookup covering',
    ])
    expect(p.op).toBe('Sort: n DESC')
  })

  it('asks for format 1 when format 2 has no plan for the statement', () => {
    expect(needsFormat1(plan('mysql-9-q4'))).toBe(true)
    expect(needsFormat1(plan('mysql-9-q1'))).toBe(false)
    expect(needsFormat1(plan('mysql-8-4-q4'))).toBe(false)
    expect(parseMysqlPlan(plan('mysql-9-v1-q4'), PLAN_SQL.q4)).toMatchObject({ op: 'Update', table: 'posts' })
  })

  it('reads a full table scan', () => {
    const raw = { query_block: { table: { table_name: 't', access_type: 'ALL', rows_examined_per_scan: 40 } } }
    expect(parseMysqlPlan(raw, 'SELECT * FROM t')).toMatchObject({
      table: 't',
      access: 'fullScan',
      estRows: 40,
      index: null,
    })
  })

  it('makes a node of anything it does not know, rather than failing', () => {
    expect(parseMysqlPlan({}, '')).toMatchObject({ op: 'Query', children: [] })
    expect(parseMysqlPlan({ query_block: { message: 'No tables used' } }, '').children).toEqual([])
  })
})

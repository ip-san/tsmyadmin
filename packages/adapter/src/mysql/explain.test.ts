import { describe, expect, it } from 'vitest'
import { PLAN_SQL, plan, reads } from '../test/explain-plans/load.ts'
import { measurableMysqlStatement, mysqlExecutionMs, needsFormat1, parseMysqlPlan } from './explain.ts'

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

  it.each([
    ['ALL', 'fullScan'],
    ['index', 'fullIndexScan'],
    ['range', 'range'],
    ['index_merge', 'range'],
    ['system', 'lookup'],
    ['const', 'lookup'],
    ['eq_ref', 'lookup'],
    ['ref', 'lookup'],
    ['ref_or_null', 'lookup'],
    ['fulltext', 'lookup'],
    ['unique_subquery', 'lookup'],
    ['index_subquery', 'lookup'],
    ['something new', 'other'],
  ])('reads access type %s as %s', (type, access) => {
    const raw = { query_block: { table: { table_name: 't', access_type: type } } }
    expect(parseMysqlPlan(raw, '').access).toBe(access)
  })

  it('names the step by what it does to the table', () => {
    const kind = (flag: string) => parseMysqlPlan({ query_block: { table: { table_name: 't', [flag]: true } } }, '').op
    expect([kind('update'), kind('delete'), kind('insert'), kind('other')]).toEqual([
      'Update',
      'Delete',
      'Insert',
      'Table',
    ])
  })

  it('says a sort uses a file and a group a temporary table, and joins the notes', () => {
    const raw = {
      query_block: {
        ordering_operation: {
          using_filesort: true,
          using_temporary_table: true,
          table: { table_name: 't', access_type: 'ALL' },
        },
      },
    }
    expect(parseMysqlPlan(raw, '')).toMatchObject({ op: 'Sort', detail: 'filesort, temporary' })
    const quiet = { query_block: { ordering_operation: { using_filesort: false, table: { table_name: 't' } } } }
    expect(parseMysqlPlan(quiet, '').detail).toBeNull()
    // An ORDER BY the index gives in order: nothing is sorted, and the step does not say it is.
    expect(parseMysqlPlan(quiet, '').op).toBe('Ordered by index')
    // `SELECT DISTINCT age FROM users ORDER BY age` on 8.4: the order comes from the sort under it, not an index.
    const below = {
      query_block: {
        ordering_operation: {
          using_filesort: false,
          duplicates_removal: { using_temporary_table: true, using_filesort: true, table: { table_name: 't' } },
        },
      },
    }
    expect(parseMysqlPlan(below, '').op).toBe('Sort')
    // A subquery's own sort does not order the rows: `SELECT u.id, (SELECT … ORDER BY 1 LIMIT 1) FROM users u ORDER BY u.id`.
    const subquery = {
      query_block: {
        ordering_operation: {
          using_filesort: false,
          table: { table_name: 'u', access_type: 'index' },
          select_list_subqueries: [
            { query_block: { ordering_operation: { using_filesort: true, table: { table_name: 'p' } } } },
          ],
        },
      },
    }
    expect(parseMysqlPlan(subquery, '').op).toBe('Ordered by index')
  })

  it('says how a table is joined through a join buffer: MySQL on the table, MariaDB around it', () => {
    // MySQL 8.4, `p JOIN q ON q.body = p.body` with no index: p is hashed, q read once against it.
    const mysql = {
      query_block: {
        nested_loop: [
          { table: { table_name: 'p', access_type: 'ALL' } },
          { table: { table_name: 'q', access_type: 'ALL', using_join_buffer: 'hash join' } },
        ],
      },
    }
    expect(parseMysqlPlan(mysql, '').children.map((c) => c.op)).toEqual(['Table', 'Table, join buffer (hash join)'])
    const maria = (joinType: string) =>
      parseMysqlPlan(
        {
          query_block: {
            nested_loop: [
              { table: { table_name: 'p', access_type: 'ALL' } },
              { 'block-nl-join': { table: { table_name: 'q', access_type: 'ALL' }, join_type: joinType } },
            ],
          },
        },
        ''
      ).children[1]?.op
    expect([maria('BNL'), maria('BNLH'), maria('BKA'), maria('BKAH')]).toEqual([
      'Block nested loop',
      'Block hash join',
      'Batched key access',
      'Batched key access',
    ])
  })

  it('names a key it does not know by its words, and any list of subqueries as one', () => {
    const raw = {
      query_block: {
        some_new_step: { table: { table_name: 'a' } },
        having_subqueries: [{ query_block: { table: { table_name: 'b' } } }],
      },
    }
    expect(parseMysqlPlan(raw, '').children.map((c) => c.op)).toEqual(['some new step', 'Subquery'])
  })

  it("keeps a server's own table out of the schema's, with its index and access", () => {
    const raw = {
      query_block: { table: { table_name: '<derived2>', access_type: 'ALL', key: 'k', used_key_parts: ['a'] } },
    }
    expect(parseMysqlPlan(raw, '')).toMatchObject({
      op: '<derived2>',
      table: null,
      index: null,
      indexColumns: [],
      access: null,
    })
  })

  it('takes the cost of format 1 from its cost info, and the rows as numbers', () => {
    const raw = {
      query_block: {
        table: { table_name: 't', cost_info: { read_cost: '2.5', prefix_cost: '3.5' }, rows_examined_per_scan: '7' },
      },
    }
    expect(parseMysqlPlan(raw, '')).toMatchObject({ cost: 3.5, estRows: 7 })
    const read = { query_block: { table: { table_name: 't', cost_info: { read_cost: '2.5' }, rows: 'many' } } }
    expect(parseMysqlPlan(read, '')).toMatchObject({ cost: 2.5, estRows: null })
  })

  it('reads the access of format 2 nodes', () => {
    const one = (n: Record<string, unknown>) =>
      parseMysqlPlan({ query_plan: { operation: 'x', table_name: 't', ...n } }, '')
    expect(one({ access_type: 'table' }).access).toBe('fullScan')
    expect(one({ access_type: 'index', index_access_type: 'index_range_scan' }).access).toBe('range')
    expect(one({ access_type: 'index', index_access_type: 'full_text_search' }).access).toBe('other')
    expect(one({ access_type: 'filter' }).access).toBeNull()
    expect(one({ access_type: 'table', condition: '(a > 1)' }).detail).toBe('(a > 1)')
    expect(parseMysqlPlan({ query_plan: { table_name: 't' } }, '').op).toBe('Step')
    // Only `inputs…` lists are steps; other lists (the columns used, the sort fields) are facts.
    const nested = parseMysqlPlan(
      { query_plan: { operation: 'Sort', sort_fields: ['a'], inputs: [{ operation: 'Scan' }] } },
      ''
    )
    expect(nested.children.map((c) => c.op)).toEqual(['Scan'])
  })
})

describe('a measured plan', () => {
  const near = (ms: number | null | undefined, want: number) => expect(ms).toBeCloseTo(want, 9)

  it('reads MySQL format 2 with no query_plan around it, the time of a step made all its loops', () => {
    const raw = plan('mysql-8-4-analyze')
    const p = parseMysqlPlan(raw, PLAN_SQL.analyze)
    expect(reads(p)).toEqual(['posts as p fullScan', 'users as u by PRIMARY lookup'])
    expect(p.actual).toMatchObject({ rows: 3, loops: 1 })
    near(p.actual?.ms, 0.356665)
    const [posts, users] = p.children
    expect(posts?.actual).toMatchObject({ rows: 3, loops: 1 })
    // One user per post, looked up three times: 3 × the average time.
    expect(users?.actual).toMatchObject({ rows: 1, loops: 3 })
    near(users?.actual?.ms, 0.017624666666666667 * 3)
    near(mysqlExecutionMs(raw), 0.356665)
  })

  it("reads MariaDB's ANALYZE: a table's rows per loop, its time reading and checking, and the query's", () => {
    const raw = plan('mariadb-11-analyze')
    const p = parseMysqlPlan(raw, PLAN_SQL.analyze)
    expect(reads(p)).toEqual(['posts as p fullScan', 'users as u by PRIMARY lookup'])
    const [posts, users] = p.children
    expect(posts?.actual).toMatchObject({ rows: 3, loops: 1 })
    near(posts?.actual?.ms, 0.007090683 + 0.00425441)
    expect(users?.actual).toMatchObject({ rows: 1, loops: 3 })
    near(mysqlExecutionMs(raw), 0.018894584)
  })

  it('says nothing measured of an estimate, nor of a step a run never reached', () => {
    expect(parseMysqlPlan(plan('mysql-8-4-q1'), PLAN_SQL.q1).children.some((c) => c.actual)).toBe(false)
    expect(mysqlExecutionMs(plan('mysql-8-4-q1'))).toBeNull()
    const cut = { operation: 'Table scan on t', table_name: 't', actual_rows: null, actual_loops: null }
    expect(parseMysqlPlan(cut, 'SELECT * FROM t').actual).toBeUndefined()
  })
})

describe('measurableMysqlStatement', () => {
  it.each([
    ['an INTO in a comment MySQL runs', 'SELECT 1 /*! INTO @x */'],
    ['a lock in a versioned comment', 'SELECT * FROM t /*!50000 FOR UPDATE */'],
    ['an INTO in a comment MariaDB runs', 'SELECT 1 /*M! INTO @x */'],
    ['a hint that lifts the time limit', 'SELECT /*+ MAX_EXECUTION_TIME(0) */ * FROM t'],
    ['a write, as measurableStatement', 'UPDATE t SET a = 1'],
  ])('refuses %s', (_, sql) => {
    expect(() => measurableMysqlStatement(sql)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })

  it('reads a plain comment as a comment', () => {
    expect(measurableMysqlStatement('SELECT /* why */ 1')).toBe('SELECT /* why */ 1')
  })
})

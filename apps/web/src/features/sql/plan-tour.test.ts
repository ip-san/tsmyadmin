import type { PlanNode } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { relationKey } from '@/components/schema-diagram/layout.ts'
import type { TourScene } from '@/components/schema-diagram/tour.ts'
import { locale } from '@/config/locale-screens.ts'
import { relation } from '@/test/schema-fixtures.ts'
import { planTour } from './plan-tour.ts'

const t = locale.planTour
const p = locale.plan
const node = (n: Partial<PlanNode>): PlanNode => ({
  op: 'Step',
  table: null,
  alias: null,
  index: null,
  indexColumns: [],
  access: null,
  covering: false,
  estRows: null,
  cost: null,
  detail: null,
  children: [],
  ...n,
})
const keys = [relation('posts', ['user_id'], 'users', { name: 'fk_posts_user' })]
const titled = (scenes: TourScene[], title: string) => scenes.find((s) => s.title === title)

// PostgreSQL 17, a join by an e-mail: users by its unique index, then posts read in full for each user.
const loop = node({
  op: 'Nested Loop',
  detail: '(u.id = p.user_id)',
  children: [
    node({
      op: 'Index Scan',
      table: 'users',
      alias: 'u',
      index: 'uq_users_email',
      access: 'range',
      estRows: 1,
      detail: "((email)::text = 'alice@example.com'::text)",
    }),
    node({ op: 'Seq Scan', table: 'posts', alias: 'p', access: 'fullScan', estRows: 3 }),
  ],
})

describe('planTour', () => {
  it('tells the reads in the order the server runs them, between an opening and a summary', () => {
    const { scenes } = planTour({ plan: loop, relations: keys, indexColumns: () => ['email'] })
    const order = t.order('users → posts')
    expect(scenes.map((s) => s.title)).toEqual([t.introTitle, t.readTitle('users'), t.readTitle('posts'), t.endTitle])
    expect(scenes[0]?.text).toBe(t.intro(2, order))
    expect(scenes.at(-1)?.text).toBe(t.end(2, 1))
    expect(scenes.at(-1)?.notes).toEqual([order, p.notes])
  })

  it('lights each table by how it is read, keeps the tables read before, and flows the key it is joined along', () => {
    const { diagram, scenes } = planTour({ plan: loop, relations: keys, indexColumns: () => ['email'] })
    const users = scenes[1]
    expect(users?.overlay.tables.get('users')).toEqual({ tone: 'index', badge: 'uq_users_email' })
    // PostgreSQL names the index only: its columns come from the table's definition, and are listed in the box.
    expect(users?.overlay.columns.get('users')).toEqual(new Set(['email']))
    expect(diagram.columns.get('users')).toContain('email')
    expect(users?.notes).toEqual([
      t.roles.loopOuter('users'),
      t.condition("((email)::text = 'alice@example.com'::text)"),
    ])
    const posts = scenes[2]
    expect(posts?.overlay.tables.get('users')?.tone).toBe('index')
    expect(posts?.overlay.tables.get('posts')).toEqual({ tone: 'scan', badge: p.full })
    // From users (read before) to posts, which refers to it: against the key's direction.
    expect([...(posts?.overlay.flow ?? [])]).toEqual([[relationKey(keys[0] as (typeof keys)[0]), 'back']])
    expect(posts?.frame).toEqual(['posts', 'users'])
  })

  it('says a full read on the inner side of a loop multiplies, and gathers the hints in the summary', () => {
    const { scenes } = planTour({ plan: loop, relations: keys })
    expect(scenes[2]?.notes).toEqual([t.roles.loopInner('posts')])
    expect(scenes[2]?.hints).toEqual([t.loopScan('posts')])
    expect(scenes[1]?.hints).toEqual([])
    expect(scenes.at(-1)?.hints).toEqual([t.loopScan('posts')])
  })

  it('reads the side a hash join builds from first, and says which side is which (PostgreSQL, semi join)', () => {
    const hash = node({
      op: 'Hash Join (Semi)',
      children: [
        node({ op: 'Seq Scan', table: 'users', access: 'fullScan', estRows: 100 }),
        node({ op: 'Hash', children: [node({ op: 'Seq Scan', table: 'posts', access: 'fullScan', estRows: 3 })] }),
      ],
    })
    const { scenes } = planTour({ plan: hash, relations: keys })
    expect(scenes.slice(1, 3).map((s) => [s.title, s.notes])).toEqual([
      [t.readTitle('posts'), [t.roles.hashBuild('posts')]],
      [t.readTitle('users'), [t.roles.hashProbe('users')]],
    ])
    // Each read once: no hint for a full read of a hash join without a condition.
    expect(scenes.at(-1)?.hints).toEqual([])
  })

  it("takes MySQL 8's join buffer on the table it joins, and a full read under a condition as a hint", () => {
    const buffered = node({
      op: 'Nested loop',
      children: [
        node({ op: 'Table', table: 'posts', alias: 'p', access: 'fullScan', detail: "(p.title like 'A%')" }),
        node({ op: 'Table, join buffer (hash join)', table: 'posts', alias: 'q', access: 'fullScan' }),
      ],
    })
    const { scenes } = planTour({ plan: buffered, relations: keys })
    expect(scenes[1]?.notes).toEqual([t.roles.loopOuter('posts'), t.condition("(p.title like 'A%')")])
    expect(scenes[1]?.hints).toEqual([t.filterScan('posts')])
    expect(scenes[2]?.notes).toEqual([t.roles.hashBuffer('posts')])
    expect(scenes[2]?.hints).toEqual([])
    const block = planTour({
      plan: node({
        op: 'Nested loop',
        children: [
          node({ op: 'Table', table: 'users', access: 'lookup', index: 'PRIMARY' }),
          node({ op: 'Block nested loop', children: [node({ op: 'Table', table: 'posts', access: 'fullScan' })] }),
        ],
      }),
      relations: keys,
    }).scenes
    expect(block[2]?.notes).toEqual([t.roles.blockInner('posts')])
    expect(block[2]?.hints).toEqual([t.blockScan('posts')])
  })

  it('tells what is done with the rows after reading them, in the order it is done, once each', () => {
    // MySQL 8.4: a sort by a file over a group in a temporary table, over a join and a subquery.
    const sorted = node({
      op: 'Sort',
      detail: 'filesort',
      children: [
        node({
          op: 'Group',
          detail: 'temporary',
          children: [
            node({
              op: 'Nested loop',
              children: [
                node({ op: 'Table', table: 'posts', access: 'fullIndexScan', index: 'fk_posts_user' }),
                node({ op: 'Table', table: 'users', access: 'lookup', index: 'PRIMARY' }),
              ],
            }),
            node({ op: 'Subquery', children: [node({ op: 'Table', table: 'posts', access: 'lookup' })] }),
          ],
        }),
      ],
    })
    const { scenes } = planTour({ plan: sorted, relations: keys })
    const finish = titled(scenes, t.finishTitle)
    expect(finish?.text).toBe(t.finish([t.finishSteps.group, t.finishSteps.temporary, t.finishSteps.sort]))
    expect(finish?.notes).toEqual([t.finishNotes.group, t.finishNotes.temporary, t.finishNotes.sort])
    expect(finish?.hints).toEqual([t.temporaryHint, t.sortHint])
    // posts is read twice: lit as it was read last.
    expect(scenes.filter((s) => s.pulse.includes('posts'))).toHaveLength(2)
    // The second, in the subquery: it may be read again for each user.
    expect(scenes.filter((s) => s.pulse.includes('posts')).map((s) => s.notes?.[0])).toEqual([
      t.roles.loopOuter('posts'),
      t.subquery,
    ])
    expect(scenes.at(-1)?.overlay.tables.get('posts')?.badge).toBe(p.full)
    expect(scenes.at(-1)?.text).toBe(t.end(3, 1))
  })

  it('says nothing of a step that orders by its index, of a table the server reads for itself, or of a row count it does not give', () => {
    const quiet = node({
      op: 'Ordered by index',
      children: [
        node({
          op: '<subquery3>',
          children: [node({ op: 'Update', table: 'posts', access: 'range', index: 'PRIMARY' })],
        }),
      ],
    })
    const { scenes } = planTour({ plan: quiet, relations: [] })
    expect(scenes.map((s) => s.title)).toEqual([t.introTitle, t.readTitle('posts'), t.endTitle])
    expect(scenes[1]?.text).toBe(p.read('posts', p.how.range('PRIMARY'), ''))
    expect(scenes[1]?.notes).toEqual([])
  })

  it('takes the finishing steps from the operation, not from a condition that names them', () => {
    const plan = node({
      op: "Filter: (t.status = 'temporary')",
      children: [
        node({
          op: 'Sort row IDs',
          children: [
            node({
              op: 'Nested Loop',
              children: [
                node({ op: 'Seq Scan', table: 'users', access: 'fullScan' }),
                node({ op: 'Materialize', children: [node({ op: 'Seq Scan', table: 'posts', access: 'fullScan' })] }),
              ],
            }),
          ],
        }),
      ],
    })
    const { scenes } = planTour({ plan, relations: [] })
    expect(titled(scenes, t.finishTitle)).toBeUndefined()
    // Under a Materialize the rows are kept once read: not read again for each user.
    expect(scenes[2]?.hints).toEqual([])
  })

  it('does not take the condition of a table joined by a hash for a filter', () => {
    const plan = node({
      op: 'Hash Join',
      children: [
        node({ op: 'Seq Scan', table: 'users', access: 'fullScan' }),
        node({ op: 'Hash', children: [node({ op: 'Seq Scan', table: 'posts', access: 'fullScan', detail: 'x = 1' })] }),
      ],
    })
    expect(planTour({ plan, relations: [] }).scenes.at(-1)?.hints).toEqual([])
  })

  it("says the order is the plan's where MySQL 8 does not say which side of its hash join comes first", () => {
    const plan = node({
      op: 'Nested loop',
      children: [
        node({ op: 'Table', table: 'users', access: 'fullScan' }),
        node({ op: 'Table, join buffer (hash join)', table: 'posts', access: 'fullScan' }),
      ],
    })
    expect(planTour({ plan, relations: [] }).scenes[0]?.text).toBe(t.intro(2, t.orderListed('users → posts')))
  })

  it('cuts a long condition short', () => {
    const long = 'x'.repeat(300)
    const { scenes } = planTour({
      plan: node({ op: 'Seq Scan', table: 'users', access: 'fullScan', detail: long }),
      relations: [],
    })
    const said = scenes[1]?.notes?.[0] ?? ''
    expect(said).toBe(t.condition(`${'x'.repeat(119)}…`))
  })
})

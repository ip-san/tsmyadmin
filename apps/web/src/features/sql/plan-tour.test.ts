import type { PlanNode } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { relationKey } from '@/components/schema-diagram/layout.ts'
import type { TourScene } from '@/components/schema-diagram/tour.ts'
import { chaptersOf } from '@/components/schema-diagram/tour.ts'
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
    // Nothing done after the reads: one chapter, and the video is not split.
    expect(chaptersOf(scenes)).toEqual([{ title: t.chapters.reads, from: 0, to: 4 }])
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
    expect(scenes[1]?.notes).toEqual([t.condition("(p.title like 'A%')")])
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
    // What is done after the reads is a chapter of its own, the summary with it.
    expect(chaptersOf(scenes).map((c) => [c.title, c.to - c.from])).toEqual([
      [t.chapters.reads, scenes.length - 2],
      [t.chapters.after, 2],
    ])
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

  it("says PostgreSQL's Memoize uses the rows of a value again, and keeps the read per row", () => {
    const plan = node({
      op: 'Nested Loop',
      children: [
        node({ op: 'Seq Scan', table: 'users', access: 'fullScan' }),
        node({ op: 'Memoize', children: [node({ op: 'Seq Scan', table: 'posts', access: 'fullScan' })] }),
      ],
    })
    const posts = planTour({ plan, relations: [] }).scenes[2]
    expect(posts?.notes).toEqual([t.memoized('posts')])
    expect(posts?.hints).toEqual([t.memoScan('posts')])
  })

  it('names the temporary table of a MySQL 9 aggregate, and a full read repeated under a loop by a hint of its own', () => {
    const plan = node({
      op: 'Aggregate using temporary table',
      children: [
        node({
          op: 'Nested loop inner join',
          children: [
            node({ op: 'Table scan on a', table: 'a', access: 'fullScan' }),
            node({
              op: 'Inner hash join',
              children: [
                node({ op: 'Table scan on b', table: 'b', access: 'fullScan' }),
                node({ op: 'Hash', children: [node({ op: 'Table scan on c', table: 'c', access: 'fullScan' })] }),
              ],
            }),
          ],
        }),
      ],
    })
    const { scenes } = planTour({ plan, relations: [] })
    expect(titled(scenes, t.finishTitle)?.notes).toEqual([t.finishNotes.group, t.finishNotes.temporary])
    expect(titled(scenes, t.readTitle('c'))?.notes).toEqual([t.repeated, t.roles.hashBuild('c')])
    expect(titled(scenes, t.readTitle('c'))?.hints).toEqual([t.repeatedScan('c')])
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

  describe("with the tables' estimated rows", () => {
    const w = locale.designReading
    const scan = (n: Partial<PlanNode> = {}) =>
      node({ op: 'Seq Scan', table: 'logs', access: 'fullScan', estRows: 50000, ...n })
    const hintsOf = (plan: PlanNode, rows: ReadonlyMap<string, number>) =>
      titled(planTour({ plan, relations: [], rows }).scenes, t.readTitle('logs'))?.hints
    const stale = t.staleStats('logs', 50000, 10000)
    const listed = new Map([['logs', 10000]])

    it('says the size of each table the first time it is read, after what the plan says of the read', () => {
      const rows = new Map([
        ['users', 2000],
        ['posts', 9000],
      ])
      const twice = node({
        op: 'Append',
        children: [loop, node({ op: 'Seq Scan', table: 'users', access: 'fullScan' })],
      })
      const reads = planTour({ plan: twice, relations: keys, rows })
        .scenes.filter((s) => s.title.length > 0)
        .slice(1, 4)
      expect(reads.map((s) => s.notes?.at(-1))).toEqual([
        w.rows('users', 2000),
        w.rows('posts', 9000),
        // users again: said once.
        undefined,
      ])
      expect(reads[0]?.notes?.slice(0, -1)).toEqual(planTour({ plan: twice, relations: keys }).scenes[1]?.notes)
    })

    it('says a full read with no condition whose rows are far from the table list may be on old statistics', () => {
      expect(hintsOf(scan(), listed)).toEqual([stale])
      // Either way: the plan counting fewer.
      expect(hintsOf(scan({ estRows: 4000 }), listed)).toEqual([t.staleStats('logs', 4000, 10000)])
      // And in the summary.
      expect(planTour({ plan: scan(), relations: [], rows: listed }).scenes.at(-1)?.hints).toEqual([stale])
    })

    it('says nothing of the statistics where the two are near, small, or not of the whole table', () => {
      expect(hintsOf(scan({ estRows: 19999 }), listed)).toEqual([])
      // Two times apart is enough; so is 1,000 rows on the smaller side, and not 999.
      expect(hintsOf(scan({ estRows: 20000 }), listed)).toEqual([t.staleStats('logs', 20000, 10000)])
      expect(hintsOf(scan({ estRows: 2000 }), new Map([['logs', 1000]]))).toEqual([t.staleStats('logs', 2000, 1000)])
      expect(hintsOf(scan({ estRows: 2000 }), new Map([['logs', 999]]))).toEqual([])
      expect(hintsOf(scan({ estRows: 5001 }), listed)).toEqual([])
      expect(hintsOf(scan({ estRows: 900 }), new Map([['logs', 100]]))).toEqual([])
      expect(hintsOf(scan(), new Map())).toEqual([])
      // A condition: the plan's rows are those left.
      expect(hintsOf(scan({ detail: "(kind = 'x')" }), listed)).toEqual([t.filterScan('logs')])
      // Through an index, and split between workers.
      expect(hintsOf(scan({ access: 'range', index: 'ix' }), listed)).toEqual([])
      expect(hintsOf(scan({ op: 'Parallel Seq Scan' }), listed)).toEqual([])
      // Under a limit: not said, to be safe.
      expect(hintsOf(node({ op: 'Limit', children: [scan()] }), listed)).toEqual([])
    })
  })

  describe('measured by running it', () => {
    // The same join, run: users as expected, posts far over its estimate and most of the time.
    const run = node({
      ...loop,
      actual: { rows: 3, loops: 1, ms: 40 },
      children: [
        { ...(loop.children[0] as PlanNode), actual: { rows: 1, loops: 1, ms: 2 } },
        { ...(loop.children[1] as PlanNode), estRows: 3, actual: { rows: 48_000, loops: 1, ms: 30 } },
      ],
    })
    const measured = (measuredMs: number | null = 40) =>
      planTour({ plan: run, relations: keys, indexColumns: () => ['email'], measuredMs }).scenes

    it('says it was run, and each read beside its estimate, with what was far off and where the time went', () => {
      const scenes = measured()
      expect(scenes[0]?.text).toBe(t.introMeasured(2, t.order('users → posts'), p.duration(40)))
      expect(titled(scenes, t.readTitle('users'))?.notes).toContain(t.measuredRead(1, p.actual(1, 1, p.duration(2))))
      const posts = titled(scenes, t.readTitle('posts'))
      expect(posts?.notes).toContain(t.measuredRead(3, p.actual(48_000, 1, p.duration(30))))
      expect(posts?.hints?.slice(0, 2)).toEqual([
        t.misestimate('posts', 3, 48_000, p.off(16_000, true)),
        t.heavy('posts', 75),
      ])
      // users was as expected and quick: nothing to say of it.
      expect(titled(scenes, t.readTitle('users'))?.hints?.some((h) => h.includes(p.off(1, true)))).toBe(false)
    })

    it('ends with the estimates against the run, the tables to look at framed, in a chapter of its own', () => {
      const scenes = measured()
      const summary = titled(scenes, t.measuredTitle)
      expect(summary?.text).toBe(t.measuredSummary(1, 10, 'posts', 75))
      expect(summary?.frame).toEqual(['posts'])
      expect(summary?.notes).toEqual([
        `users: ${t.measuredRead(1, p.actual(1, 1, p.duration(2)))}`,
        `posts: ${t.measuredRead(3, p.actual(48_000, 1, p.duration(30)))}`,
      ])
      expect(chaptersOf(scenes).map((c) => c.title)).toEqual([t.chapters.reads, t.chapters.measured])
      expect(scenes.at(-1)?.notes).toContain(p.notesMeasured)
      // The summary after it gathers the hints, the misestimate among them.
      expect(scenes.at(-1)?.hints).toContain(t.misestimate('posts', 3, 48_000, p.off(16_000, true)))
    })

    it('tells a run of no time, and an estimate as it always did', () => {
      const untimed = measured(null)
      expect(untimed[0]?.text).toBe(t.introMeasured(2, t.order('users → posts'), null))
      // A run of no time, or too short for a share to mean anything: no read named as the longest.
      expect(titled(untimed, t.measuredTitle)?.text).toBe(t.measuredSummary(1, 10, null, null))
      expect(titled(measured(9), t.measuredTitle)?.text).toBe(t.measuredSummary(1, 10, null, null))
      expect(titled(measured(9), t.readTitle('posts'))?.hints).not.toContain(t.heavy('posts', 100))
      // Not measured: no measured chapter, the estimate's words.
      const estimated = planTour({ plan: loop, relations: keys, indexColumns: () => ['email'] }).scenes
      expect(titled(estimated, t.measuredTitle)).toBeUndefined()
      expect(estimated[0]?.text).toBe(t.intro(2, t.order('users → posts')))
      expect(estimated.at(-1)?.notes).toContain(p.notes)
    })
  })
})

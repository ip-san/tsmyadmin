import type { PlanNode, RelationDef } from '@tsmyadmin/shared'
import { diagramFor, type Tone } from '@/components/schema-diagram/overlay.ts'
import { openChapter, overlay, type TourScene, unique, whole } from '@/components/schema-diagram/tour.ts'
import { locale } from '@/config/locale-screens.ts'
import { type RowEstimates, rowsOf, rowsReading } from '@/lib/row-estimates.ts'
import { heavyShare, MISESTIMATE_RATIO, misestimate, shareOf } from './plan-measure.ts'
import { type PlanRead, planReads, planSteps } from './plan-steps.ts'
import { type TrialInput, trialScenes } from './plan-tour-trial.ts'

const t = locale.planTour

/** A condition is said up to this long: the server writes them out in full, with every name qualified. */
const CONDITION_CHARS = 120
const cut = (s: string) => (s.length > CONDITION_CHARS ? `${s.slice(0, CONDITION_CHARS - 1)}…` : s)

/**
 * What a step that reads no table does with the rows, by the name of its operation across the servers (anchored:
 * a condition in an operation's name, such as MySQL 9's `Filter: (status = 'temporary')`, is not one), and by the
 * notes the MySQL format puts on a step (`filesort`, `temporary`).
 */
type Finish = keyof typeof t.finishSteps
const FINISH: readonly (readonly [Finish, RegExp, string?])[] = [
  // Not MySQL 9's `Sort row IDs`, which orders the rows to read, not the result.
  ['sort', /^(incremental )?sort\b(?! row ids)/i, 'filesort'],
  ['group', /^(group|aggregate|hashaggregate)\b/i],
  ['distinct', /^(unique|distinct)\b|^remove duplicates|^sort with duplicate removal|with deduplication$/i],
  ['temporary', /^temporary table\b|<temporary>|^aggregate using temporary table\b/i, 'temporary'],
  ['limit', /^limit\b/i],
]

/** The finishing steps of a plan, in the order they first run (children before their parent). */
function finishes(plan: PlanNode): Finish[] {
  const out: Finish[] = []
  const walk = (n: PlanNode) => {
    n.children.forEach(walk)
    if (n.access !== null) return
    const notes = (n.detail ?? '').split(', ')
    for (const [kind, re, note] of FINISH) if (re.test(n.op) || (note && notes.includes(note))) out.push(kind)
  }
  walk(plan)
  return [...new Set(out)]
}

/**
 * Where a full read is the cost: once per row before it, once per buffer, or before a condition is applied (only
 * where the read is not joined by a hash or a merge: there the condition may be the join's own).
 */
function readHint(read: PlanRead): string | null {
  const { node: n, join, repeated } = read
  if (n.access !== 'fullScan') return null
  if (join === 'loopInner') return read.memoized ? t.memoScan(n.table) : t.loopScan(n.table)
  if (repeated) return t.repeatedScan(n.table)
  if (join === 'blockInner') return t.blockScan(n.table)
  return n.detail && (join === null || join === 'loopOuter') ? t.filterScan(n.table) : null
}

/** Below this many rows, a gap between two estimates is noise, not a sign. */
const STALE_FLOOR = 1000
/** How far apart the two estimates must be, either way, to be said. */
const STALE_RATIO = 2

/**
 * Where the plan's rows for a whole table and the table list's estimate are far apart: one of the two counts is
 * old (PostgreSQL scales its count by the table's pages now; MySQL's list is cached apart from the optimizer's).
 * Only a full read with no condition, not split between workers (`Parallel …`: rows per worker): there the plan's
 * rows are the table's. Not in a plan that stops at a limit, to be safe: a server may count only the rows read
 * before it stops (PostgreSQL and MySQL 8.4 count the whole table; MySQL's format 1 has no step for the limit).
 */
function staleHint(read: PlanRead, rows: RowEstimates | undefined, limited: boolean): string | null {
  const n = read.node
  if (limited || n.access !== 'fullScan' || n.detail || n.estRows === null || /^parallel /i.test(n.op)) return null
  const listed = rowsOf(rows, n.table)
  if (!listed || listed.counted) return null
  const [plan, list] = [Math.round(n.estRows), listed.n]
  if (Math.min(plan, list) < STALE_FLOOR || Math.max(plan, list) < STALE_RATIO * Math.min(plan, list)) return null
  return t.staleStats(n.table, plan, list)
}

export interface PlanTourInput {
  plan: PlanNode
  /** The database's foreign keys: those between the tables read are drawn, and flow as a join goes along them. */
  relations: readonly RelationDef[]
  /** An index's columns where the plan names only the index (PostgreSQL). */
  indexColumns?: (table: string, index: string) => readonly string[]
  /** The tables' estimated rows (`rowEstimates`), where the list of tables could be read. */
  rows?: RowEstimates | undefined
  /** The plan was measured by running it: the time of the run (null where the server does not say). */
  measuredMs?: number | null | undefined
  /** An index tried: the plan is the run after it was made, told beside the run before (with `measuredMs`). */
  trial?: TrialInput | undefined
}

/** What a measured read did, beside what was expected of it. */
function measuredNote(node: PlanNode): string | null {
  const a = node.actual
  if (!a) return null
  const time = a.ms === null ? null : locale.plan.duration(a.ms)
  return t.measuredRead(node.estRows, locale.plan.actual(a.rows, a.loops, time))
}

/** Where a measured read was far off its estimate, or took most of the run. */
function measuredHints(node: PlanNode & { table: string }, totalMs: number | null | undefined): string[] {
  const off = misestimate(node)
  const share = heavyShare(node, totalMs)
  return [
    ...(off ? [t.misestimate(node.table, off.expected, off.actual, locale.plan.off(off.factor, off.more))] : []),
    ...(share === null ? [] : [t.heavy(node.table, share)]),
  ]
}

/**
 * A statement's plan told as a presentation, in the order the server runs it: the tables it reads (each lit by how
 * it is read, with the index as its badge), how each is joined to the rows before it, what is done with the rows
 * after, and where a full read is the cost. The counterpart of the query tab's presentation, which tells the logical
 * order; this is the order the server chose. Estimated: the statement is not run. With the tables' estimated rows,
 * each table is said with its size the first time it is read (beside the rows the plan expects from the read: how
 * far it narrows), and a full read whose rows are far from the table's is said as perhaps old statistics.
 */
export function planTour({ plan, relations, indexColumns, rows, measuredMs, trial }: PlanTourInput): {
  diagram: ReturnType<typeof diagramFor>
  scenes: TourScene[]
} {
  const reads = planReads(plan)
  const steps = planSteps(reads, indexColumns)
  // An index tried: the tables read before it are drawn too, and its columns, used or not.
  const tables = unique([...reads, ...(trial ? planReads(trial.before.plan) : [])].map((r) => r.node.table))
  const extra = new Map<string, string[]>()
  const marked = [
    ...steps.flatMap((s) => s.columns ?? []),
    ...(trial?.index.columns ?? []).map((column) => ({ table: trial?.index.table ?? '', column })),
  ]
  for (const c of marked) extra.set(c.table, unique([...(extra.get(c.table) ?? []), c.column]))
  const diagram = diagramFor(tables, relations, extra)
  const drawn = diagram.relations
  const list = reads.map((r) => r.node.table).join(' → ')
  // MySQL 8 does not say which side of its hash join is read first: the order is the plan's, not a claim.
  const order = reads.some((r) => r.join === 'hashBuffer') ? t.orderListed(list) : t.order(list)
  const measured = measuredMs !== undefined
  const runTime = measuredMs == null ? null : locale.plan.duration(measuredMs)

  const scenes: TourScene[] = [
    {
      title: t.introTitle,
      text: measured ? t.introMeasured(reads.length, order, runTime) : t.intro(reads.length, order),
      frame: [],
      ...(trial && measured ? { notes: [t.trialIntro(trial.index.name)] } : {}),
      overlay: whole(true),
      pulse: [],
    },
  ]
  // Each table as last read: a later read of the same table is lit as it is read then.
  const lit = new Map<string, readonly [Tone, string]>()
  const hinted: string[] = []
  const limited = finishes(plan).includes('limit')
  reads.forEach((r, i) => {
    const { node, join, subquery, repeated } = r
    const step = steps[i]
    const read = step?.tables?.[0]
    const before = reads.slice(0, i).map((r) => r.node.table)
    // The key between this table and the latest one read before it that a key reaches.
    const key = [...before]
      .reverse()
      .flatMap((other) =>
        other === node.table
          ? []
          : drawn.filter(
              (r) =>
                (r.table === node.table && r.refTable === other) || (r.table === other && r.refTable === node.table)
            )
      )[0]
    const notes = [
      subquery === 'perRow' ? t.subquery : subquery === 'once' ? t.initPlan : null,
      repeated && join !== 'loopInner' ? t.repeated : null,
      // Under Memoize the loop looks up each new value, not each row: said in place of the loop's sentence.
      r.memoized && join === 'loopInner' ? t.memoized(node.table) : join ? t.roles[join](node.table) : null,
      node.detail ? t.condition(cut(node.detail)) : null,
      measuredNote(node),
      // The table's size, once: the first time it is read.
      ...(before.includes(node.table) ? [] : rowsReading(rows, node.table)),
    ]
    const hints = [
      ...measuredHints(node, measuredMs),
      ...[readHint(r), staleHint(r, rows, limited)].filter((h): h is string => h !== null),
    ]
    hinted.push(...hints)
    if (read) lit.set(node.table, [read.tone, read.badge ?? locale.plan.full])
    scenes.push({
      title: t.readTitle(node.table),
      text: step?.text ?? '',
      frame: key ? [key.table, key.refTable] : [node.table],
      overlay: overlay({
        tables: [...lit].map(([name, [tone, badge]]) => [name, tone, badge] as const),
        relations: key ? [[key, 'focus']] : [],
        // Along the key, from the table read before to this one.
        flow: key ? [[key, key.refTable === node.table ? 'forward' : 'back']] : [],
        columns: (step?.columns ?? []).map((c) => [c.table, [c.column]] as const),
      }),
      pulse: [node.table],
      notes: notes.filter((n): n is string => n !== null),
      hints,
    })
  })

  const finishing = finishes(plan)
  const all = [...lit].map(([name, [tone, badge]]) => [name, tone, badge] as const)
  const finishAt = scenes.length
  if (finishing.length > 0) {
    const hints = finishing.flatMap((f) => (f === 'sort' ? [t.sortHint] : f === 'temporary' ? [t.temporaryHint] : []))
    hinted.push(...hints)
    scenes.push({
      title: t.finishTitle,
      text: t.finish(finishing.map((f) => t.finishSteps[f])),
      frame: [],
      overlay: overlay({ tables: all }),
      pulse: [],
      notes: finishing.map((f) => t.finishNotes[f]),
      hints,
    })
  }

  // Measured: what the run showed against what was expected, with the tables to look at framed.
  const measuredAt = scenes.length
  if (measured) {
    const off = reads.filter((r) => misestimate(r.node))
    // The longest of the table reads, named only where the run was long enough for its share to mean anything.
    const timed = reads.filter((r) => shareOf(r.node, measuredMs) !== null)
    const heaviest = timed.reduce<PlanRead | null>(
      (top, r) => ((r.node.actual?.ms ?? 0) > (top?.node.actual?.ms ?? -1) ? r : top),
      null
    )
    const percent = heaviest ? shareOf(heaviest.node, measuredMs) : null
    const looked = unique([...off.map((r) => r.node.table), ...(heaviest ? [heaviest.node.table] : [])])
    scenes.push({
      title: t.measuredTitle,
      text: t.measuredSummary(off.length, MISESTIMATE_RATIO, heaviest?.node.table ?? null, percent),
      frame: looked,
      overlay: overlay({ tables: all }),
      pulse: looked,
      notes: reads.flatMap((r) => {
        const note = measuredNote(r.node)
        return note ? [`${r.node.table}: ${note}`] : []
      }),
    })
  }

  // Tried: the run before the index beside this one, after the reads of this one are told.
  const trialAt = scenes.length
  if (trial && measured) scenes.push(...trialScenes({ plan, ms: measuredMs ?? null }, trial, indexColumns))

  const full = reads.filter((r) => r.node.access === 'fullScan' || r.node.access === 'fullIndexScan').length
  scenes.push({
    title: t.endTitle,
    text: t.end(reads.length, full),
    frame: [],
    overlay: { ...overlay({ tables: all }), fade: false },
    pulse: [],
    notes: [order, measured ? locale.plan.notesMeasured : locale.plan.notes],
    hints: unique(hinted),
  })
  // Its chapters: the reads, and what is done after them (the summary with it).
  openChapter(scenes, 0, t.chapters.reads)
  if (finishing.length > 0) openChapter(scenes, finishAt, t.chapters.after)
  if (measured) openChapter(scenes, measuredAt, t.chapters.measured)
  if (trial && measured) openChapter(scenes, trialAt, t.chapters.trial)
  return { diagram, scenes }
}

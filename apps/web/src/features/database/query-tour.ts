import type { FilterOp, QueryBuilderRequestInput, QueryJoinStep, RelationDef, TableSchema } from '@tsmyadmin/shared'
import { diagramFor } from '@/components/schema-diagram/overlay.ts'
import { openChapter, overlay, type TourScene, unique, whole } from '@/components/schema-diagram/tour.ts'
import { locale } from '@/config/locale-screens.ts'
import { keyIntent, keyTuning, named, tableReading } from '@/lib/design-reading.ts'
import { conditionText, valueShape } from '@/lib/filter-values.ts'
import { indexed } from '@/lib/key-index.ts'
import { perRowReading, type RowEstimates, rowsOf, rowsReading } from '@/lib/row-estimates.ts'

const t = locale.queryTour

type Ref = { table: string; column: string }
const dotted = (r: Ref) => `${r.table}.${r.column}`

/** A join spelled out is drawn as a line, but is not a foreign key: its name starts with NUL, which no key's does. */
const SPELLED = '\u0000join:'

/**
 * The line a join step is drawn as: the foreign key it went along, or one made for a join spelled out (from the
 * table joined to the one it is joined to, on the pairs between the two). Undefined for a join on its own columns.
 */
function stepRelation(step: QueryJoinStep, keys: readonly RelationDef[]): RelationDef | undefined {
  if (step.key) {
    const { table, name } = step.key
    return keys.find((r) => r.table === table && r.name === name)
  }
  const pairs = step.on.flatMap((p) => {
    if (p.a.table === p.b.table) return []
    return [p.a.table === step.table ? { mine: p.a, theirs: p.b } : { mine: p.b, theirs: p.a }]
  })
  const other = pairs[0]?.theirs.table
  if (!other) return undefined
  const between = pairs.filter((p) => p.theirs.table === other)
  return {
    name: `${SPELLED}${step.table}`,
    table: step.table,
    columns: between.map((p) => p.mine.column),
    refTable: other,
    refColumns: between.map((p) => p.theirs.column),
    refNamespace: { database: '' },
    onDelete: null,
    onUpdate: null,
  }
}

/** The rows a query gives so far, by the estimates; `atMost` where a join may have dropped some. */
type Running = { n: number; atMost: boolean }

/**
 * The rows after a join along a key, from the rows before it and the two tables' rows (the rows of the table that
 * refers per row of the other, spread evenly). Joining the table that refers multiplies by that average (in a LEFT
 * JOIN, a row with none still gives one; one to one, never more than one); joining the table referred to gives a
 * row at most (an INNER JOIN on a key that may be NULL drops some). Undefined where it cannot be told: no numbers,
 * a RIGHT JOIN (the rows of the table joined decide), or a join on columns of its own.
 */
function joinedRows(
  before: Running | undefined,
  step: QueryJoinStep,
  relation: RelationDef | undefined,
  intent: { oneToOne: boolean | undefined; required: boolean | undefined } | undefined,
  rows: RowEstimates | undefined
): Running | undefined {
  if (!before || !relation || !intent || step.kind === 'right') return undefined
  const child = rowsOf(rows, relation.table)
  const parent = rowsOf(rows, relation.refTable)
  if (!child || !parent || parent.n === 0) return undefined
  if (relation.table === step.table) {
    const per = intent.oneToOne ? Math.min(child.n / parent.n, 1) : child.n / parent.n
    return { n: before.n * (step.kind === 'left' ? Math.max(per, 1) : per), atMost: before.atMost }
  }
  return { n: before.n, atMost: before.atMost || (step.kind === 'inner' && intent.required !== true) }
}

/** The rows so far as said: rounded to two significant digits past a hundred, an estimate is not exact. */
function roughly(n: number): number {
  if (n < 100) return Math.round(n)
  const step = 10 ** (Math.floor(Math.log10(n)) - 1)
  return Math.round(n / step) * step
}

const opWords = (op: FilterOp) => locale.search.ops[op]

/** A condition in words: the column, the operator and what was typed (a list in parentheses). */
function conditionWords(c: {
  table: string
  column: string
  op: FilterOp
  value?: string | undefined
  values?: string[] | undefined
}) {
  const shape = valueShape(c.op)
  const text = conditionText(c)
  const value = shape === 'none' ? '' : shape === 'list' ? `(${text})` : `'${text}'`
  return t.condition(dotted(c), opWords(c.op), value)
}

export interface QueryTourInput {
  request: QueryBuilderRequestInput
  /** How the server joins the tables, in order (`buildQuery`'s `joins`). */
  joins: readonly QueryJoinStep[]
  /** The definitions of the tables chosen. */
  schemas: ReadonlyMap<string, TableSchema>
  /** The foreign keys between the tables chosen (`drawnRelations`). */
  keys: readonly RelationDef[]
  /** The tables' estimated rows (`rowEstimates`), where the list of tables could be read. */
  rows?: RowEstimates
}

/**
 * A query of the query tab told in the logical order SQL works it, not the order it is written: the table it
 * starts from, each table joined (and whether that can multiply the rows, or drop them), the conditions that keep
 * rows (and what they undo of a LEFT JOIN), the order, and the columns taken. Read from the definitions and the
 * plan of joins the server writes; no rows are read.
 */
export function queryTour({ request, joins, schemas, keys, rows }: QueryTourInput): {
  diagram: ReturnType<typeof diagramFor>
  scenes: TourScene[]
} {
  const tables = [...request.tables]
  const first = tables[0] ?? ''
  const columns = request.columns ?? []
  const where = request.where ?? []
  const comment = (table: string) => named(table, schemas.get(table)?.comment)
  const relations = joins.map((step) => stepRelation(step, keys))
  const drawn = [...keys, ...relations.filter((r): r is RelationDef => r?.name.startsWith(SPELLED) === true)]
  // The columns a scene marks are listed in their boxes.
  const used = new Map<string, string[]>()
  const use = (r: Ref) => used.set(r.table, unique([...(used.get(r.table) ?? []), r.column]))
  for (const c of columns) use(c)
  for (const c of where.flat()) use(c)
  for (const step of joins) for (const p of step.on) [p.a, p.b].forEach(use)
  const diagram = diagramFor(tables, drawn, used)

  const scenes: TourScene[] = [
    {
      title: t.introTitle,
      text: t.intro(tables.length, comment(first)),
      frame: [],
      overlay: whole(true),
      pulse: [],
    },
    {
      title: t.fromTitle(first),
      text: t.from(comment(first)),
      frame: [first],
      overlay: overlay({ tables: [[first, 'focus']] }),
      pulse: [first],
      notes: [
        ...rowsReading(rows, first, comment),
        ...(schemas.get(first) ? tableReading(schemas.get(first) as TableSchema) : []),
      ],
    },
  ]

  // What the joins say of the rows, gathered for the summary.
  const said: string[] = []
  const hinted: string[] = []
  // The tables an outer join may leave all NULL in a row: the one a LEFT JOIN joins, the ones before a RIGHT JOIN.
  const nullable = new Set<string>()
  // The rows so far, by the estimates: from the table it starts from, through each join while it can be told.
  const start = rowsOf(rows, first)
  let running: Running | undefined = start ? { n: start.n, atMost: false } : undefined
  joins.forEach((step, i) => {
    const before = [first, ...joins.slice(0, i).map((s) => s.table)]
    const relation = relations[i]
    const on = step.on.map((p) => `${dotted(p.a)} = ${dotted(p.b)}`).join(t.and)
    const notes: string[] = [step.key ? t.alongKey(step.key.name) : t.spelled]
    const hints: string[] = []
    const intent = relation && step.key ? keyIntent(relation, schemas.get(relation.table)) : undefined
    running = joinedRows(running, step, relation, intent, rows)
    if (relation && step.key && intent) {
      const child = relation.table
      const parent = relation.refTable
      const childSchema = schemas.get(child)
      // The table joined is the one that refers: a row of the other may meet many of its rows.
      if (child === step.table)
        notes.push(
          intent.oneToOne ? t.oneToOne(comment(parent), comment(child)) : t.multiplies(comment(parent), comment(child))
        )
      else {
        notes.push(t.atMostOne(comment(child), comment(parent)))
        // A row whose key is NOT NULL always finds its parent, unless the row itself may be NULL by an outer join.
        if (step.kind === 'left' && intent.required && !nullable.has(child))
          notes.push(t.leftAlwaysFound(child, parent))
      }
      // How much, by the estimates: the rows of the table that refers per row of the other.
      notes.push(...perRowReading(rows, child, parent, comment))
      if (child === step.table && intent.oneToOne === false) said.push(t.multiplies(comment(parent), comment(child)))
      // An index on the key matters where the rows that refer are looked up: when they are the ones joined.
      // How many rows a missing index reads only where they are looked up (`rows` given then only).
      const looked = child === step.table
      const tuning = keyTuning(relation, child, parent, childSchema, schemas.get(parent), looked ? rows : undefined)
      const unindexed = locale.designReading.unindexed(child, relation.columns.join(', '), parent)
      hints.push(...tuning.filter((h) => looked || h !== unindexed))
    } else {
      // The rows looked up are those of the table joined; in a RIGHT JOIN, those of the tables before it.
      const looked = (r: Ref) => (step.kind === 'right' ? r.table !== step.table : r.table === step.table)
      const sides = step.on.flatMap((p) => [p.a, p.b].filter(looked))
      for (const table of unique(sides.map((r) => r.table))) {
        const cols = unique(sides.filter((r) => r.table === table).map((r) => r.column))
        const schema = schemas.get(table)
        if (schema && !indexed(schema, cols)) hints.push(t.joinUnindexed(table, cols.join(', ')))
      }
    }
    if (running) notes.push(t.runningRows(roughly(running.n), running.atMost))
    if (step.kind === 'left') nullable.add(step.table)
    if (step.kind === 'right') for (const x of before) nullable.add(x)
    hinted.push(...hints)
    scenes.push({
      title: t.joinTitle(step.kind, step.table),
      text: t.join[step.kind](comment(step.table), on),
      frame: [...before, step.table],
      overlay: overlay({
        tables: [...before.map((x) => [x, 'index'] as const), [step.table, 'focus']],
        relations: [
          ...relations.slice(0, i).flatMap((r) => (r ? [[r, 'index'] as const] : [])),
          ...(relation ? [[relation, 'focus'] as const] : []),
        ],
        flow: relation ? [[relation, 'forward']] : [],
        columns: step.on.flatMap((p) => [
          [p.a.table, [p.a.column]],
          [p.b.table, [p.b.column]],
        ]),
      }),
      pulse: [step.table],
      notes,
      hints,
    })
  })

  const whereAt = scenes.length
  if (where.length > 0) {
    const involved = unique(where.flat().map((c) => c.table))
    const text = where.map((g) => g.map(conditionWords).join(t.and)).join(t.or)
    const notes: string[] = []
    // With one group, every condition must hold: a value asked of a table an outer join may leave NULL drops the
    // rows where it is NULL (every operator but IS NULL is false on NULL).
    if (where.length === 1)
      for (const table of unique(
        (where[0] ?? []).filter((c) => nullable.has(c.table) && c.op !== 'is_null').map((c) => c.table)
      ))
        notes.push(t.leftToInner(table))
    const hints = unique(
      where.flat().flatMap((c) => {
        const schema = schemas.get(c.table)
        return schema && !indexed(schema, [c.column]) ? [t.whereUnindexed(dotted(c))] : []
      })
    )
    hinted.push(...hints)
    scenes.push({
      title: t.whereTitle,
      text: t.where(text),
      frame: involved,
      overlay: overlay({
        tables: involved.map((x) => [x, 'focus'] as const),
        columns: where.flat().map((c) => [c.table, [c.column]] as const),
      }),
      pulse: [],
      notes,
      hints,
    })
  }

  const shown = columns.filter((c) => c.show !== false)
  const involved = unique(shown.map((c) => c.table))
  const selectAt = scenes.length
  scenes.push({
    title: t.selectTitle,
    text:
      shown.length === 0
        ? t.selectAll
        : t.select(t.list(shown.map((c) => (c.alias ? t.alias(dotted(c), c.alias) : dotted(c))))),
    frame: shown.length === 0 ? tables : involved,
    overlay:
      shown.length === 0
        ? overlay({ tables: tables.map((x) => [x, 'focus'] as const) })
        : overlay({
            tables: involved.map((x) => [x, 'focus'] as const),
            columns: shown.map((c) => [c.table, [c.column]] as const),
          }),
    pulse: [],
  })

  const sorted = columns.filter((c) => c.sort !== null && c.sort !== undefined)
  if (sorted.length > 0) {
    const involved = unique(sorted.map((c) => c.table))
    const hints: string[] = []
    // One table, sorted by its own columns: an index that starts with them gives the rows already in order.
    const schema = schemas.get(first)
    if (
      tables.length === 1 &&
      schema &&
      !indexed(
        schema,
        sorted.map((c) => c.column)
      )
    )
      hints.push(t.orderUnindexed(first, sorted.map((c) => c.column).join(', ')))
    hinted.push(...hints)
    scenes.push({
      title: t.orderTitle,
      text: t.order(t.list(sorted.map((c) => (c.sort === 'desc' ? t.desc(dotted(c)) : t.asc(dotted(c)))))),
      frame: involved,
      overlay: overlay({
        tables: involved.map((x) => [x, 'focus'] as const),
        columns: sorted.map((c) => [c.table, [c.column]] as const),
      }),
      pulse: [],
      hints,
    })
  }

  scenes.push({
    title: t.endTitle,
    text: t.end(first, joins.length, where.length > 0, sorted.length > 0, shown.length),
    frame: [],
    overlay: whole(false),
    pulse: [],
    notes: [
      ...unique(said),
      ...(running && joins.length > 0 ? [t.runningRows(roughly(running.n), running.atMost)] : []),
    ],
    hints: unique(hinted),
  })
  // Its chapters: the tables and how they join, the conditions, and what comes out (the summary with it).
  openChapter(scenes, 0, t.chapters.tables)
  if (where.length > 0) openChapter(scenes, whereAt, t.chapters.where)
  openChapter(scenes, selectAt, t.chapters.output)
  return { diagram, scenes }
}

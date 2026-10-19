import type { ForeignKeyDef, TableSchema } from '@tsmyadmin/shared'
import { locale } from '@/config/locale-screens.ts'
import { indexed } from './key-index.ts'
import { typeKind } from './type-mismatches.ts'

const t = () => locale.designReading

/** What deleting the row referred to does to the rows that refer to it, as its key says. */
export type Lifecycle = 'cascade' | 'setNull' | 'setDefault' | 'restrict'

/**
 * What a foreign key says about the design, read from the definitions alone: how many rows can refer to one
 * (`oneToOne` when its columns are the referring table's primary key or a unique key of its own), whether a row must
 * refer (`required`: every column of the key is NOT NULL), and what deleting the row referred to does. What the
 * definitions at hand do not say is left undefined, and nothing is said of it.
 */
export interface KeyIntent {
  oneToOne: boolean | undefined
  required: boolean | undefined
  lifecycle: Lifecycle
}

export function lifecycleOf(onDelete: string | null): Lifecycle {
  switch ((onDelete ?? '').toUpperCase().replace(/\s+/g, ' ').trim()) {
    case 'CASCADE':
      return 'cascade'
    case 'SET NULL':
      return 'setNull'
    case 'SET DEFAULT':
      return 'setDefault'
    default:
      // RESTRICT, NO ACTION, and a key that names none (NO ACTION is what the servers do then).
      return 'restrict'
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length > 0 && a.length === b.length && a.every((c) => b.includes(c))

/** The intent of `key`, a key of the table `child` (whose definition, when it was read, tells the rest). */
export function keyIntent(
  key: Pick<ForeignKeyDef, 'columns' | 'onDelete'>,
  child?: Pick<TableSchema, 'columns' | 'primaryKey' | 'indexes'>
): KeyIntent {
  const lifecycle = lifecycleOf(key.onDelete)
  if (!child) return { oneToOne: undefined, required: undefined, lifecycle }
  const oneToOne =
    sameSet(key.columns, child.primaryKey) ||
    child.indexes.some((i) => i.unique && i.predicate === null && sameSet(key.columns, i.columns))
  const columns = key.columns.map((c) => child.columns.find((x) => x.name === c))
  const required = columns.every((c) => c !== undefined) ? columns.every((c) => c?.nullable === false) : undefined
  return { oneToOne, required, lifecycle }
}

/** The intent of a key in words: how many, whether it must, and what a delete does. `child` refers to `parent`. */
export function keyReading(child: string, parent: string, intent: KeyIntent): string[] {
  const w = t()
  return [
    intent.oneToOne === undefined ? '' : intent.oneToOne ? w.oneToOne(child, parent) : w.oneToMany(child, parent),
    intent.required === undefined ? '' : intent.required ? w.required(child, parent) : w.optional(child, parent),
    w.lifecycle[intent.lifecycle](child, parent),
  ].filter(Boolean)
}

/**
 * The keys met, sorted by what a delete does along them: the parts that go with their parent, the records kept safe
 * (their parent cannot go while they point at it), and the records of their own. One line for each kind there is.
 */
export function designSummary(keys: readonly { child: string; parent: string; intent: KeyIntent }[]): string[] {
  const w = t()
  const of = (kinds: readonly Lifecycle[]) => [
    ...new Set(keys.filter((k) => kinds.includes(k.intent.lifecycle)).map((k) => w.pair(k.child, k.parent))),
  ]
  const parts = of(['cascade'])
  const guarded = of(['restrict'])
  const loose = of(['setNull', 'setDefault'])
  return [
    parts.length > 0 ? w.parts(parts) : '',
    guarded.length > 0 ? w.guarded(guarded) : '',
    loose.length > 0 ? w.loose(loose) : '',
  ].filter(Boolean)
}

/** Names of columns that keep when a row was made and changed, that mark it deleted, and that hold where it stands. */
const HISTORY = /^(created|updated|modified|inserted)(_?(at|on|date|time|timestamp))?$/i
const SOFT_DELETE = /^(deleted|archived|discarded)(_?(at|on))?$|^is_?(deleted|archived)$/i
const STATE = /^(status|state)$|_(status|state)$/i

/**
 * What a table's own definition says of its design, beyond its keys: it keeps when its rows were made and changed,
 * it marks rows deleted rather than deleting them, a column holds the stage a row is at, and columns that no two rows
 * share name a row from outside (an e-mail, a code). Read from column names and unique keys, so each is "looks like".
 */
export function tableReading(schema: Pick<TableSchema, 'columns' | 'indexes' | 'foreignKeys'>): string[] {
  const w = t()
  const names = schema.columns.map((c) => c.name)
  const history = names.filter((n) => HISTORY.test(n))
  const softDelete = names.find((n) => SOFT_DELETE.test(n))
  const state = names.find((n) => STATE.test(n))
  const keyed = new Set(schema.foreignKeys.flatMap((k) => k.columns))
  const natural = schema.indexes
    .filter((i) => i.unique && !i.primary && i.predicate === null && !i.columns.every((c) => keyed.has(c)))
    .map((i) => i.columns.join(', '))
  return [
    history.length > 0 ? w.history(history.join(', ')) : '',
    softDelete ? w.softDelete(softDelete) : '',
    state ? w.state(state) : '',
    natural.length > 0 ? w.naturalKey(natural) : '',
  ].filter(Boolean)
}

/** A comment as it is said beside a name: its first line, cut short. */
const COMMENT_CHARS = 30
export function shortComment(comment: string | null | undefined): string | undefined {
  const first = comment?.split(/\r?\n/)[0]?.trim()
  if (!first) return undefined
  return first.length > COMMENT_CHARS ? `${first.slice(0, COMMENT_CHARS - 1)}…` : first
}

/** A table's name with what its comment says it is (`users（会員）`), for the words a tour says. */
export const named = (table: string, comment: string | null | undefined) => {
  const said = shortComment(comment)
  return said ? t().named(table, said) : table
}

/** What the comments of a key's columns say, a line each: the people who made it wrote what the value means. */
export function columnComments(
  table: string,
  columns: readonly string[],
  schema?: Pick<TableSchema, 'columns'>
): string[] {
  return columns.flatMap((c) => {
    const said = shortComment(schema?.columns.find((x) => x.name === c)?.comment)
    return said ? [t().columnComment(table, c, said)] : []
  })
}

/** Indexes past this many: each write updates every one. */
const MANY_INDEXES = 8

/**
 * Where a foreign key may cost time, read from definitions: no index starts with its columns (a join from the
 * referred table, and every delete or key change there, read the whole referring table), or a column of it is of
 * another kind than the one it refers to (converted on each join, so an index may not be used).
 */
export function keyTuning(
  key: Pick<ForeignKeyDef, 'columns' | 'refColumns'>,
  child: string,
  parent: string,
  childSchema?: Pick<TableSchema, 'columns' | 'primaryKey' | 'indexes'>,
  parentSchema?: Pick<TableSchema, 'columns'>
): string[] {
  const w = t()
  const hints: string[] = []
  if (childSchema && !indexed(childSchema, key.columns)) hints.push(w.unindexed(child, key.columns.join(', '), parent))
  if (childSchema && parentSchema) {
    key.columns.forEach((c, i) => {
      const mine = childSchema.columns.find((x) => x.name === c)
      const theirs = parentSchema.columns.find((x) => x.name === key.refColumns[i])
      if (mine && theirs && typeKind(mine.dataType) !== typeKind(theirs.dataType))
        hints.push(w.typeMismatch(`${child}.${c}`, mine.dataType, `${parent}.${theirs.name}`, theirs.dataType))
    })
  }
  return hints
}

/**
 * Where a table may cost time, read from its definition: no primary key (a row cannot be found by itself), an index
 * that another starts with (the shorter one only adds to each write), and many indexes (each write updates them all).
 */
export function tableTuning(name: string, schema: Pick<TableSchema, 'primaryKey' | 'indexes' | 'kind'>): string[] {
  const w = t()
  if (schema.kind !== 'table') return []
  const plain = schema.indexes.filter((i) => i.predicate === null && !i.unique && !i.primary)
  const covered = plain.filter((a) =>
    schema.indexes.some(
      (b) =>
        b !== a &&
        b.predicate === null &&
        (b.type ?? '') === (a.type ?? '') &&
        b.columns.length > a.columns.length &&
        a.columns.every((c, k) => b.columns[k] === c)
    )
  )
  return [
    schema.primaryKey.length === 0 ? w.noPrimaryKey(name) : '',
    ...covered.map((a) => {
      const by = schema.indexes.find(
        (b) => b !== a && b.columns.length > a.columns.length && a.columns.every((c, k) => b.columns[k] === c)
      )
      return w.redundantIndex(a.name, a.columns.join(', '), by?.name ?? '')
    }),
    schema.indexes.length > MANY_INDEXES ? w.manyIndexes(name, schema.indexes.length) : '',
  ].filter(Boolean)
}

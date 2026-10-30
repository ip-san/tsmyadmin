import type { RelationDef } from '@tsmyadmin/shared'
import { openChapter, overlay, said, type TourScene, unique, whole } from '@/components/schema-diagram/tour.ts'
import { locale } from '@/config/locale-screens.ts'
import { designSummary, keyIntent } from '@/lib/design-reading.ts'
import { perRowReading, type RowEstimates, rowsReading } from '@/lib/row-estimates.ts'
import { TABLE_ROLES } from '@/lib/table-role.ts'
import type { DatabaseMap } from './database-map.ts'
import type { JoinHop } from './join-path.ts'

const t = locale.mapTour
const w = locale.designReading

/** Hubs given a scene of their own: past three, the rest are named on the map. */
const HUBS_TOLD = 3

/** The tables with the most rows told, and the sentences a scene says from the rows: past three, too many to hear. */
const ROWS_TOLD = 3

/**
 * The tour of a database's map, scene by scene: the whole of it, each role's tables with the keys that make them so
 * (the lines flowing from the table that refers to the one referred to), the tables most referred to, the way
 * between two tables when they were chosen (`path`), the tables with the most rows, what to look at, and the whole
 * again. Built from the map and the keys drawn, with the catalog's estimated rows where there are any (`rows`): no
 * rows are read or counted.
 */
export function tourScenes(input: {
  name: string
  map: DatabaseMap
  relations: readonly RelationDef[]
  path?: { from: string; to: string; hops: readonly JoinHop[] } | undefined
  /** The tables' estimated rows (`rowEstimates`), where the list of tables could be read. */
  rows?: RowEstimates | undefined
}): TourScene[] {
  const { name, map, relations, path, rows } = input
  // What a delete does along the keys, sorted (from the keys alone: whether a row must refer is the tables' to say).
  const summary = (keys: readonly RelationDef[]) =>
    designSummary(keys.map((r) => ({ child: r.table, parent: r.refTable, intent: keyIntent(r) })))
  const notes = (keys: readonly RelationDef[], more: readonly string[] = []) => {
    const said = [...summary(keys), ...more]
    return said.length > 0 ? { notes: said } : {}
  }
  const scenes: TourScene[] = [
    {
      title: name,
      text: t.overview(map.tables, relations.length),
      frame: [],
      overlay: whole(true),
      pulse: [],
      chapter: t.chapters.roles,
    },
  ]
  // Keys to another table: one to itself is the tree's, said there.
  const touching = (tables: readonly string[]) =>
    relations.filter((r) => tables.includes(r.table) || tables.includes(r.refTable))
  for (const role of TABLE_ROLES) {
    const tables = map.roles[role]
    if (tables.length === 0) continue
    const keys = touching(tables)
    scenes.push({
      title: t.roleTitle(t.roles[role], tables.length),
      text: `${t.roleText[role]}${locale.tour.stop}${said(tables)}`,
      frame: unique([...tables, ...keys.flatMap((r) => [r.table, r.refTable])]),
      overlay: overlay({
        tables: tables.map((x) => [x, 'focus']),
        relations: keys.map((r) => [r, 'focus']),
        flow: keys.map((r) => [r, 'forward']),
      }),
      pulse: tables,
    })
  }
  const hubs = scenes.length
  for (const hub of map.hubs.slice(0, HUBS_TOLD)) {
    const keys = relations.filter((r) => r.refTable === hub.table && r.table !== hub.table)
    const from = unique(keys.map((r) => r.table))
    scenes.push({
      title: t.hubTitle(hub.table, hub.referredBy),
      text: t.hubText(hub.table, said(from)),
      frame: [hub.table, ...from],
      overlay: overlay({
        tables: [[hub.table, 'focus', t.referredBy(hub.referredBy)], ...from.map((x) => [x, 'index'] as const)],
        relations: keys.map((r) => [r, 'focus']),
        flow: keys.map((r) => [r, 'forward']),
        columns: keys.flatMap((r) => [
          [r.table, r.columns],
          [r.refTable, r.refColumns],
        ]),
      }),
      pulse: [hub.table],
      // After what the design says, how many rows it has and how many of each table refer to one of them.
      ...notes(keys, [
        ...rowsReading(rows, hub.table),
        ...keys.flatMap((r) => perRowReading(rows, r.table, r.refTable)).slice(0, ROWS_TOLD),
      ]),
    })
  }
  // Each part opens a chapter of its own; the summary closes the last.
  openChapter(scenes, hubs, t.chapters.hubs)
  if (path && path.hops.length > 0) {
    const walk = scenes.length
    scenes.push(...pathScenes(path, rows))
    openChapter(scenes, walk, t.chapters.path)
  }
  // The size of things before what to look at: a full read costs what the table holds.
  const large = largestScene(map, relations, rows)
  if (large) {
    scenes.push(large)
    openChapter(scenes, scenes.length - 1, t.chapters.largest)
  }
  const checks = scenes.length
  scenes.push(...checkScenes(map, relations, rows))
  openChapter(scenes, checks, t.chapters.checks)
  scenes.push({
    title: t.endTitle,
    text: t.end(
      TABLE_ROLES.filter((r) => map.roles[r].length > 0).map((r) => t.roleCount(t.roleShort[r], map.roles[r].length))
    ),
    frame: [],
    overlay: whole(false),
    pulse: [],
    ...notes(relations),
  })
  return scenes
}

/**
 * The way between two tables, one scene a step: what was walked stays lit, the step taken flows (in the direction
 * walked, which is against the key when it is the other table that refers), and the columns joined are marked.
 */
function pathScenes(
  path: { from: string; to: string; hops: readonly JoinHop[] },
  rows: RowEstimates | undefined
): TourScene[] {
  const tables = [path.from, ...path.hops.map((h) => h.to)]
  const title = t.pathTitle(path.from, path.to)
  return path.hops.map((hop, i) => {
    const walked = path.hops.slice(0, i + 1)
    const seen = tables.slice(0, i + 2)
    const keys = walked.flatMap((h) => h.keys)
    return {
      title,
      text: `${t.pathStep(i + 1, path.hops.length)}${hop.keys
        .map(({ relation: r }) => t.pathKey(r.table, r.columns.join(', '), r.refTable, r.refColumns.join(', ')))
        .join(locale.tour.and)}`,
      frame: seen,
      overlay: overlay({
        tables: seen.map((x) => [x, x === path.from || x === path.to ? 'focus' : 'index']),
        relations: keys.map(({ relation }) => [relation, 'focus']),
        flow: hop.keys.map(({ relation, forward }) => [relation, forward ? 'forward' : 'back']),
        columns: keys.flatMap(({ relation: r }) => [
          [r.table, r.columns],
          [r.refTable, r.refColumns],
        ]),
      }),
      pulse: [hop.to],
      // How the rows multiply, or thin out, at the step: of the table that refers, per row of the one referred to.
      ...lists(hop.keys.flatMap(({ relation: r }) => perRowReading(rows, r.table, r.refTable)).slice(0, ROWS_TOLD)),
    }
  })
}

/** The tables that have rows to say, the most first (by name where they have as many). */
function bySize(rows: RowEstimates | undefined, tables: Iterable<string>): { table: string; n: number }[] {
  return [...tables]
    .flatMap((table) => {
      const v = rows?.get(table)
      return v === undefined ? [] : [{ table, n: typeof v === 'number' ? v : v.counted }]
    })
    .sort((a, b) => b.n - a.n || a.table.localeCompare(b.table))
}

const lists = (notes: readonly string[], hints: readonly string[] = []) => ({
  ...(notes.length > 0 ? { notes } : {}),
  ...(hints.length > 0 ? { hints } : {}),
})

/**
 * The tables with the most rows by the estimates, the most first, each marked with its rows; and what costs more on
 * them for their size: a key of theirs no index starts with, no primary key. Nothing where no table has an estimate.
 */
function largestScene(
  map: DatabaseMap,
  relations: readonly RelationDef[],
  rows: RowEstimates | undefined
): TourScene | undefined {
  const largest = bySize(rows, rows?.keys() ?? []).slice(0, ROWS_TOLD)
  if (largest.length === 0) return undefined
  const tables = largest.map((x) => x.table)
  const drawn = (table: string, key: string) => relations.some((r) => r.table === table && r.name === key)
  const hints = [
    ...map.unindexedKeys
      .filter((k) => tables.includes(k.table) && drawn(k.table, k.key))
      .map((k) => w.unindexed(k.table, k.columns.join(', '), k.refTable)),
    ...map.noPrimaryKey.filter((x) => tables.includes(x)).map((x) => w.noPrimaryKey(x)),
  ]
  return {
    title: t.largestTitle(largest.length),
    text: `${t.largestText}${locale.tour.stop}${said(tables)}`,
    frame: tables,
    overlay: overlay({ tables: largest.map((x) => [x.table, 'focus', t.rowsBadge(x.n)]) }),
    pulse: tables,
    ...lists(
      tables.flatMap((x) => rowsReading(rows, x)),
      hints.slice(0, ROWS_TOLD)
    ),
  }
}

/** What to look at, a scene each that has something: tables with no primary key, keys with no index, keys of another type. */
function checkScenes(map: DatabaseMap, relations: readonly RelationDef[], rows: RowEstimates | undefined): TourScene[] {
  const scenes: TourScene[] = []
  const byKey = (table: string, key: string) => relations.find((r) => r.table === table && r.name === key)
  if (map.noPrimaryKey.length > 0) {
    scenes.push({
      title: t.noPrimaryKeyTitle(map.noPrimaryKey.length),
      text: `${t.noPrimaryKeyText}${locale.tour.stop}${said(map.noPrimaryKey)}`,
      frame: map.noPrimaryKey,
      overlay: overlay({ tables: map.noPrimaryKey.map((x) => [x, 'blocked', t.noPrimaryKeyBadge]) }),
      pulse: map.noPrimaryKey,
    })
  }
  const unindexed = map.unindexedKeys.flatMap((k) => byKey(k.table, k.key) ?? [])
  if (unindexed.length > 0) {
    // The rows each read in full holds, the most first.
    const read = bySize(rows, unique(unindexed.map((r) => r.table))).slice(0, ROWS_TOLD)
    scenes.push({
      title: t.unindexedTitle(map.unindexedKeys.length),
      text: `${t.unindexedText}${locale.tour.stop}${said(unique(map.unindexedKeys.map((k) => `${k.table}（${k.columns.join(', ')}）`)))}`,
      frame: unique(unindexed.flatMap((r) => [r.table, r.refTable])),
      overlay: overlay({
        tables: unique(unindexed.map((r) => r.table)).map((x) => [x, 'scan']),
        relations: unindexed.map((r) => [r, 'scan']),
        columns: unindexed.map((r) => [r.table, r.columns]),
      }),
      pulse: unique(unindexed.map((r) => r.table)),
      ...lists(read.flatMap(({ table }) => rowsReading(rows, table))),
    })
  }
  const mistyped = unique(map.keyTypes.map((k) => JSON.stringify([k.table, k.key]))).flatMap((id) => {
    const [table, key] = JSON.parse(id) as [string, string]
    return byKey(table, key) ?? []
  })
  if (mistyped.length > 0) {
    scenes.push({
      title: t.keyTypesTitle(map.keyTypes.length),
      text: `${t.keyTypesText}${locale.tour.stop}${said(map.keyTypes.map((k) => `${k.table}.${k.column} → ${k.refTable}.${k.refColumn}`))}`,
      frame: unique(mistyped.flatMap((r) => [r.table, r.refTable])),
      overlay: overlay({
        tables: unique(mistyped.flatMap((r) => [r.table, r.refTable])).map((x) => [x, 'nullify']),
        relations: mistyped.map((r) => [r, 'nullify']),
        columns: map.keyTypes.flatMap((k) => [
          [k.table, [k.column]],
          [k.refTable, [k.refColumn]],
        ]),
      }),
      pulse: unique(mistyped.map((r) => r.table)),
    })
  }
  return scenes
}

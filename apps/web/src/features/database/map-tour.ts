import type { RelationDef } from '@tsmyadmin/shared'
import { overlay, said, type TourScene, unique, whole } from '@/components/schema-diagram/tour.ts'
import { locale } from '@/config/locale-screens.ts'
import { designSummary, keyIntent } from '@/lib/design-reading.ts'
import { TABLE_ROLES } from '@/lib/table-role.ts'
import type { DatabaseMap } from './database-map.ts'
import type { JoinHop } from './join-path.ts'

const t = locale.mapTour

/** Hubs given a scene of their own: past three, the rest are named on the map. */
const HUBS_TOLD = 3

/**
 * The tour of a database's map, scene by scene: the whole of it, each role's tables with the keys that make them so
 * (the lines flowing from the table that refers to the one referred to), the tables most referred to, the way
 * between two tables when they were chosen (`path`), what to look at, and the whole again. Built from the map and
 * the keys drawn; no rows are read.
 */
export function tourScenes(input: {
  name: string
  map: DatabaseMap
  relations: readonly RelationDef[]
  path?: { from: string; to: string; hops: readonly JoinHop[] } | undefined
}): TourScene[] {
  const { name, map, relations, path } = input
  // What a delete does along the keys, sorted (from the keys alone: whether a row must refer is the tables' to say).
  const summary = (keys: readonly RelationDef[]) =>
    designSummary(keys.map((r) => ({ child: r.table, parent: r.refTable, intent: keyIntent(r) })))
  const notes = (keys: readonly RelationDef[]) => {
    const said = summary(keys)
    return said.length > 0 ? { notes: said } : {}
  }
  const scenes: TourScene[] = [
    { title: name, text: t.overview(map.tables, relations.length), frame: [], overlay: whole(true), pulse: [] },
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
      ...notes(keys),
    })
  }
  if (path && path.hops.length > 0) scenes.push(...pathScenes(path))
  scenes.push(...checkScenes(map, relations))
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
function pathScenes(path: { from: string; to: string; hops: readonly JoinHop[] }): TourScene[] {
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
    }
  })
}

/** What to look at, a scene each that has something: tables with no primary key, keys with no index, keys of another type. */
function checkScenes(map: DatabaseMap, relations: readonly RelationDef[]): TourScene[] {
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

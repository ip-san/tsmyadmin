import type { RelationDef, TableSchema } from '@tsmyadmin/shared'
import { neighbourhood } from '@/components/schema-diagram/neighbourhood.ts'
import { overlay, said, type TourScene, unique, whole } from '@/components/schema-diagram/tour.ts'
import { locale } from '@/config/locale-screens.ts'
import {
  columnComments,
  designSummary,
  keyIntent,
  keyReading,
  keyTuning,
  tableReading,
  tableTuning,
} from '@/lib/design-reading.ts'
import type { RoleGuess } from '@/lib/table-role.ts'

const t = locale.tableTour

/** Lines of a scene's reading of the design: past them, a scene says too much to be read aloud. */
const NOTES_SHOWN = 6

/** How far out the tour looks: the tables a key away, and those a key further. */
export const TOUR_HOPS = 2

const keySentence = (r: RelationDef) => t.key(r.table, r.columns.join(', '), r.refTable, r.refColumns.join(', '))

/**
 * One table told as a presentation, scene by scene: what it is (its role, guessed from its keys, and its comment),
 * its primary key, the tables it refers to and those that refer to it (the keys flowing from the table that refers
 * to the one referred to, the columns joined marked), a key to itself, the tables a key further, and the whole of
 * its neighbourhood again. `relations` are the keys drawn (`drawnRelations`); no rows are read.
 */
export function tableTourScenes(input: {
  schema: Pick<TableSchema, 'name' | 'kind' | 'comment' | 'columns' | 'primaryKey' | 'indexes' | 'foreignKeys'>
  guess: RoleGuess
  relations: readonly RelationDef[]
  /** The tables drawn: every table of the namespace with a key, and this one. */
  tables: readonly string[]
}): TourScene[] {
  const { schema, guess, relations, tables } = input
  const name = schema.name
  const near = neighbourhood(tables, relations, name, 1)
  const reach = neighbourhood(tables, relations, name, TOUR_HOPS)
  const out = relations.filter((r) => r.table === name && r.refTable !== name)
  const into = relations.filter((r) => r.refTable === name && r.table !== name)
  const self = relations.filter((r) => r.table === name && r.refTable === name)
  const farther = [...reach].filter((x) => !near.has(x))
  // Why it is so: what each key says (its own keys from this table's definition; another table's, what a delete does).
  const intentOf = (r: RelationDef) => keyIntent(r, r.table === name ? schema : undefined)
  // The comments of this table's own key columns say what the values mean; its own keys can be checked for an index.
  const reading = (keys: readonly RelationDef[]) =>
    keys
      .flatMap((r) => [
        ...(r.table === name ? columnComments(name, r.columns, schema) : []),
        ...keyReading(r.table, r.refTable, intentOf(r)),
      ])
      .slice(0, NOTES_SHOWN)
  const tuning = (keys: readonly RelationDef[]) =>
    keys.flatMap((r) => (r.table === name ? keyTuning(r, name, r.refTable, schema) : [])).slice(0, NOTES_SHOWN)
  const lists = (notes: readonly string[], hints: readonly string[]) => ({
    ...(notes.length > 0 ? { notes } : {}),
    ...(hints.length > 0 ? { hints } : {}),
  })

  const scenes: TourScene[] = [
    {
      title: name,
      text: [t.roles[guess.role], t.columns(schema.columns.length), schema.comment ?? '']
        .filter(Boolean)
        .join(locale.tour.stop),
      frame: [name],
      overlay: { ...overlay({ tables: [[name, 'focus']] }), enter: true },
      pulse: [name],
      ...lists(tableReading(schema), tableTuning(name, schema)),
    },
    schema.primaryKey.length > 0
      ? {
          title: t.primaryKeyTitle,
          text: t.primaryKey(schema.primaryKey.join(', ')),
          frame: [name],
          overlay: overlay({ tables: [[name, 'focus']], columns: [[name, schema.primaryKey]] }),
          pulse: [],
        }
      : {
          title: t.primaryKeyTitle,
          text: t.noPrimaryKey,
          frame: [name],
          overlay: overlay({ tables: [[name, 'blocked', t.noPrimaryKeyBadge]] }),
          pulse: [name],
        },
  ]
  if (out.length > 0) {
    const to = unique(out.map((r) => r.refTable))
    scenes.push({
      title: t.refersTitle(to.length),
      text: `${t.refersText}${locale.tour.stop}${out.map(keySentence).join(locale.tour.and)}`,
      frame: [name, ...to],
      overlay: overlay({
        tables: [[name, 'focus'], ...to.map((x) => [x, 'index'] as const)],
        relations: out.map((r) => [r, 'focus']),
        flow: out.map((r) => [r, 'forward']),
        columns: out.flatMap((r) => [
          [r.table, r.columns],
          [r.refTable, r.refColumns],
        ]),
      }),
      pulse: to,
      ...lists(reading(out), tuning(out)),
    })
  }
  if (into.length > 0) {
    const from = unique(into.map((r) => r.table))
    scenes.push({
      title: t.referredTitle(from.length),
      text: `${t.referredText}${locale.tour.stop}${into.map(keySentence).join(locale.tour.and)}`,
      frame: [name, ...from],
      overlay: overlay({
        tables: [[name, 'focus'], ...from.map((x) => [x, 'index'] as const)],
        relations: into.map((r) => [r, 'focus']),
        flow: into.map((r) => [r, 'forward']),
        columns: into.flatMap((r) => [
          [r.table, r.columns],
          [r.refTable, r.refColumns],
        ]),
      }),
      pulse: from,
      ...lists(reading(into), []),
    })
  }
  if (self.length > 0) {
    scenes.push({
      title: t.selfTitle,
      text: `${t.selfText}${locale.tour.stop}${self.map(keySentence).join(locale.tour.and)}`,
      frame: [name],
      overlay: overlay({
        tables: [[name, 'focus']],
        relations: self.map((r) => [r, 'focus']),
        flow: self.map((r) => [r, 'forward']),
        columns: self.flatMap((r) => [[name, [...r.columns, ...r.refColumns]]]),
      }),
      pulse: [],
      ...lists(reading(self), tuning(self)),
    })
  }
  if (farther.length > 0) {
    // The keys that reach them (from a table a key away to one a key further), and the way to the tables between.
    const bridge = relations.filter(
      (r) => (near.has(r.table) && farther.includes(r.refTable)) || (near.has(r.refTable) && farther.includes(r.table))
    )
    const via = unique(bridge.flatMap((r) => [r.table, r.refTable]).filter((x) => near.has(x) && x !== name))
    const toVia = [...out, ...into].filter((r) => via.includes(r.table) || via.includes(r.refTable))
    scenes.push({
      title: t.fartherTitle(farther.length),
      text: `${t.fartherText}${locale.tour.stop}${said(farther)}`,
      frame: [...reach],
      overlay: overlay({
        tables: [[name, 'focus'], ...[...via, ...farther].map((x) => [x, 'index'] as const)],
        relations: [...toVia, ...bridge].map((r) => [r, 'focus']),
        flow: bridge.map((r) => [r, 'forward']),
      }),
      pulse: farther,
    })
  }
  scenes.push({
    title: t.endTitle,
    text: t.end(unique(out.map((r) => r.refTable)).length, unique(into.map((r) => r.table)).length, farther.length),
    frame: [...reach],
    overlay: whole(false),
    pulse: [],
    notes: designSummary(
      [...out, ...into, ...self].map((r) => ({ child: r.table, parent: r.refTable, intent: intentOf(r) }))
    ),
  })
  return scenes
}

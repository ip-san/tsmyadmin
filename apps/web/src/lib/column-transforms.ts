import { useRouteContext } from '@tanstack/react-router'
import type { ColumnTransform, ColumnTransformBody } from '@tsmyadmin/shared'
import { ColumnTransformSchema } from '@tsmyadmin/shared'
import { z } from 'zod'
import { loadNamed, removeNamed, saveNamed } from '@/lib/named-storage.ts'
import { listColumnTransforms, mutations, type TableRef } from '@/lib/queries.ts'
import { type NamedList, useNamedList } from '@/lib/use-named-list.ts'

/** A transformation named by its column, which is what the lists key on (one per column). */
type NamedTransform = ColumnTransform & { name: string }
const NamedTransformSchema = z.intersection(ColumnTransformSchema, z.object({ name: z.string() }))
const named = (t: ColumnTransform): NamedTransform => ({ ...t, name: t.column })

/** Per server and table in this browser. */
// JSON rather than dots: a name may itself contain a dot, and `a.b` + `c` must not be `a` + `b.c`.
const key = (scope: string, ref: TableRef) =>
  `transform.${JSON.stringify([scope, ref.db, ref.schema ?? '', ref.table])}`

export type ColumnTransforms = NamedList<NamedTransform, ColumnTransformBody> & {
  /** The transformation of each column that has one. */
  byColumn: ReadonlyMap<string, ColumnTransform>
}

/**
 * The display transformations of one table's columns: kept with the account where the deployment can,
 * otherwise in this browser. One per column; setting another replaces it.
 */
export function useColumnTransforms(ref: TableRef): ColumnTransforms {
  const { session } = useRouteContext({ from: '/_app' })
  const scope = `${session.dialect}.${session.host}.${session.port}`
  const list = useNamedList<NamedTransform, ColumnTransformBody>({
    onServer: session.savedQueries === 'server',
    query: {
      queryKey: ['column-transforms'],
      queryFn: async () => (await listColumnTransforms()).map(named),
    },
    saveOnServer: async (_name, body) => (await mutations.saveColumnTransform(body)).map(named),
    removeOnServer: async (id) => (await mutations.deleteColumnTransform(id)).map(named),
    local: {
      load: () => loadNamed(key(scope, ref), NamedTransformSchema),
      save: (_name, body) =>
        saveNamed(key(scope, ref), NamedTransformSchema, named({ ...body, id: '', at: Date.now() })),
      remove: (name) => removeNamed(key(scope, ref), NamedTransformSchema, name),
    },
  })
  const entries = list.entries.filter(
    (t) => t.database === ref.db && (t.schema ?? '') === (ref.schema ?? '') && t.table === ref.table
  )
  return { ...list, entries, byColumn: new Map(entries.map((t) => [t.column, t])) }
}

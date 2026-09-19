import { useRouteContext } from '@tanstack/react-router'
import type { CentralColumn, CentralColumnBody } from '@tsmyadmin/shared'
import { CentralColumnSchema } from '@tsmyadmin/shared'
import { loadNamed, removeNamed, saveNamed } from '@/lib/named-storage.ts'
import { centralColumnsQuery, listCentralColumns, mutations } from '@/lib/queries.ts'
import { type NamedList, useNamedList } from '@/lib/use-named-list.ts'

/** Per server and namespace in this browser, as export templates are. */
const key = (scope: string, database: string, schema: string | undefined) =>
  `central.${scope}.${database}.${schema ?? ''}`

/**
 * The central columns of one database (and schema): kept with the account where the deployment can, otherwise
 * in this browser. `save` takes the column name as the name; saving a name again replaces that column.
 */
export function useCentralColumns(
  database: string,
  schema: string | undefined
): NamedList<CentralColumn, CentralColumnBody> {
  const { session } = useRouteContext({ from: '/_app' })
  const scope = `${session.dialect}.${session.host}.${session.port}`
  const list = useNamedList<CentralColumn, CentralColumnBody>({
    onServer: session.savedQueries === 'server',
    query: { queryKey: centralColumnsQuery.queryKey, queryFn: listCentralColumns },
    saveOnServer: (_name, body) => mutations.saveCentralColumn(body),
    removeOnServer: (id) => mutations.deleteCentralColumn(id),
    local: {
      load: () => loadNamed(key(scope, database, schema), CentralColumnSchema),
      save: (_name, body) =>
        saveNamed(key(scope, database, schema), CentralColumnSchema, { ...body, id: '', at: Date.now() }),
      remove: (name) => removeNamed(key(scope, database, schema), CentralColumnSchema, name),
    },
  })
  // The account's list holds every database's; this one is what the page is about. Sorted by name, like a
  // column list, rather than by when each was saved.
  const entries = list.entries
    .filter((c) => c.database === database && (c.schema ?? '') === (schema ?? ''))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { ...list, entries }
}

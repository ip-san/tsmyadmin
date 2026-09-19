import { type QueryTemplate, QueryTemplateSchema } from '@tsmyadmin/shared'
import { loadNamed, removeNamed, saveNamed } from '@/lib/named-storage.ts'
import type { PreferenceStore } from '@/lib/preferences.ts'

/** Per server and namespace, like export templates: the same name in two databases is two setups. */
const key = (scope: string, database: string, schema: string | undefined) =>
  `query.templates.${scope}.${database}.${schema ?? ''}`

export const loadQueryTemplates = (
  scope: string,
  database: string,
  schema: string | undefined,
  store?: PreferenceStore
) => loadNamed(key(scope, database, schema), QueryTemplateSchema, store)

export const saveQueryTemplate = (scope: string, entry: QueryTemplate, store?: PreferenceStore) =>
  saveNamed(key(scope, entry.database, entry.schema), QueryTemplateSchema, entry, store)

export const deleteQueryTemplate = (
  scope: string,
  database: string,
  schema: string | undefined,
  name: string,
  store?: PreferenceStore
) => removeNamed(key(scope, database, schema), QueryTemplateSchema, name, store)

/** The setups of one database / schema, from a list that may hold every namespace's (the server's). */
export const queryTemplatesFor = (list: QueryTemplate[], database: string, schema: string | undefined) =>
  list.filter((t) => t.database === database && (t.schema ?? '') === (schema ?? ''))

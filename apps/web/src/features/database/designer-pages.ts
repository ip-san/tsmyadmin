import { type DesignerPage, DesignerPageSchema } from '@tsmyadmin/shared'
import { loadNamed, removeNamed, saveNamed } from '@/lib/named-storage.ts'
import type { PreferenceStore } from '@/lib/preferences.ts'

/** Per server and namespace: the same page name in two databases is two pages. */
const key = (scope: string, database: string, schema: string | undefined) =>
  `designer.pages.${scope}.${database}.${schema ?? ''}`

export const loadDesignerPages = (
  scope: string,
  database: string,
  schema: string | undefined,
  store?: PreferenceStore
) => loadNamed(key(scope, database, schema), DesignerPageSchema, store)

export const saveDesignerPage = (scope: string, entry: DesignerPage, store?: PreferenceStore) =>
  saveNamed(key(scope, entry.database, entry.schema), DesignerPageSchema, entry, store)

export const deleteDesignerPage = (
  scope: string,
  database: string,
  schema: string | undefined,
  name: string,
  store?: PreferenceStore
) => removeNamed(key(scope, database, schema), DesignerPageSchema, name, store)

/** The pages of one database / schema, from a list that may hold every namespace's (the server's). */
export const designerPagesFor = (list: DesignerPage[], database: string, schema: string | undefined) =>
  list.filter((p) => p.database === database && (p.schema ?? '') === (schema ?? ''))

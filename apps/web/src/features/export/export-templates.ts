import type { ExportTemplate, ExportTemplateBody } from '@tsmyadmin/shared'
import { ExportTemplateSchema } from '@tsmyadmin/shared'
import { loadNamed, removeNamed, saveNamed } from '@/lib/named-storage.ts'
import { type PreferenceStore, removePreference, writePreference } from '@/lib/preferences.ts'

/**
 * Per server and namespace: two servers open in one browser keep separate lists, and a name used in one database
 * does not replace a template of another (the list is per database, so the same name in two is two templates).
 */
const key = (scope: string, database: string, schema: string | undefined) =>
  `export.templates.${scope}.${database}.${schema ?? ''}`

export function loadTemplates(
  scope: string,
  database: string,
  schema: string | undefined,
  store?: PreferenceStore
): ExportTemplate[] {
  migrateFlatList(scope, store)
  return loadNamed(key(scope, database, schema), ExportTemplateSchema, store)
}

/**
 * The first version of this list kept every database's templates under one key per server, which made a name
 * used in two databases collide. Whatever is still there is moved to the per-namespace keys once, rather than
 * left as a list nothing reads.
 */
function migrateFlatList(scope: string, store?: PreferenceStore): void {
  const flat = `export.templates.${scope}`
  const old = loadNamed(flat, ExportTemplateSchema, store)
  if (old.length === 0) return
  // Grouped first, then written once per namespace: moving them one at a time would put the oldest in front,
  // and these lists are newest first.
  const groups = new Map<string, ExportTemplate[]>()
  for (const entry of old) {
    const target = key(scope, entry.database, entry.schema)
    groups.set(target, [...(groups.get(target) ?? []), entry])
  }
  for (const [target, moved] of groups) {
    const existing = loadNamed(target, ExportTemplateSchema, store)
    // A template saved here since keeps its place: the older copy of that name is the one being replaced.
    const keep = moved.filter((entry) => !existing.some((t) => t.name === entry.name))
    if (keep.length > 0) writePreference(target, [...keep, ...existing], store)
  }
  removePreference(flat, store)
}

export function saveTemplate(scope: string, entry: ExportTemplate, store?: PreferenceStore): ExportTemplate[] {
  return saveNamed(key(scope, entry.database, entry.schema), ExportTemplateSchema, entry, store)
}

export function deleteTemplate(
  scope: string,
  database: string,
  schema: string | undefined,
  name: string,
  store?: PreferenceStore
): ExportTemplate[] {
  return removeNamed(key(scope, database, schema), ExportTemplateSchema, name, store)
}

/** Templates saved for the database (and schema) being looked at; the table names belong to that namespace. */
export function templatesFor(
  templates: readonly ExportTemplate[],
  database: string,
  schema: string | undefined
): ExportTemplate[] {
  return templates.filter((t) => t.database === database && (t.schema ?? '') === (schema ?? ''))
}

/**
 * A template against the tables that exist now: tables dropped since it was saved are left out and named, so the
 * download does not simply fail on them. An empty list stays empty — it means the whole database.
 */
export function applyTemplate(
  template: ExportTemplateBody,
  existing: readonly string[]
): { tables: string[]; missing: string[] } {
  return {
    tables: template.tables.filter((t) => existing.includes(t)),
    missing: template.tables.filter((t) => !existing.includes(t)),
  }
}

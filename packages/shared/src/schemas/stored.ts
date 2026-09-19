import { z } from 'zod'
import { BROWSE_MAX_LIMIT } from './browse.ts'
import { ExportOptionsSchema } from './export.ts'
import { ImportDefaultsSchema } from './import.ts'

/**
 * Things an account keeps on the server (when the session store is persistent), besides bookmarks and export
 * templates: its preferences, its central columns and its column transformations. Each follows the account
 * between browsers; without a persistent store the browser keeps its own copy.
 */

const IDENT = z.string().min(1).max(256)

/** Preferences that follow the account. Every field is optional: an absent one means "this browser's own". */
export const PreferencesSchema = z.object({
  theme: z.enum(['light', 'dark']).optional(),
  locale: z.enum(['ja', 'en']).optional(),
  browseLimit: z.number().int().min(1).max(BROWSE_MAX_LIMIT).optional(),
  sqlSafeMode: z.boolean().optional(),
  consoleDocked: z.boolean().optional(),
  /** Statements the SQL console remembers per server. */
  sqlHistoryMax: z.number().int().min(10).max(1000).optional(),
  /** The sidebar groups tables whose names start alike up to this separator ('' is off). */
  navGroupDelimiter: z.string().max(3).optional(),
  /** Tables (or groups) the sidebar shows at once before offering the rest on demand; 0 shows everything. */
  navPageSize: z.number().int().min(0).max(1000).optional(),
  /** Names of databases the sidebar leaves out (they stay reachable from the server's database list). */
  navHidden: z.array(z.string().min(1).max(256)).max(500).optional(),
  exportDefaults: ExportOptionsSchema.optional(),
  importDefaults: ImportDefaultsSchema.optional(),
})
export type Preferences = z.infer<typeof PreferencesSchema>

/** A change to the preferences: a `null` removes that one (back to "this browser's own"). */
export const PreferencesUpdateSchema = z.object({
  theme: PreferencesSchema.shape.theme.unwrap().nullable().optional(),
  locale: PreferencesSchema.shape.locale.unwrap().nullable().optional(),
  browseLimit: PreferencesSchema.shape.browseLimit.unwrap().nullable().optional(),
  sqlSafeMode: PreferencesSchema.shape.sqlSafeMode.unwrap().nullable().optional(),
  consoleDocked: PreferencesSchema.shape.consoleDocked.unwrap().nullable().optional(),
  sqlHistoryMax: PreferencesSchema.shape.sqlHistoryMax.unwrap().nullable().optional(),
  navGroupDelimiter: PreferencesSchema.shape.navGroupDelimiter.unwrap().nullable().optional(),
  navPageSize: PreferencesSchema.shape.navPageSize.unwrap().nullable().optional(),
  navHidden: PreferencesSchema.shape.navHidden.unwrap().nullable().optional(),
  exportDefaults: PreferencesSchema.shape.exportDefaults.unwrap().nullable().optional(),
  importDefaults: PreferencesSchema.shape.importDefaults.unwrap().nullable().optional(),
})
export type PreferencesUpdate = z.infer<typeof PreferencesUpdateSchema>

/**
 * phpMyAdmin's central columns: column definitions kept per database for reuse when adding a column, so the
 * same `created_at` or `status` is declared the same way in every table.
 */
export const CentralColumnBodySchema = z.object({
  database: IDENT,
  schema: IDENT.optional(),
  name: IDENT,
  dataType: z.string().min(1).max(200),
  nullable: z.boolean(),
  default: z.string().max(1000).nullable(),
  /** Whether `default` is an expression (CURRENT_TIMESTAMP) rather than a literal value. */
  defaultIsExpression: z.boolean().default(false),
  comment: z.string().max(1000).default(''),
})
export type CentralColumnBody = z.infer<typeof CentralColumnBodySchema>

/** `id` is assigned by the server; a browser-side list leaves it empty. */
export const CentralColumnSchema = CentralColumnBodySchema.extend({ id: z.string().default(''), at: z.number() })
export type CentralColumn = z.infer<typeof CentralColumnSchema>

/** How the store addresses one: per database (and schema), by column name. */
export function centralColumnKey(c: { database: string; schema?: string | undefined; name: string }): string {
  return JSON.stringify([c.database, c.schema ?? '', c.name])
}

/**
 * phpMyAdmin's browser transformations, the ones that are safe to offer: a binary value shown as the image it
 * holds; a value shown as a link (http / https only, the value URL-encoded into an optional template); JSON
 * shown indented. Display only — what is stored and what an edit writes are unchanged.
 */
export const TransformKindSchema = z.enum(['image', 'link', 'json'])
export type TransformKind = z.infer<typeof TransformKindSchema>

/** A link template: an http(s) URL where `{value}` stands for the cell. */
const LINK_TEMPLATE = /^https?:\/\/[^\s]+$/i

export const ColumnTransformBodySchema = z
  .object({
    database: IDENT,
    schema: IDENT.optional(),
    table: IDENT,
    column: IDENT,
    kind: TransformKindSchema,
    template: z.string().max(1000).regex(LINK_TEMPLATE).optional(),
  })
  .refine((t) => t.kind === 'link' || t.template === undefined, { message: 'Only a link takes a template' })
export type ColumnTransformBody = z.infer<typeof ColumnTransformBodySchema>

export const ColumnTransformSchema = z.intersection(
  ColumnTransformBodySchema,
  z.object({ id: z.string().default(''), at: z.number() })
)
export type ColumnTransform = z.infer<typeof ColumnTransformSchema>

export function columnTransformKey(t: {
  database: string
  schema?: string | undefined
  table: string
  column: string
}): string {
  return JSON.stringify([t.database, t.schema ?? '', t.table, t.column])
}

/**
 * The URL a link transformation points at, or null when it would not be an http(s) link. Without a template the
 * value itself must be one; with one, `{value}` is replaced by the URL-encoded value. Anything else — a
 * `javascript:` value, a template that stops being http(s) — renders as plain text.
 */
export function transformLink(value: string, template?: string): string | null {
  const href = template ? template.replaceAll('{value}', encodeURIComponent(value)) : value.trim()
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

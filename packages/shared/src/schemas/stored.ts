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
  // A language code (`ja`, `en`, `de`…): which ones this build has is the web app's to say, so adding one changes no schema.
  locale: z
    .string()
    .regex(/^[a-z]{2,3}$/)
    .optional(),
  browseLimit: z.number().int().min(1).max(BROWSE_MAX_LIMIT).optional(),
  /** Offers "show all rows" on a table's rows (off unless chosen: a large table read whole is slow). */
  browseUnlimited: z.boolean().optional(),
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
  browseUnlimited: PreferencesSchema.shape.browseUnlimited.unwrap().nullable().optional(),
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
 * phpMyAdmin's browser transformations, the ones that are safe to offer. Display: a binary value shown as the image it
 * holds; a value as a link (http / https only, the value URL-encoded into an optional template); JSON indented; a
 * value as hex, cut to a part, as a yes / no, as a formatted date, as an IPv4 address, or with text around it. Input
 * (the insert and edit forms): a pattern the value must match, and editors that check JSON or XML, or just give room to
 * SQL. Display only changes how a value looks — what is stored and what an edit writes are unchanged.
 */
export const DISPLAY_TRANSFORMS = [
  'image',
  'link',
  'json',
  'hex',
  'substring',
  'boolean',
  'date',
  'ipv4',
  'affix',
] as const
export const INPUT_TRANSFORMS = ['pattern', 'json-input', 'xml-input', 'sql-input'] as const
export const TransformKindSchema = z.enum([...DISPLAY_TRANSFORMS, ...INPUT_TRANSFORMS])
export type TransformKind = z.infer<typeof TransformKindSchema>
export const isInputTransform = (kind: TransformKind): boolean => (INPUT_TRANSFORMS as readonly string[]).includes(kind)

/** A link template: an http(s) URL where `{value}` stands for the cell. */
const LINK_TEMPLATE = /^https?:\/\/[^\s]+$/i

const TEXT = z.string().max(60)

export const ColumnTransformBodySchema = z
  .object({
    database: IDENT,
    schema: IDENT.optional(),
    table: IDENT,
    column: IDENT,
    kind: TransformKindSchema,
    template: z.string().max(1000).regex(LINK_TEMPLATE).optional(),
    /** substring: where the part starts (0-based) and how long it is. */
    start: z.number().int().min(0).max(10_000).optional(),
    length: z.number().int().min(1).max(10_000).optional(),
    /** boolean: what a true and a false value read as (empty: yes / no in the interface's language). */
    trueText: TEXT.optional(),
    falseText: TEXT.optional(),
    /** date: the pattern (YYYY YY MM M DD D HH H hh h mm ss A; text in [brackets] is kept as written). */
    format: TEXT.min(1).optional(),
    /** affix: what goes before and after the value. */
    prefix: TEXT.optional(),
    suffix: TEXT.optional(),
    /** pattern: a regular expression the value has to match somewhere in it, and what to say when it does not. */
    pattern: z.string().min(1).max(200).optional(),
    message: z.string().max(200).optional(),
  })
  .superRefine((t, ctx) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [path], message })
    }
    need(t.kind === 'link' || t.template === undefined, 'template', 'Only a link takes a template')
    need(t.kind !== 'substring' || t.length !== undefined, 'length', 'A substring needs a length')
    need(t.kind !== 'date' || t.format !== undefined, 'format', 'A date needs a format')
    need(t.kind !== 'affix' || Boolean(t.prefix || t.suffix), 'prefix', 'An affix needs text before or after')
    need(t.kind !== 'pattern' || t.pattern !== undefined, 'pattern', 'A pattern needs an expression')
    if (t.kind === 'pattern' && t.pattern !== undefined) {
      try {
        new RegExp(t.pattern)
      } catch {
        need(false, 'pattern', 'The expression is not a valid regular expression')
      }
    }
  })
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
  kind?: TransformKind
}): string {
  // A column has one display transformation and one for input: the input one is keyed apart.
  const base = [t.database, t.schema ?? '', t.table, t.column]
  return JSON.stringify(t.kind !== undefined && isInputTransform(t.kind) ? [...base, 'input'] : base)
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

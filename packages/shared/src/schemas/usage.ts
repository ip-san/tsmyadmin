import { z } from 'zod'

/** How one table has been read since the server started counting: through no index (in full) or through one. */
export const TableUsageSchema = z.object({
  table: z.string(),
  fullReads: z.number(),
  indexReads: z.number(),
})
export type TableUsage = z.infer<typeof TableUsageSchema>

/** How often one index has been read. A unique index (and a primary key) also keeps rows unique, read or not. */
export const IndexUsageSchema = z.object({
  table: z.string(),
  index: z.string(),
  reads: z.number(),
  unique: z.boolean(),
})
export type IndexUsage = z.infer<typeof IndexUsageSchema>

/**
 * How the tables of a database (PostgreSQL: of a schema) are read (GET /databases/:db/usage). The counts are the
 * server's own and run since `since` (a statistics reset, or the server's start). `unit` says what is counted:
 * PostgreSQL counts scans, MySQL / MariaDB count rows read. `status` as for lock waits: the account may not read the
 * statistics (`denied`), or the server keeps none (`unsupported`: performance_schema off, as MariaDB has it by default).
 */
export const TableUsageReportSchema = z.object({
  status: z.enum(['ok', 'denied', 'unsupported']),
  unit: z.enum(['scans', 'rows']),
  since: z.string().nullable(),
  tables: z.array(TableUsageSchema),
  indexes: z.array(IndexUsageSchema),
})
export type TableUsageReport = z.infer<typeof TableUsageReportSchema>

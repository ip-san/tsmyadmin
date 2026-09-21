import { z } from 'zod'

/** A saved copy of one database (or PostgreSQL schema) that it can be put back to: kept by the server, in memory. */
export const SnapshotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  /** When it was taken (ISO 8601). */
  at: z.string(),
  /** Size of the dump it holds. */
  bytes: z.number().int().min(0),
  /** Tables and views it holds. */
  objects: z.number().int().min(0),
})
export type Snapshot = z.infer<typeof SnapshotSchema>

export const SnapshotListSchema = z.object({
  snapshots: z.array(SnapshotSchema),
  /** The most a database keeps, and the most bytes one dump may take: what "too many / too large" is measured by. */
  maxCount: z.number().int(),
  maxBytes: z.number().int(),
})
export type SnapshotList = z.infer<typeof SnapshotListSchema>

export const SnapshotCreateSchema = z.object({ name: z.string().trim().min(1).max(80) })
export type SnapshotCreate = z.infer<typeof SnapshotCreateSchema>

/** What putting a snapshot back would do, before it does it. */
export const SnapshotRestorePreviewSchema = z.object({
  snapshot: SnapshotSchema,
  /** Statements of the dump that will run. */
  statements: z.number().int().min(0),
  /** The statements that remove what the snapshot does not have (tables and views made since). */
  drops: z.array(z.string()),
})
export type SnapshotRestorePreview = z.infer<typeof SnapshotRestorePreviewSchema>

export const SnapshotRestoreResultSchema = z.object({
  statements: z.number().int().min(0),
  failed: z.number().int().min(0),
  /** The first errors, as the server printed them. */
  errors: z.array(z.string()),
  durationMs: z.number(),
})
export type SnapshotRestoreResult = z.infer<typeof SnapshotRestoreResultSchema>

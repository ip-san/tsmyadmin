import { z } from 'zod'

/**
 * What phpMyAdmin's Replication tab does beyond showing the state: start and stop the replica's threads, skip a
 * failing statement, reset, and point the replica at a source. On PostgreSQL start / stop are the pause and resume
 * of WAL replay on a standby; the rest is MySQL's (a standby's source is `primary_conninfo`, a setting).
 */
const Threads = z.enum(['all', 'io', 'sql']).default('all')

export const ReplicationOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('startReplica'), threads: Threads }),
  z.object({ op: z.literal('stopReplica'), threads: Threads }),
  z.object({ op: z.literal('skipReplicaError'), count: z.number().int().min(1).max(1000).default(1) }),
  z.object({ op: z.literal('resetReplica'), all: z.boolean().default(false) }),
  z.object({
    op: z.literal('changeSource'),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65_535).default(3306),
    user: z.string().min(1).max(128),
    password: z.string().min(1),
    /** Where to begin reading the source's binary log (unused with `autoPosition`). */
    logFile: z
      .string()
      .regex(/^[\w.-]+$/)
      .optional(),
    logPos: z.number().int().min(4).optional(),
    /** GTID auto-positioning (MariaDB: `MASTER_USE_GTID = slave_pos`). */
    autoPosition: z.boolean().default(false),
    /** Start the replica again after the change. */
    start: z.boolean().default(true),
  }),
])
export type ReplicationOp = z.infer<typeof ReplicationOpSchema>
export type ReplicationOpInput = z.input<typeof ReplicationOpSchema>
export const REPLICATION_OP_NAMES = ReplicationOpSchema.options.map((o) => o.shape.op.value)

export const ReplicationOpRequestSchema = z.object({ op: ReplicationOpSchema })

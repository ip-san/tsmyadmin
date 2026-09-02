import { z } from 'zod'

/** MySQL scheduled event. PostgreSQL has no built-in scheduler (listEvents returns []). */
export const EventInfoSchema = z.object({
  name: z.string(),
  /** 'ENABLED' | 'DISABLED' | 'SLAVESIDE_DISABLED' */
  status: z.string(),
  /** 'ONE TIME' | 'RECURRING' */
  type: z.string(),
  /** Human-readable schedule, e.g. "EVERY 1 DAY" or "AT 2030-01-01 00:00:00". */
  schedule: z.string(),
  starts: z.string().nullable(),
  ends: z.string().nullable(),
  lastExecuted: z.string().nullable(),
  onCompletion: z.string().nullable(),
  comment: z.string().nullable(),
  definition: z.string().nullable(),
})
export type EventInfo = z.infer<typeof EventInfoSchema>

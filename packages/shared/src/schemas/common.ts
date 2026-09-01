import { z } from 'zod'

/** Boolean flag in query strings / form fields ("0" | "1"). */
export const FlagSchema = z.enum(['0', '1'])

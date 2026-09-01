import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import type { z } from 'zod'
import { apiError } from './errors.ts'

/** zValidator with the project's error envelope. */
export function validate<T extends z.ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const detail = result.error.issues.map((i) => `${i.path.join('.') || target}: ${i.message}`).join('; ')
      return c.json(apiError('VALIDATION', 'Invalid request', detail), 400)
    }
    return undefined
  })
}

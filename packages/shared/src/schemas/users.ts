import { z } from 'zod'

/** A login account: MySQL user@host or a PostgreSQL role. */
export const UserInfoSchema = z.object({
  name: z.string(),
  /** MySQL host part; null for PostgreSQL. */
  host: z.string().nullable(),
  canLogin: z.boolean(),
  /** Dialect attributes, e.g. SUPERUSER / CREATEDB / CREATEROLE / LOCKED / EXPIRED. */
  attributes: z.array(z.string()),
})
export type UserInfo = z.infer<typeof UserInfoSchema>

export const UserRefSchema = z.object({ name: z.string().min(1), host: z.string().min(1).optional() })
export type UserRef = z.infer<typeof UserRefSchema>

export const UserAttributesSchema = z.object({
  superuser: z.boolean().default(false),
  createdb: z.boolean().default(false),
  createrole: z.boolean().default(false),
})

export const UserOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('createUser'),
    user: UserRefSchema,
    password: z.string(),
    attributes: UserAttributesSchema.default({ superuser: false, createdb: false, createrole: false }),
  }),
  z.object({ op: z.literal('dropUser'), user: UserRefSchema }),
  z.object({ op: z.literal('setPassword'), user: UserRefSchema, password: z.string() }),
  z.object({
    op: z.literal('grantAll'),
    user: UserRefSchema,
    database: z.string().min(1),
    schema: z.string().min(1).optional(),
  }),
  z.object({
    op: z.literal('revokeAll'),
    user: UserRefSchema,
    database: z.string().min(1),
    schema: z.string().min(1).optional(),
  }),
])
export type UserOp = z.infer<typeof UserOpSchema>
export type UserOpInput = z.input<typeof UserOpSchema>
export const USER_OP_NAMES = UserOpSchema.options.map((o) => o.shape.op.value)

export const UserOpRequestSchema = z.object({ op: UserOpSchema })
export const UserGrantsSchema = z.object({ statements: z.array(z.string()) })
export type UserGrants = z.infer<typeof UserGrantsSchema>
export const PASSWORD_MASK = '****'

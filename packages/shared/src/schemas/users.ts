import { z } from 'zod'
import { StatementResultSchema } from './result.ts'

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

/**
 * Privileges both dialects accept on a table and on a whole database / schema. Deliberately a closed list: the
 * names are rendered into SQL, so nothing free-text may reach it. Dialect-only privileges (MySQL `INDEX`,
 * PostgreSQL `TRUNCATE`) are left to the SQL tab rather than guessed at per server.
 */
export const PrivilegeSchema = z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'TRIGGER'])
export type Privilege = z.infer<typeof PrivilegeSchema>
export const PRIVILEGES = PrivilegeSchema.options

/**
 * The privileges that can name columns. Both dialects accept exactly these four per column — DELETE and TRIGGER
 * act on the whole table and have no column form — and the conformance suite proves it against both servers
 * rather than trusting the documentation.
 */
export const ColumnPrivilegeSchema = PrivilegeSchema.extract(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'])
export type ColumnPrivilege = z.infer<typeof ColumnPrivilegeSchema>
export const COLUMN_PRIVILEGES = ColumnPrivilegeSchema.options

/**
 * `table` absent = the whole database (PostgreSQL: the schema, plus the default for tables created later).
 * `columns` narrows the grant to those columns of that table; it needs a table, and only the privileges in
 * `COLUMN_PRIVILEGES` have a column form. Both are enforced below so a bad combination cannot reach the preview.
 */
const PrivilegeTarget = {
  user: UserRefSchema,
  privileges: z.array(PrivilegeSchema).min(1),
  database: z.string().min(1),
  schema: z.string().min(1).optional(),
  table: z.string().min(1).optional(),
  columns: z.array(z.string().min(1)).min(1).optional(),
}

type PrivilegeTargetValue = {
  privileges: Privilege[]
  table?: string | undefined
  columns?: string[] | undefined
}

/** Reason a target is not a valid column grant, or null. Shared by the schema and the privileges form. */
export function columnTargetError(target: PrivilegeTargetValue): 'needsTable' | 'notColumnPrivilege' | null {
  if (!target.columns) return null
  if (target.table === undefined) return 'needsTable'
  const wholeTableOnly = target.privileges.filter((p) => !COLUMN_PRIVILEGES.includes(p as ColumnPrivilege))
  return wholeTableOnly.length > 0 ? 'notColumnPrivilege' : null
}

const MESSAGES: Record<NonNullable<ReturnType<typeof columnTargetError>>, string> = {
  needsTable: 'columns apply to one table: name the table as well',
  notColumnPrivilege: `only ${COLUMN_PRIVILEGES.join(', ')} can name columns`,
}

export const UserOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('grantPrivileges'), ...PrivilegeTarget }),
  z.object({ op: z.literal('revokePrivileges'), ...PrivilegeTarget }),
  z.object({
    op: z.literal('createUser'),
    user: UserRefSchema,
    password: z.string().min(1),
    attributes: UserAttributesSchema.default({ superuser: false, createdb: false, createrole: false }),
  }),
  z.object({ op: z.literal('dropUser'), user: UserRefSchema }),
  z.object({ op: z.literal('setPassword'), user: UserRefSchema, password: z.string().min(1) }),
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

export const UserOpRequestSchema = z.object({ op: UserOpSchema }).superRefine(({ op }, ctx) => {
  if (op.op !== 'grantPrivileges' && op.op !== 'revokePrivileges') return
  const problem = columnTargetError(op)
  if (problem) ctx.addIssue({ code: 'custom', path: ['op', 'columns'], message: MESSAGES[problem] })
})

/**
 * Response of POST /users/execute: one result per statement of the operation (a failing wrapper COMMIT is
 * appended as its own result), and whether the whole operation was rolled back — PostgreSQL runs a multi-statement
 * account operation in one transaction, so a later failure undoes the statements that had succeeded.
 */
export const UserOpResponseSchema = z.object({
  results: z.array(StatementResultSchema),
  rolledBack: z.boolean(),
})
export type UserOpResponse = z.infer<typeof UserOpResponseSchema>
/** Query of GET /users/grants: the account plus, optionally, the database (and schema) whose ACLs to list. */
export const UserGrantsQuerySchema = UserRefSchema.extend({
  database: z.string().min(1).optional(),
  schema: z.string().min(1).optional(),
})
export type UserGrantsQuery = z.infer<typeof UserGrantsQuerySchema>

export const UserGrantsSchema = z.object({ statements: z.array(z.string()) })
export type UserGrants = z.infer<typeof UserGrantsSchema>
export const PASSWORD_MASK = '****'

import { z } from 'zod'
import { hasStatementBreak } from './ddl.ts'
import { StatementResultSchema } from './result.ts'

/** A login account: MySQL user@host or a PostgreSQL role. */
/** What an account may use per hour and how it may connect (MySQL `REQUIRE` and `WITH MAX_…`; PostgreSQL: connections). */
export const AccountLimitsSchema = z.object({
  require: z.enum(['NONE', 'SSL', 'X509']).default('NONE'),
  maxQueries: z.number().int().min(0).default(0),
  maxUpdates: z.number().int().min(0).default(0),
  maxConnections: z.number().int().min(0).default(0),
  /** Simultaneous connections: 0 is no limit on MySQL, PostgreSQL uses -1 for that and reports 0 here. */
  maxUserConnections: z.number().int().min(0).default(0),
})
export type AccountLimits = z.infer<typeof AccountLimitsSchema>

export const UserInfoSchema = z.object({
  name: z.string(),
  /** MySQL host part; null for PostgreSQL. */
  host: z.string().nullable(),
  canLogin: z.boolean(),
  /** Dialect attributes, e.g. SUPERUSER / CREATEDB / CREATEROLE / LOCKED / EXPIRED. */
  attributes: z.array(z.string()),
  /** Resource limits and connection requirements; null where the server does not say. */
  limits: AccountLimitsSchema.nullable().optional(),
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
 * MySQL's global privileges, for the account editor. A closed list: they are written unquoted into GRANT / REVOKE.
 * GRANT OPTION is here too — `GRANT GRANT OPTION ON *.*` is how it is given on its own.
 */
export const GLOBAL_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'RELOAD',
  'SHUTDOWN',
  'PROCESS',
  'FILE',
  'REFERENCES',
  'INDEX',
  'ALTER',
  'SHOW DATABASES',
  'SUPER',
  'CREATE TEMPORARY TABLES',
  'LOCK TABLES',
  'EXECUTE',
  'REPLICATION SLAVE',
  'REPLICATION CLIENT',
  'CREATE VIEW',
  'SHOW VIEW',
  'CREATE ROUTINE',
  'ALTER ROUTINE',
  'CREATE USER',
  'EVENT',
  'TRIGGER',
  'GRANT OPTION',
] as const
export const GlobalPrivilegeSchema = z.enum(GLOBAL_PRIVILEGES)
export type GlobalPrivilege = z.infer<typeof GlobalPrivilegeSchema>

/** MySQL's password plugins the create form offers (MariaDB spells them differently and is left to its default). */
export const AUTH_PLUGINS = ['mysql_native_password', 'caching_sha2_password', 'sha256_password'] as const

/** Privileges on one routine (PostgreSQL has EXECUTE only). */
export const RoutinePrivilegeSchema = z.enum(['EXECUTE', 'ALTER ROUTINE', 'GRANT OPTION'])
export type RoutinePrivilege = z.infer<typeof RoutinePrivilegeSchema>

const RoutineTarget = {
  user: UserRefSchema,
  privileges: z.array(RoutinePrivilegeSchema).min(1),
  database: z.string().min(1),
  schema: z.string().min(1).optional(),
  routine: z.string().min(1),
  kind: z.enum(['PROCEDURE', 'FUNCTION']),
  /** PostgreSQL names an overload by its argument types. */
  parameters: z
    .string()
    .max(4000)
    .refine((s) => !hasStatementBreak(s) && !/--|\/\*/.test(s), 'A parameter list cannot contain ; or a comment')
    .optional(),
}

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
  /** Grant: add WITH GRANT OPTION. Revoke: take only the grant option away and keep the privileges. */
  grantOption: z.boolean().optional(),
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
    /** MySQL: the password plugin. */
    plugin: z.enum(AUTH_PLUGINS).optional(),
    /** MySQL: a database of the account's own name, with all privileges on it. */
    createDatabase: z.boolean().optional(),
    /** MySQL: all privileges on every database named `account_…` (the name followed by `_` and anything). */
    grantWildcard: z.boolean().optional(),
    /** An account a replica connects with: MySQL REPLICATION SLAVE on `*.*`, PostgreSQL the REPLICATION attribute. */
    replication: z.boolean().optional(),
  }),
  z.object({ op: z.literal('lockUser'), user: UserRefSchema, locked: z.boolean() }),
  z.object({ op: z.literal('renameUser'), user: UserRefSchema, newUser: UserRefSchema }),
  /**
   * A new account with the same privileges. `grants` are the source's own statements (SHOW GRANTS), filled in by
   * the server from the source account — never taken from the client — and pointed at the new account.
   */
  z.object({
    op: z.literal('copyUser'),
    user: UserRefSchema,
    newUser: UserRefSchema,
    password: z.string().min(1),
    grants: z.array(z.string()).max(5000).optional(),
  }),
  z.object({
    op: z.literal('setAccountLimits'),
    user: UserRefSchema,
    require: z.enum(['NONE', 'SSL', 'X509']).optional(),
    maxQueries: z.number().int().min(0).max(4_294_967_295).optional(),
    maxUpdates: z.number().int().min(0).max(4_294_967_295).optional(),
    maxConnections: z.number().int().min(0).max(4_294_967_295).optional(),
    maxUserConnections: z.number().int().min(0).max(4_294_967_295).optional(),
  }),
  /** MySQL global privileges: the ones to add and the ones to take away, in one preview. */
  z.object({
    op: z.literal('changeGlobalPrivileges'),
    user: UserRefSchema,
    grant: z.array(GlobalPrivilegeSchema).max(64).default([]),
    revoke: z.array(GlobalPrivilegeSchema).max(64).default([]),
  }),
  /** PostgreSQL role attributes; each one given is switched on or off. */
  z.object({
    op: z.literal('alterRole'),
    user: UserRefSchema,
    superuser: z.boolean().optional(),
    createdb: z.boolean().optional(),
    createrole: z.boolean().optional(),
    replication: z.boolean().optional(),
    bypassrls: z.boolean().optional(),
    inherit: z.boolean().optional(),
    login: z.boolean().optional(),
  }),
  z.object({ op: z.literal('grantRoutinePrivileges'), ...RoutineTarget }),
  z.object({ op: z.literal('revokeRoutinePrivileges'), ...RoutineTarget }),
  z.object({ op: z.literal('dropUser'), user: UserRefSchema }),
  /**
   * Several accounts dropped together (phpMyAdmin's "Remove selected user accounts"). `revokeFirst` takes their privileges
   * away before dropping (PostgreSQL: hands what they own to the acting role and drops their grants, which a role that
   * owns or holds anything needs before it can be dropped); `dropSameNameDatabases` also drops the database each account's
   * name names (MySQL only, never a system one).
   */
  z.object({
    op: z.literal('dropUsers'),
    users: z.array(UserRefSchema).min(1).max(200),
    revokeFirst: z.boolean().optional(),
    dropSameNameDatabases: z.boolean().optional(),
  }),
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

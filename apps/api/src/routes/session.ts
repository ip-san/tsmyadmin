import { createHash } from 'node:crypto'
import { AdapterError } from '@tsmyadmin/adapter'
import type { ExportTemplate, SavedQuery, SecondFactorState, SecondFactorStatus } from '@tsmyadmin/shared'
import {
  ExportTemplateBodySchema,
  exportTemplateKey,
  LoginRequestSchema,
  SavedQueryIdSchema,
  SaveExportTemplateRequestSchema,
  SaveQueryRequestSchema,
  SecondFactorCodeRequestSchema,
} from '@tsmyadmin/shared'
import { type Context, Hono } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { isHostAllowed, normaliseHost } from '../lib/allowlist.ts'
import { apiError, errorResponse } from '../lib/errors.ts'
import type { Logger } from '../lib/logging.ts'
import type { RateLimiter } from '../lib/rate-limit.ts'
import { validate } from '../lib/validate.ts'

const HOST_ACL_CODES = new Set(['ER_HOST_NOT_PRIVILEGED', 'ER_HOST_IS_BLOCKED'])

import { z } from 'zod'
import { hashRecoveryCode, newRecoveryCodes, newSecret, otpauthUri, verifyCode } from '../lib/totp.ts'
import {
  type AppEnv,
  requireSession,
  SESSION_COOKIE,
  type SessionConfig,
  sessionCookieOptions,
} from '../session/middleware.ts'
import type { SavedItem, SecondFactor } from '../session/store.ts'
import { type Session, sessionInfo } from '../session/store.ts'

export interface SessionRouteDeps {
  allowedHosts: readonly string[]
  /** Per ip|user window (reset on success). */
  loginLimiter: RateLimiter
  /** Coarser per-IP window of *failed* attempts so rotating the user name cannot bypass the limit. */
  ipLimiter: RateLimiter
  /** Client IP resolver shared with the access log. */
  ip: (c: Context) => string
  /**
   * Whether the request reached us over TLS (directly, or via a proxy's X-Forwarded-Proto when trusted), or from
   * loopback. A `Secure` cookie issued over plain HTTP is dropped by the browser: the login is refused instead.
   */
  secureTransport: (c: Context) => boolean
  /** Clock, so a test can place a one-time code in a known 30-second step. */
  now: () => number
  logger: Logger
}

/** Log-safe session reference: a truncated hash, so logs plus the signing secret cannot forge a cookie. */
function sessionTag(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 16)
}

const SECOND_FACTOR_NEEDS_STORE = 'A second factor needs a persistent session store'
/** How long an enrolment may sit half-finished before the secret it offered is forgotten. */
const ENROLMENT_WINDOW_MS = 10 * 60_000

/** Secrets offered to a session but not yet confirmed. Never stored: a half-enrolment must not lock anyone out. */
const pending = new Map<string, { secret: string; recoveryCodes: string[]; at: number }>()

/** Session response: identity plus the namespace usable for server-level SQL/DDL (SessionState). */
async function sessionState(cfg: SessionConfig, session: Session, savedQueries: 'server' | 'browser') {
  return {
    ...sessionInfo(session),
    serverDatabase: session.adapter.serverNamespace.database,
    savedQueries,
    secondFactor: await secondFactorState(cfg, session),
  }
}

async function secondFactorState(cfg: SessionConfig, session: Session): Promise<SecondFactorState> {
  const factor = await cfg.store.secondFactor?.get(session.config)
  if (factor) return 'enrolled'
  return cfg.require2fa ? 'enrollment_required' : 'none'
}

async function secondFactorStatus(cfg: SessionConfig, session: Session): Promise<SecondFactorStatus> {
  const factor = await cfg.store.secondFactor?.get(session.config)
  return {
    state: await secondFactorState(cfg, session),
    recoveryCodesLeft: factor?.recoveryHashes.length ?? 0,
  }
}

/**
 * A code at login: the app's own, or one of the recovery codes, each usable once. The step (or the used code)
 * is written down before the login is accepted, so a code seen by someone else cannot be used again.
 */
async function spendCode(
  cfg: SessionConfig,
  config: Session['config'],
  factor: SecondFactor,
  code: string,
  at: number
): Promise<boolean> {
  const store = cfg.store.secondFactor
  if (!store) return false
  const step = verifyCode(factor.secret, code, at, factor.lastStep)
  // The write carries the version the factor was read at: if another login spent this same code first, it does
  // not land, and this one is refused rather than both being let through.
  if (step !== null) return store.set(config, { ...factor, lastStep: step })
  const hash = hashRecoveryCode(code)
  if (!factor.recoveryHashes.includes(hash)) return false
  return store.set(config, { ...factor, recoveryHashes: factor.recoveryHashes.filter((h) => h !== hash) })
}

/**
 * A refused code, counted on the per-IP budget that limits login failures: six digits are guessable in a few
 * hundred thousand tries, and these routes are otherwise only guarded by holding a session.
 */
function tooManyCodes(c: Context, deps: SessionRouteDeps) {
  const budget = deps.ipLimiter.peek(deps.ip(c))
  if (budget.allowed) return null
  c.header('Retry-After', String(budget.retryAfterSec))
  return c.json(apiError('RATE_LIMITED', 'Too many code attempts; try again later'), 429)
}

function codeRefused(c: Context, deps: SessionRouteDeps, event: string) {
  deps.ipLimiter.hit(deps.ip(c))
  deps.logger.log('warn', event, { requestId: c.get('requestId'), ...sessionInfo(c.get('session')) })
  return c.json(apiError('SECOND_FACTOR_INVALID', 'That code is not valid'), 401)
}

/** Enrolment is the one thing an account that must enrol may do, so these routes bypass that gate. */
function requireEnrollable(cfg: SessionConfig) {
  return requireSession({ ...cfg, require2fa: false })
}

export function sessionRoutes(cfg: SessionConfig, deps: SessionRouteDeps) {
  // Constant for the life of the process: it depends on which store was configured, not on the session.
  const savedQueriesMode = cfg.store.savedQueries ? 'server' : 'browser'
  return (
    new Hono<AppEnv>()
      .post('/session', validate('json', LoginRequestSchema), async (c) => {
        const { code, ...body } = c.req.valid('json')
        const ip = deps.ip(c)
        const rateKey = `${ip}|${body.user}`
        const audit = {
          requestId: c.get('requestId'),
          ip,
          dialect: body.dialect,
          host: body.host,
          port: body.port,
          user: body.user,
        }

        // The IP limiter counts failures only (a shared office NAT must not be locked out by successful logins).
        // It is checked first so a blocked client cannot grow the ip|user map with fresh user names.
        // A deployment refusing plain HTTP must not also lock its users out: checked before any attempt is counted.
        if (cfg.secure && !deps.secureTransport(c)) {
          deps.logger.log('warn', 'login.insecure_transport', audit)
          return c.json(
            apiError('INSECURE_TRANSPORT', 'The session cookie is Secure: log in over HTTPS (or set COOKIE_SECURE=0)'),
            400
          )
        }
        const perIp = deps.ipLimiter.peek(ip)
        if (!perIp.allowed) {
          deps.logger.log('warn', 'login.rate_limited', audit)
          c.header('Retry-After', String(perIp.retryAfterSec))
          return c.json(apiError('RATE_LIMITED', 'Too many login attempts; try again later'), 429)
        }
        // Before the per-user counter, so a mistyped host does not spend the budget for the user's real logins;
        // counted on the IP instead, because probing the allowlist is exactly the kind of sweep that limiter is
        // for (the 403-vs-401 difference tells a caller which hosts exist).
        if (!isHostAllowed(body.host, body.port, deps.allowedHosts)) {
          deps.ipLimiter.hit(ip)
          deps.logger.log('warn', 'login.host_not_allowed', audit)
          return c.json(
            apiError(
              'HOST_NOT_ALLOWED',
              `Connections to "${body.host}:${body.port}" are not allowed (TSMYADMIN_ALLOWED_HOSTS)`
            ),
            403
          )
        }
        const limit = deps.loginLimiter.hit(rateKey)
        if (!limit.allowed) {
          deps.logger.log('warn', 'login.rate_limited', audit)
          c.header('Retry-After', String(limit.retryAfterSec))
          return c.json(apiError('RATE_LIMITED', 'Too many login attempts; try again later'), 429)
        }

        const config = { ...body, host: normaliseHost(body.host) }
        // Read before connecting, so a login that is about to be refused for a missing or wrong code does not
        // close the sessions this account is already using (the per-account limit is applied after the code).
        const enrolled = (await cfg.store.secondFactor?.get(config)) !== null && cfg.store.secondFactor !== undefined
        let session: Awaited<ReturnType<typeof cfg.store.create>>
        try {
          // The store builds the (audited) adapter, pings it and persists the session in one step.
          session = await cfg.store.create(config, { keepOthers: enrolled })
        } catch (err) {
          deps.ipLimiter.hit(ip)
          deps.logger.log('warn', 'login.failed', audit)
          // The server's own wording ("Access denied for user 'u'@'<api host address>'") would hand an
          // unauthenticated caller the API's egress address; the code says everything the user needs.
          if (err instanceof AdapterError && err.code === 'AUTH_FAILED') {
            return c.json(apiError('AUTH_FAILED', 'Authentication failed'), 401)
          }
          // MySQL host ACL errors ("Host '<api address>' is not allowed / blocked") name the API's own address.
          if (err instanceof AdapterError && HOST_ACL_CODES.has(err.nativeCode ?? '')) {
            return c.json(apiError('CONNECTION_FAILED', 'The server refused connections from this host'), 502)
          }
          return errorResponse(c, err, deps.logger)
        }
        // The password is right; now the second factor, if this account has one. A refusal leaves nothing
        // behind — the session and its connection go — so there is no half-authenticated state to expire.
        const factor = enrolled ? ((await cfg.store.secondFactor?.get(session.config)) ?? null) : null
        if (factor) {
          const checked = code === undefined ? null : await spendCode(cfg, session.config, factor, code, deps.now())
          if (!checked) {
            await cfg.store.delete(session.id)
            deps.ipLimiter.hit(ip)
            deps.logger.log(
              'warn',
              code === undefined ? 'login.second_factor.missing' : 'login.second_factor.failed',
              audit
            )
            return code === undefined
              ? c.json(apiError('SECOND_FACTOR_REQUIRED', 'This account needs a one-time code'), 401)
              : c.json(apiError('SECOND_FACTOR_INVALID', 'That code is not valid'), 401)
          }
        }
        if (enrolled) await cfg.store.enforceLimit(session.config, session.id)
        deps.loginLimiter.reset(rateKey)
        // A browser that logs in again without logging out must not keep its previous session (and pools) alive —
        // dropped only now, so a failed re-login leaves the existing session untouched.
        const previous = await getSignedCookie(c, cfg.secret, SESSION_COOKIE)
        if (previous && previous !== session.id) await cfg.store.delete(previous)
        deps.logger.log('info', 'login.ok', { ...audit, sessionId: sessionTag(session.id) })
        await setSignedCookie(c, SESSION_COOKIE, session.id, cfg.secret, sessionCookieOptions(cfg))
        return c.json(await sessionState(cfg, session, savedQueriesMode), 201)
      })
      .get('/session', requireEnrollable(cfg), async (c) =>
        c.json(await sessionState(cfg, c.get('session'), savedQueriesMode))
      )
      // Enrolment: the secret is held here until a code proves the app has it, so a half-finished enrolment
      // cannot lock the account out. It is tied to the session and forgotten when that session goes.
      .post('/second-factor/begin', requireEnrollable(cfg), async (c) => {
        const store = cfg.store.secondFactor
        if (!store) return c.json(apiError('UNSUPPORTED', SECOND_FACTOR_NEEDS_STORE), 400)
        const limited = tooManyCodes(c, deps)
        if (limited) return limited
        const session = c.get('session')
        // Replacing one that exists proves the current one first: otherwise a stolen session could enrol its own
        // secret over it, which is the removal this route is not — and the removal route does ask for a code.
        const existing = await store.get(session.config)
        if (existing) {
          const body = await c.req.json().catch(() => ({}))
          const given = SecondFactorCodeRequestSchema.safeParse(body)
          const step = given.success
            ? verifyCode(existing.secret, given.data.code, deps.now(), existing.lastStep)
            : null
          if (step === null) return codeRefused(c, deps, 'second_factor.reenrol.failed')
          await store.set(session.config, { ...existing, lastStep: step })
        }
        const secret = newSecret()
        const recoveryCodes = newRecoveryCodes()
        for (const [id, started] of pending) if (deps.now() - started.at > ENROLMENT_WINDOW_MS) pending.delete(id)
        pending.set(session.id, { secret, recoveryCodes, at: deps.now() })
        const info = sessionInfo(session)
        return c.json({
          secret,
          uri: otpauthUri(secret, `${info.user}@${info.host}:${info.port}`),
          recoveryCodes,
        })
      })
      .post(
        '/second-factor/confirm',
        requireEnrollable(cfg),
        validate('json', SecondFactorCodeRequestSchema),
        async (c) => {
          const store = cfg.store.secondFactor
          if (!store) return c.json(apiError('UNSUPPORTED', SECOND_FACTOR_NEEDS_STORE), 400)
          const limited = tooManyCodes(c, deps)
          if (limited) return limited
          const session = c.get('session')
          const started = pending.get(session.id)
          if (!started || deps.now() - started.at > ENROLMENT_WINDOW_MS) {
            pending.delete(session.id)
            return c.json(apiError('SECOND_FACTOR_INVALID', 'Start the enrolment again'), 401)
          }
          const step = verifyCode(started.secret, c.req.valid('json').code, deps.now())
          if (step === null) return codeRefused(c, deps, 'second_factor.confirm.failed')
          await store.set(session.config, {
            secret: started.secret,
            lastStep: step,
            recoveryHashes: started.recoveryCodes.map(hashRecoveryCode),
            at: deps.now(),
          })
          pending.delete(session.id)
          deps.logger.log('info', 'second_factor.enrolled', { requestId: c.get('requestId'), ...sessionInfo(session) })
          return c.json(await secondFactorStatus(cfg, session), 201)
        }
      )
      .get('/second-factor', requireEnrollable(cfg), async (c) =>
        c.json(await secondFactorStatus(cfg, c.get('session')))
      )
      // Turning it off takes a current code from the app, not a recovery code: a written-down code that leaked
      // should let its owner back in, not let someone else remove the factor.
      .delete('/second-factor', requireEnrollable(cfg), validate('json', SecondFactorCodeRequestSchema), async (c) => {
        const store = cfg.store.secondFactor
        if (!store) return c.json(apiError('UNSUPPORTED', SECOND_FACTOR_NEEDS_STORE), 400)
        const limited = tooManyCodes(c, deps)
        if (limited) return limited
        const session = c.get('session')
        const factor = await store.get(session.config)
        if (!factor) return c.json(apiError('NOT_FOUND', 'Nothing is enrolled for this account'), 404)
        const step = verifyCode(factor.secret, c.req.valid('json').code, deps.now(), factor.lastStep)
        if (step === null) return codeRefused(c, deps, 'second_factor.disable.failed')
        await store.clear(session.config)
        deps.logger.log('info', 'second_factor.disabled', { requestId: c.get('requestId'), ...sessionInfo(session) })
        return c.json(await secondFactorStatus(cfg, session))
      })
      // Bookmarks and export templates live with the session store, so they exist only where it is persistent.
      .get('/saved-queries', requireSession(cfg), async (c) =>
        c.json(toSavedQueries((await cfg.store.savedQueries?.list(c.get('session').config, 'sql')) ?? []))
      )
      .post('/saved-queries', requireSession(cfg), validate('json', SaveQueryRequestSchema), async (c) => {
        const store = cfg.store.savedQueries
        if (!store) return c.json(apiError('UNSUPPORTED', 'Saved queries need a persistent session store'), 400)
        const { name, sql } = c.req.valid('json')
        return c.json(toSavedQueries(await store.save(c.get('session').config, 'sql', name, sql)))
      })
      .delete('/saved-queries/:id', requireSession(cfg), validate('param', SavedQueryIdSchema), async (c) => {
        const store = cfg.store.savedQueries
        if (!store) return c.json(apiError('UNSUPPORTED', 'Saved queries need a persistent session store'), 400)
        return c.json(toSavedQueries(await store.remove(c.get('session').config, 'sql', c.req.valid('param').id)))
      })
      .get('/export-templates', requireSession(cfg), async (c) =>
        c.json(toTemplates((await cfg.store.savedQueries?.list(c.get('session').config, 'export')) ?? []))
      )
      .post('/export-templates', requireSession(cfg), validate('json', SaveExportTemplateRequestSchema), async (c) => {
        const store = cfg.store.savedQueries
        if (!store) return c.json(apiError('UNSUPPORTED', 'Export templates need a persistent session store'), 400)
        const template = c.req.valid('json')
        // Keyed by namespace and name: the store replaces by name, and two databases may use the same one.
        const key = exportTemplateKey(template)
        const config = c.get('session').config
        // A row written before templates were keyed by namespace + name sits under the bare name: saving that
        // name again would otherwise leave the two side by side, indistinguishable on screen.
        const listed = await store.list(config, 'export')
        const legacy = listed.find((item) => item.name === template.name && sameTemplate(item, template))
        // Replaced in the same write as the new row: neither briefly over the cap nor, if the write fails, gone.
        const saved = await store.save(config, 'export', key, JSON.stringify(template), legacy?.id)
        return c.json(toTemplates(saved))
      })
      .delete('/export-templates/:id', requireSession(cfg), validate('param', SavedQueryIdSchema), async (c) => {
        const store = cfg.store.savedQueries
        if (!store) return c.json(apiError('UNSUPPORTED', 'Export templates need a persistent session store'), 400)
        const left = await store.remove(c.get('session').config, 'export', c.req.valid('param').id)
        return c.json(toTemplates(left))
      })
      .delete('/session', async (c) => {
        const id = await getSignedCookie(c, cfg.secret, SESSION_COOKIE)
        if (id) {
          await cfg.store.delete(id)
          deps.logger.log('info', 'logout', { requestId: c.get('requestId'), sessionId: sessionTag(id) })
        }
        deleteCookie(c, SESSION_COOKIE, { path: '/' })
        return c.json({ ok: true })
      })
  )
}

const toSavedQueries = (items: SavedItem[]): SavedQuery[] =>
  items.map((i) => ({ id: i.id, name: i.name, sql: i.body, at: i.at }))

/**
 * Stored export templates as the client sees them.
 *
 * The name is in the payload, because the row is keyed by namespace + name and that is not what to show; a row
 * written before it was kept there (its body carries no name) falls back to the key. A body that does not parse
 * at all is left out and left alone: it may have been written by a newer version, and deleting what this one
 * cannot read would turn a downgrade — or a shape this version has not learned yet — into data loss.
 */
function toTemplates(items: SavedItem[]): ExportTemplate[] {
  const out: ExportTemplate[] = []
  for (const item of items) {
    const body = safeJson(item.body)
    const parsed = ExportTemplateBodySchema.safeParse(body)
    if (!parsed.success) continue
    const named = z
      .string()
      .min(1)
      .safeParse((body as { name?: unknown }).name)
    out.push({ ...parsed.data, id: item.id, name: named.success ? named.data : item.name, at: item.at })
  }
  return out
}

/** Whether a stored row is a template of the same database (and schema) as this one. */
function sameTemplate(item: SavedItem, template: { database: string; schema?: string | undefined }): boolean {
  const body = ExportTemplateBodySchema.safeParse(safeJson(item.body))
  return (
    body.success && body.data.database === template.database && (body.data.schema ?? '') === (template.schema ?? '')
  )
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

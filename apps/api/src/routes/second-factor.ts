import { randomBytes } from 'node:crypto'
import type {
  AccountSecondFactors,
  PasskeyAnswer,
  PasskeyChallenge,
  SecondFactorProof,
  SecondFactorState,
  SecondFactorStatus,
} from '@tsmyadmin/shared'
import {
  PasskeyConfirmRequestSchema,
  PasskeyIdSchema,
  ResetSecondFactorRequestSchema,
  SecondFactorBeginRequestSchema,
  SecondFactorCodeRequestSchema,
  SecondFactorProofSchema,
} from '@tsmyadmin/shared'
import { type Context, Hono } from 'hono'
import { apiError } from '../lib/errors.ts'
import type { Logger } from '../lib/logging.ts'
import {
  authenticationOptions,
  type PasskeyParty,
  registrationOptions,
  verifyPasskey,
  verifyRegistration,
} from '../lib/passkey.ts'
import { qrRows } from '../lib/qr.ts'
import type { RateLimiter } from '../lib/rate-limit.ts'
import { hashRecoveryCode, newRecoveryCodes, newSecret, otpauthUri, verifyCode } from '../lib/totp.ts'
import { validate } from '../lib/validate.ts'
import { identityKey } from '../session/identity.ts'
import { type AppEnv, requireSession, type SessionConfig } from '../session/middleware.ts'
import type { SecondFactor, SecondFactors, StoredPasskey } from '../session/store.ts'
import { type Session, sessionInfo } from '../session/store.ts'

export interface SecondFactorDeps {
  /** Coarser per-IP window of failed attempts, shared with the login: codes are guessable, so they count too. */
  ipLimiter: RateLimiter
  ip: (c: Context) => string
  /** Clock, so a test can place a one-time code in a known 30-second step. */
  now: () => number
  logger: Logger
  /** Where passkeys are bound (TSMYADMIN_PASSKEY_ORIGIN); null where the deployment does not offer them. */
  passkey: PasskeyParty | null
  /** Fresh WebAuthn challenges; a test replays a recorded answer by fixing them. */
  challenge: () => Uint8Array
}

const SECOND_FACTOR_NEEDS_STORE = 'A second factor needs a persistent session store'
const PASSKEYS_NEED_ORIGIN = 'Passkeys need TSMYADMIN_PASSKEY_ORIGIN'
/** How long an enrolment may sit half-finished before what it offered is forgotten. */
const ENROLMENT_WINDOW_MS = 10 * 60_000
/** How long a passkey challenge stays answerable: long enough to touch a key, short enough not to linger. */
const CHALLENGE_WINDOW_MS = 2 * 60_000

/** App secrets offered to a session but not yet confirmed. Never stored: a half-enrolment must not lock anyone out. */
const pendingTotp = new Map<string, { secret: string; recoveryCodes: string[]; at: number }>()
/** Passkey registrations started by a session, by session ID. */
const pendingPasskey = new Map<string, { challenge: string; recoveryCodes: string[]; at: number }>()
/**
 * Passkey challenges handed out, by ticket: at login bound to the account (there is no session yet), afterwards
 * bound to the session. Each is answered once.
 */
const challenges = new Map<string, { bound: string; challenge: string; at: number }>()

function sweep<T extends { at: number }>(map: Map<string, T>, now: number, window: number) {
  for (const [key, value] of map) if (now - value.at > window) map.delete(key)
}

/** Hands out a challenge bound to `bound` (an account at login, a session afterwards). */
async function issueChallenge(
  deps: SecondFactorDeps,
  rp: PasskeyParty,
  bound: string,
  have: StoredPasskey[]
): Promise<PasskeyChallenge> {
  sweep(challenges, deps.now(), CHALLENGE_WINDOW_MS)
  // One outstanding challenge per account (at login) or session: asking again replaces it, so repeated asking
  // cannot grow this map.
  for (const [ticket, issued] of challenges) if (issued.bound === bound) challenges.delete(ticket)
  const options = await authenticationOptions(rp, deps.challenge(), have)
  const ticket = randomBytes(24).toString('base64url')
  challenges.set(ticket, { bound, challenge: options.challenge, at: deps.now() })
  // Plain JSON for the browser API; the shared schema does not describe WebAuthn's option types field by field.
  return { ticket, options: options as unknown as PasskeyChallenge['options'] }
}

/** The challenge a ticket stands for, once: taken out whether or not the answer turns out to be right. */
function takeChallenge(deps: SecondFactorDeps, ticket: string, bound: string): string | null {
  const issued = challenges.get(ticket)
  challenges.delete(ticket)
  if (!issued || issued.bound !== bound || deps.now() - issued.at > CHALLENGE_WINDOW_MS) return null
  return issued.challenge
}

/** A passkey's answer to a ticket bound to `bound`, written back with its counter; false if anything is off. */
async function spendPasskey(
  cfg: SessionConfig,
  deps: SecondFactorDeps,
  config: Session['config'],
  factor: SecondFactor,
  answer: PasskeyAnswer,
  bound: string
): Promise<boolean> {
  const store = cfg.store.secondFactor
  const challenge = takeChallenge(deps, answer.ticket, bound)
  if (!store || !deps.passkey || !challenge) return false
  const passkeys = factor.passkeys ?? []
  const used = await verifyPasskey(deps.passkey, answer.response as never, challenge, passkeys)
  if (!used) return false
  // Written with the version it was read at, like a code: two logins racing on one factor do not both land.
  return store.set(config, {
    ...factor,
    passkeys: passkeys.map((p) => (p.id === used.id ? { ...p, counter: used.counter } : p)),
  })
}

export async function secondFactorState(cfg: SessionConfig, session: Session): Promise<SecondFactorState> {
  // Nowhere to keep a secret: the screen says so rather than offering an enrolment that would fail.
  if (!cfg.store.secondFactor) return 'unsupported'
  const factor = await cfg.store.secondFactor.get(session.config)
  if (factor) return 'enrolled'
  return cfg.require2fa ? 'enrollment_required' : 'none'
}

async function secondFactorStatus(
  cfg: SessionConfig,
  deps: SecondFactorDeps,
  session: Session
): Promise<SecondFactorStatus> {
  const factor = await cfg.store.secondFactor?.get(session.config)
  return {
    state: await secondFactorState(cfg, session),
    recoveryCodesLeft: factor?.recoveryHashes.length ?? 0,
    totp: factor?.secret !== undefined,
    passkeys: (factor?.passkeys ?? []).map((p) => ({ id: p.id, at: p.at })),
    passkeysAvailable: deps.passkey !== null && cfg.store.secondFactor !== undefined,
  }
}

/**
 * The second factor at login: the app's code, a passkey's answer to the challenge the previous attempt was given,
 * or one of the recovery codes — each usable once. What was used is written down before the login is accepted,
 * so a code seen by someone else cannot be used again.
 */
export async function checkLoginFactor(
  cfg: SessionConfig,
  deps: SecondFactorDeps,
  config: Session['config'],
  factor: SecondFactor,
  given: { code?: string | undefined; passkey?: PasskeyAnswer | undefined }
): Promise<'ok' | 'missing' | 'refused'> {
  const store = cfg.store.secondFactor
  if (!store) return 'refused'
  if (given.passkey) {
    return (await spendPasskey(cfg, deps, config, factor, given.passkey, identityKey(config))) ? 'ok' : 'refused'
  }
  if (given.code === undefined) return 'missing'
  const step = factor.secret ? verifyCode(factor.secret, given.code, deps.now(), factor.lastStep) : null
  // The write carries the version the factor was read at: if another login spent this same code first, it does
  // not land, and this one is refused rather than both being let through.
  if (step !== null) return (await store.set(config, { ...factor, lastStep: step })) ? 'ok' : 'refused'
  const hash = hashRecoveryCode(given.code)
  if (!factor.recoveryHashes.includes(hash)) return 'refused'
  const spent = await store.set(config, { ...factor, recoveryHashes: factor.recoveryHashes.filter((h) => h !== hash) })
  return spent ? 'ok' : 'refused'
}

/**
 * A passkey challenge for the next login attempt of this account, if it has passkeys. Only ever called once the
 * password has been accepted, so it tells nobody without the password which accounts have passkeys.
 */
export async function loginChallenge(
  deps: SecondFactorDeps,
  config: Session['config'],
  factor: SecondFactor
): Promise<PasskeyChallenge | undefined> {
  if (!deps.passkey || !factor.passkeys?.length) return undefined
  return issueChallenge(deps, deps.passkey, identityKey(config), factor.passkeys)
}

/**
 * Proof of the factor already enrolled, for changing it: a current code from the app, or a passkey's answer to a
 * challenge this session was given. Not a recovery code — a written-down code that leaked should let its owner
 * back in, not let someone else change what protects the account.
 */
async function proven(
  cfg: SessionConfig,
  deps: SecondFactorDeps,
  session: Session,
  factor: SecondFactor,
  proof: SecondFactorProof
): Promise<boolean> {
  const store = cfg.store.secondFactor
  if (!store) return false
  if ('passkey' in proof) return spendPasskey(cfg, deps, session.config, factor, proof.passkey, session.id)
  const step = factor.secret ? verifyCode(factor.secret, proof.code, deps.now(), factor.lastStep) : null
  return step !== null && store.set(session.config, { ...factor, lastStep: step })
}

/**
 * A refused code, counted on the per-IP budget that limits login failures: six digits are guessable in a few
 * hundred thousand tries, and these routes are otherwise only guarded by holding a session.
 */
function tooManyCodes(c: Context, deps: SecondFactorDeps) {
  const budget = deps.ipLimiter.peek(deps.ip(c))
  if (budget.allowed) return null
  c.header('Retry-After', String(budget.retryAfterSec))
  return c.json(apiError('RATE_LIMITED', 'Too many code attempts; try again later'), 429)
}

function codeRefused(c: Context<AppEnv>, deps: SecondFactorDeps, event: string) {
  deps.ipLimiter.hit(deps.ip(c))
  deps.logger.log('warn', event, { requestId: c.get('requestId'), ...sessionInfo(c.get('session')) })
  return c.json(apiError('SECOND_FACTOR_INVALID', 'That code is not valid'), 401)
}

/** The proof in a begin request, when one was given. */
function proofIn(body: SecondFactorProof | Record<string, never>): SecondFactorProof | null {
  return 'code' in body || 'passkey' in body ? (body as SecondFactorProof) : null
}

const CHANGE_ATTEMPTS = 3

/**
 * Changes the stored factor with compare-and-set: read, apply, and write only if nothing changed in between —
 * reading again if something did, so a method another tab added a moment ago is not written over. `apply` returns
 * null when no method is left, which removes the factor. False if other changes kept landing first.
 */
async function changeFactor(
  store: SecondFactors,
  config: Session['config'],
  apply: (current: SecondFactor | null) => SecondFactor | null
): Promise<boolean> {
  for (let attempt = 0; attempt < CHANGE_ATTEMPTS; attempt++) {
    const current = await store.get(config)
    const changed = apply(current)
    if (changed === null) {
      await store.clear(config)
      return true
    }
    const { version: _stale, ...next } = changed
    // Nothing stored yet has no version to compare with: that write is the first.
    if (await store.set(config, current?.version === undefined ? next : { ...next, version: current.version })) {
      return true
    }
  }
  return false
}

/** Without one of its methods: the whole factor goes (recovery codes too) once nothing is left to sign in with. */
function remaining(factor: SecondFactor): SecondFactor | null {
  return factor.secret !== undefined || factor.passkeys?.length ? factor : null
}

/**
 * The accounts an operator could reset: enrolled, not this session's own, and within what the database lets this
 * account alter. Another login name's factor is found by the same identity the login would use — the session's
 * dialect, host and port with that user — so it only reaches accounts signed in to through the same address.
 */
async function resettableAccounts(cfg: SessionConfig, session: Session): Promise<AccountSecondFactors> {
  const store = cfg.store.secondFactor
  if (!store) return { accounts: [] }
  const names = [...new Set((await session.adapter.listUsers()).map((u) => u.name))]
  const accounts: string[] = []
  for (const name of names) {
    if (name === session.config.user) continue
    if (!(await store.get({ ...session.config, user: name }))) continue
    if (await session.adapter.canManageAccount(name)) accounts.push(name)
  }
  return { accounts }
}

/** Enrolment is the one thing an account that must enrol may do, so these routes bypass that gate. */
export function requireEnrollable(cfg: SessionConfig) {
  return requireSession({ ...cfg, require2fa: false })
}

export function secondFactorRoutes(cfg: SessionConfig, deps: SecondFactorDeps) {
  const store = cfg.store.secondFactor
  const unsupported = (c: Context) => c.json(apiError('UNSUPPORTED', SECOND_FACTOR_NEEDS_STORE), 400)
  const noPasskeys = (c: Context) => c.json(apiError('UNSUPPORTED', PASSKEYS_NEED_ORIGIN), 400)
  const conflict = (c: Context) =>
    c.json(apiError('CONFLICT', 'Another change to the second factor landed at the same time; try again'), 409)
  const logged = (c: Context<AppEnv>, event: string) =>
    deps.logger.log('info', event, { requestId: c.get('requestId'), ...sessionInfo(c.get('session')) })
  return (
    new Hono<AppEnv>()
      .get('/second-factor', requireEnrollable(cfg), async (c) =>
        c.json(await secondFactorStatus(cfg, deps, c.get('session')))
      )
      // Enrolling an authenticator app: the secret is held here until a code proves the app has it, so a
      // half-finished enrolment cannot lock the account out. Tied to the session, forgotten when that session goes.
      .post(
        '/second-factor/begin',
        requireEnrollable(cfg),
        validate('json', SecondFactorBeginRequestSchema),
        async (c) => {
          if (!store) return unsupported(c)
          const limited = tooManyCodes(c, deps)
          if (limited) return limited
          const session = c.get('session')
          // Changing what protects an account proves what protects it now: otherwise a stolen session could put its
          // own secret there, which is the removal this route is not — and the removal route does ask for proof.
          const existing = await store.get(session.config)
          if (existing) {
            const proof = proofIn(c.req.valid('json'))
            if (!proof || !(await proven(cfg, deps, session, existing, proof))) {
              return codeRefused(c, deps, 'second_factor.reenrol.failed')
            }
          }
          const secret = newSecret()
          // Recovery codes come with the first factor; adding an app to an account that has one keeps them.
          const recoveryCodes = existing ? [] : newRecoveryCodes()
          sweep(pendingTotp, deps.now(), ENROLMENT_WINDOW_MS)
          pendingTotp.set(session.id, { secret, recoveryCodes, at: deps.now() })
          const info = sessionInfo(session)
          const uri = otpauthUri(secret, `${info.user}@${info.host}:${info.port}`)
          return c.json({ secret, uri, recoveryCodes, qr: qrRows(uri) })
        }
      )
      .post(
        '/second-factor/confirm',
        requireEnrollable(cfg),
        validate('json', SecondFactorCodeRequestSchema),
        async (c) => {
          if (!store) return unsupported(c)
          const limited = tooManyCodes(c, deps)
          if (limited) return limited
          const session = c.get('session')
          const started = pendingTotp.get(session.id)
          if (!started || deps.now() - started.at > ENROLMENT_WINDOW_MS) {
            pendingTotp.delete(session.id)
            return c.json(apiError('SECOND_FACTOR_INVALID', 'Start the enrolment again'), 401)
          }
          const step = verifyCode(started.secret, c.req.valid('json').code, deps.now())
          if (step === null) return codeRefused(c, deps, 'second_factor.confirm.failed')
          const written = await changeFactor(store, session.config, (existing) => ({
            ...(existing ?? { recoveryHashes: started.recoveryCodes.map(hashRecoveryCode) }),
            secret: started.secret,
            lastStep: step,
            at: deps.now(),
          }))
          if (!written) return conflict(c)
          pendingTotp.delete(session.id)
          logged(c, 'second_factor.enrolled')
          return c.json(await secondFactorStatus(cfg, deps, session), 201)
        }
      )
      // Turning it off entirely (every method, and the recovery codes) takes proof of what is enrolled now.
      .delete('/second-factor', requireEnrollable(cfg), validate('json', SecondFactorProofSchema), async (c) => {
        if (!store) return unsupported(c)
        const limited = tooManyCodes(c, deps)
        if (limited) return limited
        const session = c.get('session')
        const factor = await store.get(session.config)
        if (!factor) return c.json(apiError('NOT_FOUND', 'Nothing is enrolled for this account'), 404)
        if (!(await proven(cfg, deps, session, factor, c.req.valid('json')))) {
          return codeRefused(c, deps, 'second_factor.disable.failed')
        }
        await store.clear(session.config)
        logged(c, 'second_factor.disabled')
        return c.json(await secondFactorStatus(cfg, deps, session))
      })
      // Just the authenticator app, where passkeys remain to sign in with.
      .delete('/second-factor/totp', requireEnrollable(cfg), validate('json', SecondFactorProofSchema), async (c) => {
        if (!store) return unsupported(c)
        const limited = tooManyCodes(c, deps)
        if (limited) return limited
        const session = c.get('session')
        const factor = await store.get(session.config)
        if (!factor?.secret) return c.json(apiError('NOT_FOUND', 'No authenticator app is enrolled'), 404)
        if (!(await proven(cfg, deps, session, factor, c.req.valid('json')))) {
          return codeRefused(c, deps, 'second_factor.totp_remove.failed')
        }
        const written = await changeFactor(store, session.config, (current) => {
          if (!current) return null
          const { secret: _removed, ...rest } = current
          return remaining({ ...rest, lastStep: -1 })
        })
        if (!written) return conflict(c)
        logged(c, 'second_factor.totp_removed')
        return c.json(await secondFactorStatus(cfg, deps, session))
      })
      // A challenge for this session to answer with one of its passkeys, as proof for the changes above.
      .post('/second-factor/passkeys/challenge', requireEnrollable(cfg), async (c) => {
        if (!store) return unsupported(c)
        if (!deps.passkey) return noPasskeys(c)
        const limited = tooManyCodes(c, deps)
        if (limited) return limited
        const session = c.get('session')
        const passkeys = (await store.get(session.config))?.passkeys ?? []
        if (passkeys.length === 0) return c.json(apiError('NOT_FOUND', 'No passkey is enrolled'), 404)
        return c.json(await issueChallenge(deps, deps.passkey, session.id, passkeys))
      })
      // Adding a passkey. As with the app, what is enrolled already is proven first.
      .post(
        '/second-factor/passkeys/begin',
        requireEnrollable(cfg),
        validate('json', SecondFactorBeginRequestSchema),
        async (c) => {
          if (!store) return unsupported(c)
          if (!deps.passkey) return noPasskeys(c)
          const limited = tooManyCodes(c, deps)
          if (limited) return limited
          const session = c.get('session')
          const existing = await store.get(session.config)
          if (existing) {
            const proof = proofIn(c.req.valid('json'))
            if (!proof || !(await proven(cfg, deps, session, existing, proof))) {
              return codeRefused(c, deps, 'second_factor.passkey_add.failed')
            }
          }
          const recoveryCodes = existing ? [] : newRecoveryCodes()
          const info = sessionInfo(session)
          const options = await registrationOptions(
            deps.passkey,
            `${info.user}@${info.host}:${info.port}`,
            deps.challenge(),
            existing?.passkeys ?? []
          )
          sweep(pendingPasskey, deps.now(), ENROLMENT_WINDOW_MS)
          pendingPasskey.set(session.id, { challenge: options.challenge, recoveryCodes, at: deps.now() })
          return c.json({ options, recoveryCodes })
        }
      )
      .post(
        '/second-factor/passkeys/confirm',
        requireEnrollable(cfg),
        validate('json', PasskeyConfirmRequestSchema),
        async (c) => {
          if (!store) return unsupported(c)
          if (!deps.passkey) return noPasskeys(c)
          const limited = tooManyCodes(c, deps)
          if (limited) return limited
          const session = c.get('session')
          const started = pendingPasskey.get(session.id)
          pendingPasskey.delete(session.id)
          if (!started || deps.now() - started.at > ENROLMENT_WINDOW_MS) {
            return c.json(apiError('SECOND_FACTOR_INVALID', 'Start adding the passkey again'), 401)
          }
          const passkey = await verifyRegistration(
            deps.passkey,
            c.req.valid('json').response as never,
            started.challenge,
            deps.now()
          )
          if (!passkey) return codeRefused(c, deps, 'second_factor.passkey_add.failed')
          const written = await changeFactor(store, session.config, (existing) => ({
            ...(existing ?? { lastStep: -1, recoveryHashes: started.recoveryCodes.map(hashRecoveryCode) }),
            passkeys: [...(existing?.passkeys ?? []), passkey],
            at: deps.now(),
          }))
          if (!written) return conflict(c)
          logged(c, 'second_factor.passkey_added')
          return c.json(await secondFactorStatus(cfg, deps, session), 201)
        }
      )
      .delete(
        '/second-factor/passkeys/:id',
        requireEnrollable(cfg),
        validate('param', PasskeyIdSchema),
        validate('json', SecondFactorProofSchema),
        async (c) => {
          if (!store) return unsupported(c)
          const limited = tooManyCodes(c, deps)
          if (limited) return limited
          const session = c.get('session')
          const { id } = c.req.valid('param')
          const factor = await store.get(session.config)
          if (!factor?.passkeys?.some((p) => p.id === id)) {
            return c.json(apiError('NOT_FOUND', 'No such passkey'), 404)
          }
          if (!(await proven(cfg, deps, session, factor, c.req.valid('json')))) {
            return codeRefused(c, deps, 'second_factor.passkey_remove.failed')
          }
          const written = await changeFactor(store, session.config, (current) =>
            current ? remaining({ ...current, passkeys: (current.passkeys ?? []).filter((p) => p.id !== id) }) : null
          )
          if (!written) return conflict(c)
          logged(c, 'second_factor.passkey_removed')
          return c.json(await secondFactorStatus(cfg, deps, session))
        }
      )
      .get('/second-factor/accounts', requireSession(cfg), async (c) =>
        c.json(await resettableAccounts(cfg, c.get('session')))
      )
      // For someone who lost both the device and the recovery codes. No code is asked for: the authority is the
      // database's own — an account that could change this one's password could take its sign-in over anyway.
      .post(
        '/second-factor/accounts/reset',
        requireSession(cfg),
        validate('json', ResetSecondFactorRequestSchema),
        async (c) => {
          if (!store) return unsupported(c)
          const session = c.get('session')
          const { user } = c.req.valid('json')
          // Its own goes through the security tab, which asks for proof: a stolen session must not skip that.
          if (user === session.config.user) {
            return c.json(apiError('FORBIDDEN', 'Remove your own second factor from the security tab'), 403)
          }
          if (!(await session.adapter.canManageAccount(user))) {
            return c.json(apiError('FORBIDDEN', 'This account cannot manage that one'), 403)
          }
          const target = { ...session.config, user }
          if (!(await store.get(target))) {
            return c.json(apiError('NOT_FOUND', 'Nothing is enrolled for that account'), 404)
          }
          await store.clear(target)
          deps.logger.log('warn', 'second_factor.reset', {
            requestId: c.get('requestId'),
            ...sessionInfo(session),
            target: user,
          })
          return c.json(await resettableAccounts(cfg, session))
        }
      )
  )
}

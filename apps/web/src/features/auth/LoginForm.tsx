import { useMutation } from '@tanstack/react-query'
import type { Dialect, LoginRequest, PasskeyChallenge, ServerPreset } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { isApiError } from '@/lib/api.ts'
import { answerChallenge, passkeysSupported } from '@/lib/passkeys.ts'
import { readPreference, writePreference } from '@/lib/preferences.ts'

const DEFAULT_PORTS: Record<Dialect, number> = { mysql: 3306, postgres: 5432 }
const MANUAL = ''
/** Collations offered for the connection (MySQL / MariaDB); the default is utf8mb4_unicode_ci. */
const CONNECTION_COLLATIONS = [
  'utf8mb4_general_ci',
  'utf8mb4_0900_ai_ci',
  'utf8mb4_bin',
  'utf8mb3_general_ci',
  'latin1_swedish_ci',
  'cp932_japanese_ci',
  'ujis_japanese_ci',
]

/** Last successful connection (no password): a session that expired should not cost the whole form again. */
const LastLoginSchema = z.object({
  preset: z.string(),
  dialect: z.enum(['mysql', 'postgres']),
  host: z.string(),
  port: z.number(),
  user: z.string(),
  database: z.string(),
  collation: z.string().optional(),
})
const LAST_LOGIN_KEY = 'login.last'

export interface LoginFormProps {
  onLogin: (body: LoginRequest) => Promise<unknown>
  /** Operator-defined presets (TSMYADMIN_SERVERS); when present the first one is selected. */
  presets?: ServerPreset[]
}

export function LoginForm({ onLogin, presets = [] }: LoginFormProps) {
  const [last] = useState(() => readPreference(LAST_LOGIN_KEY, LastLoginSchema.nullable(), null))
  // The remembered preset must still exist; otherwise fall back to the operator's first one.
  const rememberedPreset = last && presets.some((p) => p.name === last.preset) ? last.preset : null
  const first = rememberedPreset ? presets.find((p) => p.name === rememberedPreset) : presets[0]
  const manualLast = last && last.preset === MANUAL ? last : null
  const [preset, setPreset] = useState<string>(manualLast ? MANUAL : first ? first.name : MANUAL)
  const [dialect, setDialect] = useState<Dialect>(manualLast?.dialect ?? first?.dialect ?? 'mysql')
  const [host, setHost] = useState(manualLast?.host ?? first?.host ?? '127.0.0.1')
  const [port, setPort] = useState(String(manualLast?.port ?? first?.port ?? DEFAULT_PORTS.mysql))
  const [user, setUser] = useState(last?.user ?? '')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  /** Shown once the server says this account has a second factor; the rest of the form keeps what was typed. */
  const [codeNeeded, setCodeNeeded] = useState(false)
  /** The passkey challenge that answer carried, when the account has passkeys; answered once. */
  const [challenge, setChallenge] = useState<PasskeyChallenge | null>(null)
  const [passkeyError, setPasskeyError] = useState<unknown>(null)
  const [collation, setCollation] = useState(last?.collation ?? '')
  const [database, setDatabase] = useState(
    manualLast?.database ?? (first ? (first.database ?? '') : (last?.database ?? ''))
  )
  const login = useMutation({
    mutationFn: async (body: LoginRequest) => {
      const result = await onLogin(body)
      writePreference(LAST_LOGIN_KEY, {
        preset,
        dialect: body.dialect,
        host: body.host,
        port: body.port,
        user: body.user,
        database: body.database ?? '',
        ...(body.collation ? { collation: body.collation } : {}),
      })
      return result
    },
    onError: (error) => {
      // Not an error to read as a failure: the account has a second factor and the form has to ask for it.
      if (isApiError(error, 'SECOND_FACTOR_REQUIRED')) {
        setCodeNeeded(true)
        setChallenge(error.passkey ?? null)
      }
      // A refused attempt may have spent the challenge: the next plain attempt hands out a fresh one.
      if (isApiError(error, 'SECOND_FACTOR_INVALID')) {
        setCode('')
        setChallenge(null)
      }
    },
  })
  const fixed = preset !== MANUAL

  const choosePreset = (name: string) => {
    setPreset(name)
    const p = presets.find((x) => x.name === name)
    if (!p) return
    setDialect(p.dialect)
    setHost(p.host)
    setPort(String(p.port))
    setDatabase(p.database ?? '')
  }

  const changeDialect = (next: Dialect) => {
    if (port === String(DEFAULT_PORTS[dialect])) setPort(String(DEFAULT_PORTS[next]))
    setDialect(next)
  }

  const credentials = (): LoginRequest => ({
    dialect,
    host,
    port: Number(port),
    user,
    password,
    ...(database ? { database } : {}),
    ...(dialect === 'mysql' && collation ? { collation } : {}),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setPasskeyError(null)
    login.mutate({ ...credentials(), ...(code.trim() ? { code: code.trim() } : {}) })
  }
  const withPasskey = async () => {
    if (!challenge) return
    setPasskeyError(null)
    try {
      const passkey = await answerChallenge(challenge)
      login.mutate({ ...credentials(), passkey })
    } catch (err) {
      setPasskeyError(err)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-busy={login.isPending}>
      {presets.length > 0 ? (
        <Field id="preset" label={locale.login.preset} {...(fixed ? { hint: locale.login.presetHint } : {})}>
          <Select
            id="preset"
            value={preset}
            onChange={(e) => choosePreset(e.target.value)}
            {...(fixed ? { 'aria-describedby': 'preset-hint' } : {})}
          >
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {/* The dialect is visible in the field below; keeping the label short avoids truncated options. */}
                {p.name} — {p.host}:{p.port}
                {p.database ? ` / ${p.database}` : ''}
              </option>
            ))}
            <option value={MANUAL}>{locale.login.presetManual}</option>
          </Select>
        </Field>
      ) : null}
      <Field id="dialect" label={locale.login.dialect}>
        <Select
          id="dialect"
          value={dialect}
          onChange={(e) => changeDialect(e.target.value as Dialect)}
          disabled={fixed}
        >
          <option value="mysql">{locale.login.mysql}</option>
          <option value="postgres">{locale.login.postgres}</option>
        </Select>
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-2">
          <Field id="host" label={locale.login.host}>
            <Input
              id="host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              required
              autoComplete="off"
              readOnly={fixed}
            />
          </Field>
        </div>
        <Field id="port" label={locale.login.port}>
          <Input
            id="port"
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            required
            readOnly={fixed}
          />
        </Field>
      </div>
      <Field id="user" label={locale.login.user}>
        <Input
          id="user"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          required
          autoComplete="username"
          autoFocus={!last?.user}
        />
      </Field>
      <Field id="password" label={locale.login.password}>
        <Input
          id="password"
          type="password"
          autoFocus={Boolean(last?.user)}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </Field>
      <Field
        id="database"
        label={locale.login.database}
        {...(dialect === 'postgres' ? { hint: locale.login.databaseHint } : {})}
      >
        <Input
          id="database"
          value={database}
          onChange={(e) => setDatabase(e.target.value)}
          {...(dialect === 'postgres' ? { 'aria-describedby': 'database-hint' } : {})}
          // A MySQL account without access to the preset's database can still log in without one.
          readOnly={fixed && dialect === 'postgres'}
        />
      </Field>
      {dialect === 'mysql' ? (
        <Field id="collation" label={locale.login.collation} hint={locale.login.collationHint}>
          <Select id="collation" value={collation} onChange={(e) => setCollation(e.target.value)}>
            <option value="">{locale.login.collationDefault}</option>
            {CONNECTION_COLLATIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {codeNeeded ? (
        <Field id="code" label={locale.login.code} hint={locale.login.codeHint}>
          <Input
            id="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            // Lets a phone or password manager fill the code, and puts digits under a touch keyboard.
            autoComplete="one-time-code"
            inputMode="numeric"
            autoFocus
            aria-describedby="code-hint"
          />
        </Field>
      ) : null}
      {codeNeeded && challenge && passkeysSupported() ? (
        <Button onClick={() => void withPasskey()} disabled={login.isPending} className="w-full justify-center">
          {locale.login.usePasskey}
        </Button>
      ) : null}
      {passkeyError ? <ErrorBox error={passkeyError} /> : null}
      {/* A code is asked for, not failed: the form says so rather than showing it as an error. */}
      {login.isError && !isApiError(login.error, 'SECOND_FACTOR_REQUIRED') ? <ErrorBox error={login.error} /> : null}
      <Button type="submit" variant="primary" disabled={login.isPending} className="w-full justify-center">
        {login.isPending ? locale.login.connecting : locale.login.submit}
      </Button>
    </form>
  )
}

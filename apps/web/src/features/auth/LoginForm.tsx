import { useMutation } from '@tanstack/react-query'
import type { ConnectRequest, Dialect, ServerPreset } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

const DEFAULT_PORTS: Record<Dialect, number> = { mysql: 3306, postgres: 5432 }
const MANUAL = ''

export interface LoginFormProps {
  onLogin: (body: ConnectRequest) => Promise<unknown>
  /** Operator-defined presets (TSMYADMIN_SERVERS); when present the first one is selected. */
  presets?: ServerPreset[]
}

export function LoginForm({ onLogin, presets = [] }: LoginFormProps) {
  const first = presets[0]
  const [preset, setPreset] = useState<string>(first ? first.name : MANUAL)
  const [dialect, setDialect] = useState<Dialect>(first?.dialect ?? 'mysql')
  const [host, setHost] = useState(first?.host ?? '127.0.0.1')
  const [port, setPort] = useState(String(first?.port ?? DEFAULT_PORTS.mysql))
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [database, setDatabase] = useState(first?.database ?? '')
  const login = useMutation({ mutationFn: (body: ConnectRequest) => onLogin(body) })
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

  const submit = (e: FormEvent) => {
    e.preventDefault()
    login.mutate({ dialect, host, port: Number(port), user, password, ...(database ? { database } : {}) })
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-busy={login.isPending}>
      {presets.length > 0 ? (
        <Field id="preset" label={locale.login.preset} {...(fixed ? { hint: locale.login.presetHint } : {})}>
          <Select id="preset" value={preset} onChange={(e) => choosePreset(e.target.value)}>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} — {p.dialect === 'mysql' ? locale.login.mysql : locale.login.postgres} {p.host}:{p.port}
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
        <Input id="user" value={user} onChange={(e) => setUser(e.target.value)} required autoComplete="username" />
      </Field>
      <Field id="password" label={locale.login.password}>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </Field>
      <Field id="database" label={locale.login.database} hint={locale.login.databaseHint}>
        <Input
          id="database"
          value={database}
          onChange={(e) => setDatabase(e.target.value)}
          aria-describedby="database-hint"
          readOnly={fixed}
        />
      </Field>
      {login.isError ? <ErrorBox error={login.error} /> : null}
      <Button type="submit" variant="primary" disabled={login.isPending} className="w-full justify-center">
        {login.isPending ? locale.login.connecting : locale.login.submit}
      </Button>
    </form>
  )
}

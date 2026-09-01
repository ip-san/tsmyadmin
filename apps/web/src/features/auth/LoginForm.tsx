import { useMutation } from '@tanstack/react-query'
import type { ConnectRequest, Dialect } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

const DEFAULT_PORTS: Record<Dialect, number> = { mysql: 3306, postgres: 5432 }

export function LoginForm({ onLogin }: { onLogin: (body: ConnectRequest) => Promise<unknown> }) {
  const [dialect, setDialect] = useState<Dialect>('mysql')
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState(String(DEFAULT_PORTS.mysql))
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [database, setDatabase] = useState('')
  const login = useMutation({ mutationFn: (body: ConnectRequest) => onLogin(body) })

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
      <Field id="dialect" label={locale.login.dialect}>
        <Select id="dialect" value={dialect} onChange={(e) => changeDialect(e.target.value as Dialect)}>
          <option value="mysql">{locale.login.mysql}</option>
          <option value="postgres">{locale.login.postgres}</option>
        </Select>
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-2">
          <Field id="host" label={locale.login.host}>
            <Input id="host" value={host} onChange={(e) => setHost(e.target.value)} required autoComplete="off" />
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
        />
      </Field>
      {login.isError ? <ErrorBox error={login.error} /> : null}
      <Button type="submit" variant="primary" disabled={login.isPending} className="w-full justify-center">
        {login.isPending ? locale.login.connecting : locale.login.submit}
      </Button>
    </form>
  )
}

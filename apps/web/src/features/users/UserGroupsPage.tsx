import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Dialect, GroupTabLevel, UserGroup } from '@tsmyadmin/shared'
import { GROUP_TABS } from '@tsmyadmin/shared'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { mutations, userGroupsQuery, usersQuery } from '@/lib/queries.ts'

const t = locale.userGroups
const LEVELS = Object.keys(GROUP_TABS) as GroupTabLevel[]

/** A hideable tab's label, as the tab bar shows it. */
function groupTabLabel(id: string, dialect: Dialect): string {
  const tab = id.slice(id.indexOf(':') + 1)
  if (tab === 'replication') return locale.replication.title
  if (tab === 'collations' || tab === 'engines' || tab === 'plugins') return locale.catalog.titles[tab][dialect]
  return (locale.tabs as Record<string, string>)[tab] ?? tab
}

function GroupForm({
  initial,
  accounts,
  dialect,
  onSave,
  pending,
}: {
  initial: UserGroup | null
  accounts: string[]
  dialect: Dialect
  onSave: (group: { name: string; members: string[]; hiddenTabs: string[] }) => void
  pending: boolean
}) {
  const id = useId()
  const [name, setName] = useState(initial?.name ?? '')
  const [members, setMembers] = useState<string[]>(initial?.members ?? [])
  const [hidden, setHidden] = useState<string[]>(initial?.hiddenTabs ?? [])
  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...list, value] : list.filter((v) => v !== value)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() && members.length > 0) onSave({ name: name.trim(), members, hiddenTabs: hidden })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field id={`${id}-name`} label={t.name}>
        <Input
          id={`${id}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          readOnly={initial !== null}
          className="w-64"
        />
      </Field>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
        <legend className="mb-1 text-xs font-medium text-ink-sub">{t.members}</legend>
        {accounts.map((a) => (
          <label key={a} className="flex items-center gap-1 text-sm text-ink">
            <input
              type="checkbox"
              checked={members.includes(a)}
              onChange={(e) => setMembers((m) => toggle(m, a, e.target.checked))}
            />
            <span className="font-mono">{a}</span>
          </label>
        ))}
      </fieldset>
      {LEVELS.map((level) => (
        <fieldset key={level} className="flex flex-wrap gap-x-4 gap-y-1">
          <legend className="mb-1 text-xs font-medium text-ink-sub">{t.hide[level]}</legend>
          {GROUP_TABS[level].map((tab) => {
            const tabId = `${level}:${tab}`
            return (
              <label key={tabId} className="flex items-center gap-1 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={hidden.includes(tabId)}
                  onChange={(e) => setHidden((h) => toggle(h, tabId, e.target.checked))}
                />
                {groupTabLabel(tabId, dialect)}
              </label>
            )
          })}
        </fieldset>
      ))}
      <Button type="submit" variant="primary" disabled={pending || members.length === 0 || !name.trim()}>
        {t.save}
      </Button>
    </form>
  )
}

/**
 * phpMyAdmin's user groups: which tabs a set of accounts does not see. Changing a group takes an account that can
 * manage every member (the server answers FORBIDDEN otherwise). This is a tidier menu, not a permission: what a
 * hidden tab does is still allowed by the account's own privileges, and the page says so.
 */
export function UserGroupsPage({ dialect }: { dialect: Dialect }) {
  const queryClient = useQueryClient()
  const list = useQuery(userGroupsQuery)
  const users = useQuery(usersQuery)
  const [editing, setEditing] = useState<UserGroup | null>(null)
  const settle = (groups: UserGroup[]) => {
    queryClient.setQueryData(userGroupsQuery.queryKey, groups)
    // The signed-in account may be a member of what just changed.
    void queryClient.invalidateQueries({ queryKey: ['user-groups', 'mine'] })
    setEditing(null)
  }
  const save = useMutation({ mutationFn: mutations.saveUserGroup, onSuccess: settle })
  const remove = useMutation({ mutationFn: mutations.deleteUserGroup, onSuccess: settle })
  if (list.isPending) return <Spinner />
  if (list.isError) return <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
  const accounts = [...new Set((users.data ?? []).map((u) => u.name))].sort()
  return (
    <div className="space-y-4">
      <Notice>{t.notice}</Notice>
      {save.isError ? <ErrorBox error={save.error} /> : null}
      {remove.isError ? <ErrorBox error={remove.error} /> : null}
      <Card title={t.title} bleed>
        {list.data.length === 0 ? (
          <p className="px-4 pb-3 text-sm text-ink-sub">{t.empty}</p>
        ) : (
          <Table aria-label={t.title}>
            <thead>
              <tr>
                <Th>{t.name}</Th>
                <Th>{t.members}</Th>
                <Th>{t.hidden}</Th>
                <Th>
                  <span className="sr-only">{locale.ddl.actions}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((g) => (
                <Tr key={g.id}>
                  <Td className="font-medium">{g.name}</Td>
                  <Td className="font-mono text-xs">{g.members.join(', ')}</Td>
                  <Td className="text-xs">{g.hiddenTabs.map((x) => groupTabLabel(x, dialect)).join(', ')}</Td>
                  <Td className="whitespace-nowrap">
                    <Button size="sm" onClick={() => setEditing(g)} aria-label={t.edit(g.name)}>
                      {t.editShort}
                    </Button>{' '}
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => remove.mutate(g.id)}
                      aria-label={t.remove(g.name)}
                    >
                      {locale.common.delete}
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card title={editing ? t.edit(editing.name) : t.create}>
        <GroupForm
          key={editing?.id ?? 'new'}
          initial={editing}
          accounts={accounts}
          dialect={dialect}
          pending={save.isPending}
          onSave={(g) => save.mutate(g)}
        />
      </Card>
    </div>
  )
}

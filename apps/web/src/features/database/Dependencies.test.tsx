import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DependencyReport, TriggerInfo } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { dependencyId } from '@/lib/dependencies.ts'
import { Dependencies } from './Dependencies.tsx'

const t = locale.dependencies
let report: DependencyReport
let triggers: TriggerInfo[]

vi.mock('@/lib/queries.ts', () => ({
  dependenciesQuery: () => ({ queryKey: ['dependencies'], queryFn: async () => report }),
  triggersQuery: () => ({ queryKey: ['triggers'], queryFn: async () => triggers }),
}))

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Dependencies db="shop" />
    </QueryClientProvider>
  )

const view = (name: string, on: string, kind: 'table' | 'view' = 'table') => ({
  kind: 'view' as const,
  name,
  dependsOn: [{ kind, name: on }],
})

describe('Dependencies', () => {
  it('draws who uses what, in words too, and lights what a change to the chosen table reaches', async () => {
    report = { status: 'ok', objects: [view('active', 'users'), view('recent', 'active', 'view')] }
    triggers = [{ name: 'audit', table: 'users' } as TriggerInfo]
    mount()
    expect(await screen.findByRole('img', { name: t.diagram })).toBeInTheDocument()
    const words = screen.getByRole('list', { name: t.sentences })
    expect(words).toHaveTextContent(t.reads(t.named(t.kinds.view, 'recent'), t.named(t.kinds.view, 'active')))
    expect(words).toHaveTextContent(t.fires(t.named(t.kinds.trigger, 'audit'), t.named(t.kinds.table, 'users')))
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    await userEvent.selectOptions(screen.getByLabelText(t.change), dependencyId('table', 'users'))
    expect(screen.getByRole('status')).toHaveTextContent(
      t.reaches('users', [
        t.named(t.kinds.view, 'active'),
        t.named(t.kinds.trigger, 'audit'),
        t.named(t.kinds.view, 'recent'),
      ])
    )
  })

  it('says when the server keeps no catalog, and still draws the triggers', async () => {
    report = { status: 'unsupported', objects: [] }
    triggers = [{ name: 'audit', table: 'users' } as TriggerInfo]
    mount()
    expect(await screen.findByText(t.unsupported)).toBeInTheDocument()
    expect(screen.getByRole('list', { name: t.sentences })).toHaveTextContent('audit')
  })

  it('says there is nothing to draw', async () => {
    report = { status: 'ok', objects: [] }
    triggers = []
    mount()
    expect(await screen.findByText(t.none)).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: t.diagram })).toBeNull()
  })
})

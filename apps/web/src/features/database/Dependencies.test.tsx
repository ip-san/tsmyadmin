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
let triggersFail = false

vi.mock('@/lib/queries.ts', () => ({
  dependenciesQuery: () => ({ queryKey: ['dependencies'], queryFn: async () => report }),
  triggersQuery: () => ({
    queryKey: ['triggers'],
    queryFn: async () => {
      if (triggersFail) throw new Error('no trigger list')
      return triggers
    },
  }),
}))

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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
    expect(words).toHaveTextContent(t.fires(t.triggerNamed('audit', 'users'), t.named(t.kinds.table, 'users')))
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    await userEvent.selectOptions(screen.getByLabelText(t.change), dependencyId('table', 'users'))
    const users = t.named(t.kinds.table, 'users')
    expect(screen.getByRole('status')).toHaveTextContent(
      t.reaches(users, [
        t.named(t.kinds.view, 'active'),
        t.triggerNamed('audit', 'users'),
        t.named(t.kinds.view, 'recent'),
      ])
    )
  })

  it('can change a view too, and draw only what the change reaches', async () => {
    report = {
      status: 'ok',
      objects: [view('active', 'users'), view('recent', 'active', 'view'), view('other', 'posts')],
    }
    triggers = []
    mount()
    await screen.findByRole('img', { name: t.diagram })
    await userEvent.selectOptions(screen.getByLabelText(t.change), dependencyId('view', 'active'))
    expect(screen.getByRole('status')).toHaveTextContent(
      t.reaches(t.named(t.kinds.view, 'active'), [t.named(t.kinds.view, 'recent')])
    )
    const words = screen.getByRole('list', { name: t.sentences })
    expect(words).toHaveTextContent('other')
    await userEvent.click(screen.getByRole('checkbox', { name: t.onlyReached }))
    // Only the view chosen and what reaches it: the line about other (on posts) is gone, from words and picture.
    expect(words).not.toHaveTextContent('other')
    expect(words).toHaveTextContent(t.reads(t.named(t.kinds.view, 'recent'), t.named(t.kinds.view, 'active')))
    expect(screen.getByRole('img', { name: t.diagram }).textContent).not.toContain('other')
  })

  it('draws what views use when the triggers cannot be listed, and says why they are missing', async () => {
    report = { status: 'ok', objects: [view('active', 'users')] }
    triggersFail = true
    try {
      mount()
      expect(await screen.findByText(/no trigger list/)).toBeInTheDocument()
      expect(screen.getByRole('list', { name: t.sentences })).toHaveTextContent('active')
    } finally {
      triggersFail = false
    }
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

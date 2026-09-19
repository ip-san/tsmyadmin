import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ServerTabs } from './ServerTabs.tsx'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))

vi.mock('@/lib/queries.ts', () => ({
  sessionQuery: { queryKey: ['session'], queryFn: async () => null, staleTime: Number.POSITIVE_INFINITY },
  myGroupTabsQuery: {
    queryKey: ['user-groups', 'mine'],
    queryFn: async () => null,
    staleTime: Number.POSITIVE_INFINITY,
  },
}))

function renderTabs(secondFactor: string, hiddenTabs: string[] = []) {
  const client = new QueryClient()
  client.setQueryData(['session'], { secondFactor })
  client.setQueryData(['user-groups', 'mine'], { hiddenTabs })
  return render(
    <QueryClientProvider client={client}>
      <ServerTabs tab="ユーザー" />
    </QueryClientProvider>
  )
}

describe('ServerTabs', () => {
  it('offers the security tab only where a second factor can be kept', () => {
    // Without a persistent session store there is nowhere to put the secret, and enrolling would fail: the tab
    // is left out rather than leading to an error.
    const { unmount } = renderTabs('unsupported')
    expect(screen.getByRole('link', { name: 'ユーザー' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'セキュリティ' })).not.toBeInTheDocument()
    unmount()

    renderTabs('none')
    expect(screen.getByRole('link', { name: 'セキュリティ' })).toHaveAttribute('href', '/security')
  })

  it('leaves out the tabs the account’s user groups hide, and never the first one', () => {
    renderTabs('none', ['server:sql', 'server:processes'])
    expect(screen.queryByRole('link', { name: 'SQL' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'プロセス' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'ステータス' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'データベース' })).toBeInTheDocument()
  })
})

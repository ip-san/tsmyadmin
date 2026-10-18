import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { overviewLinkFor } from './DesignerKeys.tsx'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/overview">{children}</a>,
}))

describe('overviewLinkFor', () => {
  it('links a table of the database to its overview, and nothing for one drawn from a snapshot', () => {
    const link = overviewLinkFor('shop', undefined, ['users'])
    render(<div>{link('users')}</div>)
    expect(screen.getByRole('link', { name: locale.designer.openOverview })).toBeInTheDocument()
    expect(link('gone')).toBeNull()
  })
})

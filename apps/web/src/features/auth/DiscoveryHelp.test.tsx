import { render, screen } from '@testing-library/react'
import type { DiscoveryDiagnosis } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { DiscoveryHelp } from './DiscoveryHelp.tsx'

const base: DiscoveryDiagnosis = { enabled: true, connectHost: '127.0.0.1', unavailable: null, found: 1, issues: [] }

describe('DiscoveryHelp', () => {
  it('says nothing when discovery is off, unknown, or everything is listed and reachable', () => {
    const { container, rerender } = render(<DiscoveryHelp diagnosis={undefined} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<DiscoveryHelp diagnosis={{ ...base, enabled: false, found: 0 }} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<DiscoveryHelp diagnosis={base} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says why Docker cannot be read, or that no database container runs', () => {
    const { rerender } = render(
      <DiscoveryHelp
        diagnosis={{ ...base, found: 0, unavailable: 'Cannot open the Docker socket /var/run/docker.sock' }}
      />
    )
    expect(screen.getByText('Cannot open the Docker socket /var/run/docker.sock')).toBeInTheDocument()
    rerender(<DiscoveryHelp diagnosis={{ ...base, found: 0 }} />)
    expect(
      screen.getByText(/起動している MySQL \/ MariaDB \/ PostgreSQL のコンテナが見つかりません/)
    ).toBeInTheDocument()
  })

  it('is open when the way in is broken, and folded away when it only names stopped containers', () => {
    const stopped = { name: 'docker: old/db', dialect: 'mysql' as const, reason: 'stopped' as const, port: null }
    const { container, rerender } = render(<DiscoveryHelp diagnosis={{ ...base, issues: [stopped] }} />)
    expect(container.querySelector('details')).not.toHaveAttribute('open')
    // Nothing listed: the stopped ones are then what they came for.
    rerender(<DiscoveryHelp diagnosis={{ ...base, found: 0, issues: [stopped] }} />)
    expect(container.querySelector('details')).toHaveAttribute('open')
    rerender(
      <DiscoveryHelp
        diagnosis={{ ...base, issues: [{ ...stopped, name: 'docker: a/b', reason: 'unreachable', port: 3306 }] }}
      />
    )
    expect(container.querySelector('details')).toHaveAttribute('open')
    rerender(<DiscoveryHelp diagnosis={{ ...base, found: 0 }} />)
    expect(container.querySelector('details')).toHaveAttribute('open')
  })

  it('gives the line to fix for each container it left out or cannot reach', () => {
    render(
      <DiscoveryHelp
        diagnosis={{
          ...base,
          connectHost: 'host.docker.internal',
          issues: [
            { name: 'docker: shop/pg', dialect: 'postgres', reason: 'notPublished', port: 5432 },
            { name: 'docker: old/db', dialect: 'mysql', reason: 'stopped', port: null },
            { name: 'docker: api/mysql', dialect: 'mysql', reason: 'unreachable', port: 3306 },
          ],
        }}
      />
    )
    expect(screen.getByText('docker: shop/pg')).toBeInTheDocument()
    // The port to publish, as the compose lines to paste.
    expect(screen.getByText(/127\.0\.0\.1:5432:5432/)).toBeInTheDocument()
    expect(screen.getByText(/停止しています/)).toBeInTheDocument()
    expect(screen.getByText(/host\.docker\.internal:3306 に届きません/)).toBeInTheDocument()
  })
})

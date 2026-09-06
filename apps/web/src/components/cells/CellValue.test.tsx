import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { CellValue } from './CellValue.tsx'

describe('CellValue', () => {
  it('folds long text behind a toggle', async () => {
    render(<CellValue cell={'a'.repeat(300)} />)
    expect(screen.getByRole('button', { name: /300/ })).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(screen.getByRole('button'))
    expect(screen.getByText('a'.repeat(300))).toBeInTheDocument()
  })

  it('marks server-truncated text with its full length in both states', async () => {
    render(<CellValue cell={{ $text: 'head', length: 70000 }} />)
    expect(screen.getByText(/全 70,000 文字/)).toBeInTheDocument()
    expect(screen.getByText(/^head…/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/全 70,000 文字/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '折りたたむ' })).toBeInTheDocument()
  })
})

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DELETE_IMPACT_MAX_KEYS, type RowKey } from '@tsmyadmin/shared'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { DeleteRowsDialog } from './DeleteRowsDialog.tsx'

vi.mock('./DeleteImpactPanel.tsx', () => ({ DeleteImpactPanel: () => <p>impact panel</p> }))

const t = locale.deleteImpact
const keys = (n: number): RowKey[] => Array.from({ length: n }, (_, i) => ({ kind: 'pk', values: { id: i + 1 } }))
const props = (n: number, open = true) => ({
  open,
  tableRef: { db: 'shop', table: 'users' },
  keys: keys(n),
  pending: false,
  error: null,
  onCancel: vi.fn(),
  onConfirm: vi.fn(),
})

describe('DeleteRowsDialog', () => {
  // jsdom has <dialog> but not its modal methods.
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true
    }
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false
    }
  })

  it('does not offer the impact for more rows than it counts, and says why', () => {
    render(<DeleteRowsDialog {...props(DELETE_IMPACT_MAX_KEYS + 1)} />)
    expect(screen.getByRole('button', { name: t.show })).toBeDisabled()
    expect(screen.getByText(t.tooMany(DELETE_IMPACT_MAX_KEYS))).toBeInTheDocument()
  })

  it('offers it up to the limit', () => {
    render(<DeleteRowsDialog {...props(DELETE_IMPACT_MAX_KEYS)} />)
    expect(screen.getByRole('button', { name: t.show })).toBeEnabled()
  })

  it('opens the next rows with the impact closed, however the dialog was closed', async () => {
    const { rerender } = render(<DeleteRowsDialog {...props(1)} />)
    await userEvent.click(screen.getByRole('button', { name: t.show }))
    expect(await screen.findByText('impact panel')).toBeInTheDocument()
    // A delete that went through closes the dialog from outside, not through Cancel.
    rerender(<DeleteRowsDialog {...props(1, false)} />)
    rerender(<DeleteRowsDialog {...props(2)} />)
    expect(screen.getByRole('button', { name: t.show })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('impact panel')).toBeNull()
  })
})

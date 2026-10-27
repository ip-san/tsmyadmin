import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PlanNode } from '@tsmyadmin/shared'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { PlanTour } from './PlanTour.tsx'

const t = locale.planTour
const read = (table: string): PlanNode => ({
  op: 'Seq Scan',
  table,
  alias: null,
  index: null,
  indexColumns: [],
  access: 'fullScan',
  covering: false,
  estRows: 3,
  cost: null,
  detail: null,
  children: [],
})

beforeAll(() => {
  // jsdom has <dialog> but not its modal methods.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
})
afterEach(cleanup)

describe('PlanTour', () => {
  it('opens the plan as a presentation, from its opening to its summary, and closes it', () => {
    render(<PlanTour plan={read('users')} relations={[]} indexColumns={() => []} />)
    fireEvent.click(screen.getByRole('button', { name: t.open }))
    const dialog = screen.getByRole('dialog', { name: t.dialog })
    expect(screen.getByRole('heading', { level: 3, name: t.introTitle })).toBeTruthy()
    fireEvent.keyDown(dialog, { key: 'End' })
    expect(screen.getByRole('heading', { level: 3, name: t.endTitle })).toBeTruthy()
    // What it says beyond its words is a reading of the plan, not of the design.
    expect(screen.getByText(t.notesTitle)).toBeTruthy()
    expect(screen.queryByText(locale.tour.notes)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: locale.tour.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { DiagramLegend, StepNarration } from './StepNarration.tsx'
import type { useStepPlayer } from './use-step-player.ts'

const t = locale.schemaDiagram
const player = (index: number): ReturnType<typeof useStepPlayer> => ({
  index,
  playing: false,
  play: vi.fn(),
  pause: vi.fn(),
  first: vi.fn(),
  prev: vi.fn(),
  next: vi.fn(),
  last: vi.fn(),
  goTo: vi.fn(),
})
const steps = [{ text: 'one' }, { text: 'two' }, { text: 'three' }]

describe('StepNarration', () => {
  it('marks the current step and reads it out', () => {
    render(<StepNarration steps={steps} player={player(1)} />)
    expect(screen.getByRole('button', { name: '2. two' })).toHaveAttribute('aria-current', 'step')
    expect(screen.getByRole('button', { name: '1. one' })).not.toHaveAttribute('aria-current')
    expect(screen.getByText('two', { selector: '[aria-live]' })).toBeInTheDocument()
  })

  it('jumps to a step that is picked', async () => {
    const p = player(0)
    render(<StepNarration steps={steps} player={p} />)
    await userEvent.click(screen.getByRole('button', { name: '3. three' }))
    expect(p.goTo).toHaveBeenCalledWith(2)
  })

  it('cannot go back from the first step or on from the last', () => {
    const { rerender } = render(<StepNarration steps={steps} player={player(0)} />)
    expect(screen.getByRole('button', { name: t.prev })).toBeDisabled()
    expect(screen.getByRole('button', { name: t.next })).toBeEnabled()
    rerender(<StepNarration steps={steps} player={player(2)} />)
    expect(screen.getByRole('button', { name: t.next })).toBeDisabled()
  })
})

describe('DiagramLegend', () => {
  it('names every tone asked for', () => {
    render(<DiagramLegend tones={['delete', 'blocked']} />)
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([t.tones.delete, t.tones.blocked])
  })

  it('says what a tone means on this diagram, where it is given', () => {
    render(<DiagramLegend tones={['focus', 'blocked']} labels={{ blocked: 'Deadlock' }} />)
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([t.tones.focus, 'Deadlock'])
  })
})

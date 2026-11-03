import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { StatementResult } from '@tsmyadmin/shared'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { type PreviewFlowConfig, STOP_ANSWER_MS, usePreviewFlow } from '@/lib/preview-flow.ts'
import { memoryStorage } from '@/test/memory-storage.ts'
import { PreviewDialog } from './PreviewDialog.tsx'

const d = locale.ddl
const ok = (statement: number): StatementResult => ({
  kind: 'affected',
  statement,
  sql: `ALTER ${statement}`,
  affectedRows: 0,
  durationMs: 1,
})
/** A result that cannot be matched to its statement: what ran is not known from it. */
const unplaced = (statement: number): StatementResult => {
  const { statement: _, ...r } = ok(statement)
  return r
}
const failed: StatementResult = { kind: 'error', statement: 1, sql: 'ALTER 1', message: 'canceling statement' }

/** The run's answer, given when the test says so. */
let finish: (r: { results: StatementResult[] }) => void
let fail: (err: unknown) => void
const execute = vi.fn(
  (_op: string, _sql: string[], _queryId: string) =>
    new Promise<{ results: StatementResult[] }>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
)
let stopAnswer: () => Promise<boolean>
const stop = vi.fn((_queryId: string) => stopAnswer())
const onSuccess = vi.fn()
/** What the server builds when asked again (null: the SQL the harness was given). */
let rebuilt: string[] | null
/** The server's answer to a preview waits for this, where set. */
let previewGate: Promise<void> | null
const previewed = vi.fn()

function Harness({ stoppable = true, sql = ['ALTER 0', 'ALTER 1'] }: { stoppable?: boolean; sql?: string[] }) {
  const config: PreviewFlowConfig<string> = {
    preview: async () => {
      previewed()
      if (previewGate) await previewGate
      return { sql: rebuilt ?? sql }
    },
    execute,
    onSuccess,
    ...(stoppable ? { stop } : {}),
  }
  const flow = usePreviewFlow(config)
  return (
    <>
      <button type="button" onClick={() => flow.preview('build')}>
        open
      </button>
      <PreviewDialog
        flow={flow}
        title={() => 'Build'}
        destructive={() => false}
        hint="hint"
        successMessage={() => 'built'}
      />
    </>
  )
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false
  }
})
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  execute.mockClear()
  stop.mockClear()
  onSuccess.mockClear()
  previewed.mockClear()
  rebuilt = null
  previewGate = null
  stopAnswer = async () => true
})
afterEach(cleanup)

/** Opens the preview and runs it: the run waits for the test. */
async function running(stoppable = true, sql?: string[]) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness stoppable={stoppable} {...(sql ? { sql } : {})} />
    </QueryClientProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'open' }))
  fireEvent.click(await screen.findByRole('button', { name: d.execute }))
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
}
const stopButton = () => screen.findByRole('button', { name: d.stop })
/** What the stop notice says after its first line, where these statements are still to run. */
const restOf = (rest: string[]) =>
  d.rerunAll + d.restIntro(rest.length) + rest.map((s) => `${s};`).join('\n') + d.runRest

describe('PreviewDialog, stopping a run', () => {
  it('leaves the focus where it is as a run starts, unless it fell to the page', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    const sql = await screen.findByLabelText('SQL')
    sql.focus()
    fireEvent.click(await screen.findByRole('button', { name: d.execute }))
    await stopButton()
    expect(document.activeElement).toBe(sql)
  })

  it('stops the run by its own id, once however often pressed, and says it is stopping', async () => {
    let answer: (v: boolean) => void = () => undefined
    stopAnswer = () => new Promise((resolve) => (answer = resolve))
    await running()
    const button = await stopButton()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith(execute.mock.calls[0]?.[2])
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText(d.stopping).getAttribute('role')).toBe('status')
    await act(async () => answer(true))
    await act(async () => finish({ results: [ok(0), failed] }))
    // Stopped, not failed: the server's error for the stopped statement is not shown as a failure.
    const said = await screen.findByRole('alert')
    expect(said.textContent).toBe(d.stopped + restOf(['ALTER 1']))
    expect(screen.queryByText(d.failedStatement, { exact: false })).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()
    // The stop button went with the run: the focus is on what happened.
    expect(screen.queryByRole('button', { name: d.stop })).toBeNull()
    expect(document.activeElement?.contains(said)).toBe(true)
  })

  it('is stopped where the stop came between two statements, though no statement failed', async () => {
    await running()
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0)] }))
    expect((await screen.findByRole('alert')).textContent).toBe(d.stopped + restOf(['ALTER 1']))
    // Not done: the follow-up (measuring an index tried, say) does not run.
    expect(onSuccess).not.toHaveBeenCalled()
    expect(screen.queryByText('built')).toBeNull()
  })

  it('warns that running it again replays it all only where something may have run twice', async () => {
    // One statement stopped: it was undone, so nothing ran; running it again is running it once.
    await running(true, ['ALTER 0'])
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [failed] }))
    expect((await screen.findByRole('alert')).textContent).toBe(d.stopped)
    cleanup()
    // Not known whether it ran to the end: even one statement may run twice.
    stopAnswer = async () => {
      throw new Error('network down')
    }
    execute.mockClear()
    await running(true, ['ALTER 0'])
    fireEvent.click(await stopButton())
    await screen.findByText('network down')
    await act(async () => finish({ results: [ok(0)] }))
    // The server's results say it ran to the end: done.
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith('build'))
    expect(screen.queryByText(d.stopUnclear)).toBeNull()
    cleanup()
    // Results that cannot be matched to the statements say nothing of what ran: running it again replays it all.
    execute.mockClear()
    await running(true, ['ALTER 0'])
    fireEvent.click(await stopButton())
    await screen.findByText('network down')
    await act(async () => finish({ results: [unplaced(0)] }))
    expect((await screen.findByText(d.stopUnclear)).textContent).toBe(d.stopUnclear + d.rerunUnclear)
  })

  it('says it was stopped where the results end part way, though the answer to the stop did not come', async () => {
    stopAnswer = async () => {
      throw new Error('network down')
    }
    await running()
    fireEvent.click(await stopButton())
    await screen.findByText('network down')
    await act(async () => finish({ results: [ok(0)] }))
    // The alert of the stop that did not get through stays beside it.
    const notice = (await screen.findAllByRole('alert')).find((a) => a.textContent?.startsWith(d.stopped))
    expect(notice?.textContent).toBe(d.stopped + restOf(['ALTER 1']))
  })

  it('is stopped where the request itself ended in an error after the stop', async () => {
    await running()
    fireEvent.click(await stopButton())
    await act(async () => fail(new Error('aborted')))
    // What ran is not known: running it again replays it all.
    expect((await screen.findByRole('alert')).textContent).toBe(d.stopped + d.rerunStopped)
    expect(screen.queryByRole('button', { name: d.runRest })).toBeNull()
    expect(screen.queryByText('aborted')).toBeNull()
  })

  it('is done where every statement ended, though the server said it stopped the run', async () => {
    await running()
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0), ok(1)] }))
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith('build'))
    expect(screen.queryByText(d.stopped)).toBeNull()
  })

  it('is done where the run had ended before the stop reached it', async () => {
    stopAnswer = async () => false
    await running()
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0), ok(1)] }))
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith('build'))
    expect(screen.queryByText(d.stopped)).toBeNull()
  })

  it('says why a stop did not reach the server, and lets it be asked again', async () => {
    stopAnswer = async () => {
      throw new Error('network down')
    }
    await running()
    fireEvent.click(await stopButton())
    expect(await screen.findByText('network down')).toBeTruthy()
    const button = await stopButton()
    await vi.waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull())
    stopAnswer = async () => true
    fireEvent.click(button)
    expect(stop).toHaveBeenCalledTimes(2)
    await act(async () => finish({ results: [ok(0)] }))
    expect((await screen.findByRole('alert')).textContent).toBe(d.stopped + restOf(['ALTER 1']))
  })

  it('offers no stop where the flow cannot stop, and none before the run', async () => {
    await running(false)
    expect(screen.queryByRole('button', { name: d.stop })).toBeNull()
    await act(async () => finish({ results: [ok(0), ok(1)] }))
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled())
  })

  it('starts a run anew: a stop before is not taken for this one', async () => {
    await running()
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0)] }))
    await screen.findByRole('alert')
    // Previewed and run again: done this time.
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    expect(screen.queryByText(d.stopped)).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: d.execute }))
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    expect(execute.mock.calls[1]?.[2]).not.toBe(execute.mock.calls[0]?.[2])
    await act(async () => finish({ results: [ok(0), ok(1)] }))
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
  })
  it('says it is not known where the answer to the stop did not come back and no statement failed', async () => {
    stopAnswer = async () => {
      throw new Error('network down')
    }
    await running()
    fireEvent.click(await stopButton())
    await screen.findByText('network down')
    await act(async () => finish({ results: [unplaced(0)] }))
    expect(await screen.findByText(d.stopUnclear)).toBeTruthy()
    expect(screen.queryByText(d.stopped)).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('waits for the answer to the stop: done once the server says it was not stopped', async () => {
    let answer: (v: boolean) => void = () => undefined
    stopAnswer = () => new Promise((resolve) => (answer = resolve))
    await running()
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0), ok(1)] }))
    expect(onSuccess).not.toHaveBeenCalled()
    await act(async () => answer(false))
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith('build'))
  })

  it('is done where the server said it was not stopped before the run answered', async () => {
    stopAnswer = async () => false
    await running()
    fireEvent.click(await stopButton())
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    await act(async () => undefined)
    await act(async () => finish({ results: [ok(0), ok(1)] }))
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith('build'))
    expect(screen.queryByText(d.stopUnclear)).toBeNull()
  })

  it('keeps it not known where a stop got no answer, though one asked after it says not stopped', async () => {
    stopAnswer = async () => {
      throw new Error('network down')
    }
    await running()
    fireEvent.click(await stopButton())
    await screen.findByText('network down')
    stopAnswer = async () => false
    const button = await stopButton()
    await vi.waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull())
    fireEvent.click(button)
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2))
    await act(async () => finish({ results: [unplaced(0)] }))
    expect(await screen.findByText(d.stopUnclear)).toBeTruthy()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('says it is not known where the answer to the stop does not come in time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      stopAnswer = () => new Promise(() => undefined)
      await running()
      fireEvent.click(await stopButton())
      await act(async () => finish({ results: [unplaced(0)] }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STOP_ANSWER_MS)
      })
      expect(await screen.findByText(d.stopUnclear)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('puts away the failure of the run before as a run starts', async () => {
    await running()
    await act(async () => finish({ results: [ok(0), failed] }))
    expect(await screen.findByText(d.failedStatement, { exact: false })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: d.execute }))
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(d.failedStatement, { exact: false })).toBeNull()
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0)] }))
    expect((await screen.findByRole('alert')).textContent).toBe(d.stopped + restOf(['ALTER 1']))
    expect(screen.queryByText(d.failedStatement, { exact: false })).toBeNull()
  })

  it('builds the SQL again when run after a stop: other SQL is shown, not run, and runs on the next press', async () => {
    await running()
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0), failed] }))
    await screen.findByRole('alert')
    // A build cut short left an index behind: the server drops it first now.
    rebuilt = ['DROP 0', 'ALTER 0', 'ALTER 1']
    const run = screen.getByRole('button', { name: d.execute })
    // Two presses in one frame: asked once.
    act(() => {
      run.click()
      run.click()
    })
    expect((await screen.findByText(d.revised)).getAttribute('role')).toBe('status')
    expect(previewed).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('SQL').textContent).toBe('DROP 0;\nALTER 0;\nALTER 1;')
    // What was said of the stop is put away with the SQL it was of.
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: d.execute }))
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    expect(execute.mock.calls[1]?.[1]).toEqual(['DROP 0', 'ALTER 0', 'ALTER 1'])
    expect(previewed).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(d.revised)).toBeNull()
  })

  it('keeps the SQL shown while it is built again, and cannot be put away until it is', async () => {
    await running()
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0), failed] }))
    await screen.findByRole('alert')
    let answer: () => void = () => undefined
    previewGate = new Promise((resolve) => (answer = resolve))
    rebuilt = ['DROP 0', 'ALTER 0', 'ALTER 1']
    fireEvent.click(screen.getByRole('button', { name: d.execute }))
    await vi.waitFor(() => expect(previewed).toHaveBeenCalledTimes(2))
    // Not a spinner in its place: the SQL stays, and the run is said to be going, as while it runs.
    expect(screen.getByLabelText('SQL').textContent).toBe('ALTER 0;\nALTER 1;')
    expect(screen.getByRole('button', { name: locale.sql.running })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: locale.common.cancel })).toHaveProperty('disabled', true)
    // Nothing runs yet: nothing to stop.
    expect(screen.queryByRole('button', { name: d.stop })).toBeNull()
    await act(async () => answer())
    expect(await screen.findByText(d.revised)).toBeTruthy()
    expect(screen.getByLabelText('SQL').textContent).toBe('DROP 0;\nALTER 0;\nALTER 1;')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('runs at once when run after a stop where the SQL built again is the same', async () => {
    await running()
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0), failed] }))
    fireEvent.click(await screen.findByRole('button', { name: d.execute }))
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    expect(previewed).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1]?.[1]).toEqual(['ALTER 0', 'ALTER 1'])
  })

  it("runs only the rest after a stop, as the server's results tell, once however often pressed", async () => {
    await running(true, ['ALTER 0', 'ALTER 1', 'ALTER 2'])
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [ok(0), failed] }))
    expect((await screen.findByRole('alert')).textContent).toBe(d.stopped + restOf(['ALTER 1', 'ALTER 2']))
    const rest = screen.getByRole('button', { name: d.runRest })
    // Two presses in one frame: the button is still there for the second.
    act(() => {
      // Pressed, as a browser does it: focused first.
      rest.focus()
      rest.click()
      rest.click()
    })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    expect(execute.mock.calls[1]?.[1]).toEqual(['ALTER 1', 'ALTER 2'])
    // Its own run, stoppable on its own.
    expect(execute.mock.calls[1]?.[2]).not.toBe(execute.mock.calls[0]?.[2])
    expect(screen.queryByRole('alert')).toBeNull()
    // The button went with the notice: the focus is on the stop of this run.
    expect(document.activeElement).toBe(await stopButton())
    const second = (n: number): StatementResult => ({ ...ok(n), statement: n - 1 })
    await act(async () => finish({ results: [second(1), second(2)] }))
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith('build'))
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('goes back to the BEGIN of a transaction the stop rolled back, and stops the rest again from where it got', async () => {
    const tx = ['BEGIN', 'ALTER 1', 'COMMIT', 'ALTER 3']
    const at = (sql: string, statement: number): StatementResult => ({ ...ok(statement), sql })
    await running(true, tx)
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [at('BEGIN', 0), at('ALTER 1', 1)] }))
    // Nothing of it stayed: running it again is running it once.
    expect((await screen.findByRole('alert')).textContent).toBe(d.stopped)
    cleanup()
    execute.mockClear()
    await running(true, tx)
    fireEvent.click(await stopButton())
    await act(async () => finish({ results: [at('BEGIN', 0), at('ALTER 1', 1), at('COMMIT', 2)] }))
    expect((await screen.findByRole('alert')).textContent).toBe(d.stopped + restOf(['ALTER 3']))
  })
})

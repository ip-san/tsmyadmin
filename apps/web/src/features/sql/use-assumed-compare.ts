import { type ExplainResult, HYPOTHETICAL_MAX } from '@tsmyadmin/shared'
import { useEffect, useRef, useState } from 'react'
import { hypotheticalPlan } from '@/lib/queries.ts'
import type { IndexCandidate } from './plan-index.ts'

/** One plan the server gave with some of the candidates assumed: each alone, then all of them together. */
export interface CompareRow {
  indexes: readonly IndexCandidate[]
  result: ExplainResult | null
  error: unknown
}

export interface AssumedCompare {
  /** The rows asked so far, in the order asked; null before any. */
  rows: CompareRow[] | null
  /** Which candidates the rows are of (`candidatesKey`): once the candidates change, the rows are not theirs. */
  asked: string | null
  running: boolean
  /** Asks for each candidate alone, then all together (one plan at a time: a busy server is asked gently). */
  compare: (candidates: readonly IndexCandidate[]) => Promise<void>
}

/** The candidates, as one string: rows asked for other candidates are not shown for these. */
export const candidatesKey = (candidates: readonly IndexCandidate[]) =>
  candidates.map((c) => `${c.table}\0${c.name}\0${c.columns.join('\0')}`).join('\n')

/** The sets of candidates asked for: each alone, then all of them together where there are two or more. */
export function compareSets(candidates: readonly IndexCandidate[]): IndexCandidate[][] {
  const some = candidates.slice(0, HYPOTHETICAL_MAX)
  return [...some.map((c) => [c]), ...(some.length > 1 ? [some] : [])]
}

/**
 * The candidates set side by side without building any (PostgreSQL with HypoPG): the plan with each assumed alone,
 * and with all of them together. Candidates on different tables are not rivals (an index on each table of a join
 * may both help), so the together row says what building them all would be expected to give. A plan that fails is
 * said in its row; the others still come.
 */
export function useAssumedCompare(db: string, schema: string | undefined, sql: string): AssumedCompare {
  const [rows, setRows] = useState<CompareRow[] | null>(null)
  const [asked, setAsked] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const busy = useRef(false)
  const generation = useRef(0)
  // The plan closed (or another statement opened): what is still to be asked is not sent.
  useEffect(
    () => () => {
      generation.current++
    },
    []
  )
  return {
    rows,
    asked,
    running,
    compare: async (candidates) => {
      if (busy.current) return
      busy.current = true
      const mine = ++generation.current
      setRunning(true)
      // The rows before stay until the first new one comes: asked again, the table does not blink away.
      const got: CompareRow[] = []
      try {
        for (const indexes of compareSets(candidates)) {
          let row: CompareRow
          try {
            const result = await hypotheticalPlan(
              db,
              schema,
              sql,
              indexes.map((c) => ({ table: c.table, columns: c.columns, name: c.name }))
            )
            row = { indexes, result, error: null }
          } catch (e) {
            row = { indexes, result: null, error: e }
          }
          if (generation.current !== mine) return
          got.push(row)
          setRows([...got])
          setAsked(candidatesKey(candidates))
        }
      } finally {
        if (generation.current === mine) {
          busy.current = false
          setRunning(false)
        }
      }
    },
  }
}

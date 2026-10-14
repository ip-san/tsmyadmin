import { expect } from 'vitest'

/**
 * What `run` throws (or the promise it returns rejects with), typed as the test expects, for asserting on fields
 * `toThrow` cannot see (a reason, parameters). The test fails when nothing is thrown.
 */
export async function caught<E = Error>(run: Promise<unknown> | (() => unknown)): Promise<E> {
  try {
    await (typeof run === 'function' ? run() : run)
  } catch (e) {
    return e as E
  }
  return expect.fail('expected an error to be thrown')
}

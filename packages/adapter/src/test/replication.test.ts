import { REPLICATION_OP_NAMES, type ReplicationOp } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { buildReplicationOp } from '../sql/replication.ts'

const SAMPLE_OPS: Record<ReplicationOp['op'], ReplicationOp> = {
  startReplica: { op: 'startReplica', threads: 'sql' },
  stopReplica: { op: 'stopReplica', threads: 'all' },
  skipReplicaError: { op: 'skipReplicaError', count: 2 },
  resetReplica: { op: 'resetReplica', all: true },
  changeSource: {
    op: 'changeSource',
    host: "db'1.example",
    port: 3307,
    user: 'repl',
    password: "p'w",
    logFile: 'binlog.000042',
    logPos: 157,
    autoPosition: false,
    start: true,
  },
}

/** The statements, or the refusal for an op the flavour has no equivalent of. */
const built = (dialect: 'mysql' | 'postgres', mariadb: boolean, op: ReplicationOp) => {
  try {
    return buildReplicationOp(dialect, mariadb, op).map((s) => s.sql)
  } catch (err) {
    return [`refused: ${(err as Error).message}`]
  }
}

describe('replication SQL', () => {
  it('has a sample for every op', () => {
    expect(Object.keys(SAMPLE_OPS).sort()).toEqual([...REPLICATION_OP_NAMES].sort())
  })

  for (const name of REPLICATION_OP_NAMES) {
    it(`mysql: ${name}`, () => {
      expect(built('mysql', false, SAMPLE_OPS[name])).toMatchSnapshot()
    })
    it(`mariadb: ${name}`, () => {
      expect(built('mysql', true, SAMPLE_OPS[name])).toMatchSnapshot()
    })
    it(`postgres: ${name}`, () => {
      expect(built('postgres', false, SAMPLE_OPS[name])).toMatchSnapshot()
    })
  }

  it('writes GTID positioning in each flavour’s words, and masks the password in the display form', () => {
    const op: ReplicationOp = {
      ...(SAMPLE_OPS.changeSource as Extract<ReplicationOp, { op: 'changeSource' }>),
      autoPosition: true,
      start: false,
    }
    expect(built('mysql', false, op)[1]).toContain('SOURCE_AUTO_POSITION = 1')
    expect(built('mysql', true, op)[1]).toContain('MASTER_USE_GTID = slave_pos')
    const shown = buildReplicationOp('mysql', false, op)
      .map((s) => s.display)
      .join('\n')
    expect(shown).toContain("SOURCE_PASSWORD = '****'")
    expect(shown).not.toContain("p'w")
    // `start: false` leaves the replica stopped.
    expect(built('mysql', false, op)).toHaveLength(2)
  })
})

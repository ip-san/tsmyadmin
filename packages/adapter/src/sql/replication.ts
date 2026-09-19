import type { Dialect, ReplicationOp } from '@tsmyadmin/shared'
import { PASSWORD_MASK } from '@tsmyadmin/shared'
import { AdapterError, type UserStatement } from '../types.ts'
import { mysqlLiteral } from './literal.ts'

const plain = (sql: string): UserStatement => ({ sql, display: sql })

/**
 * The statements of a replication operation. `mariadb` picks MariaDB's spellings where they differ from MySQL's
 * (CHANGE MASTER TO, sql_slave_skip_counter). A password appears masked in `display` and real in `sql`.
 */
export function buildReplicationOp(dialect: Dialect, mariadb: boolean, op: ReplicationOp): UserStatement[] {
  if (dialect === 'postgres') {
    if (op.op === 'startReplica') return [plain('SELECT pg_wal_replay_resume()')]
    if (op.op === 'stopReplica') return [plain('SELECT pg_wal_replay_pause()')]
    throw new AdapterError('UNSUPPORTED', 'PostgreSQL points a standby at its source with the primary_conninfo setting')
  }
  const thread = (threads: 'all' | 'io' | 'sql') =>
    threads === 'io' ? ' IO_THREAD' : threads === 'sql' ? ' SQL_THREAD' : ''
  switch (op.op) {
    case 'startReplica':
      return [plain(`START REPLICA${thread(op.threads)}`)]
    case 'stopReplica':
      return [plain(`STOP REPLICA${thread(op.threads)}`)]
    case 'skipReplicaError':
      // The counter can only be set while the SQL thread is stopped.
      return [
        plain('STOP REPLICA SQL_THREAD'),
        plain(`SET GLOBAL ${mariadb ? 'sql_slave_skip_counter' : 'sql_replica_skip_counter'} = ${op.count}`),
        plain('START REPLICA SQL_THREAD'),
      ]
    case 'resetReplica':
      return [plain('STOP REPLICA'), plain(`RESET REPLICA${op.all ? ' ALL' : ''}`)]
    case 'changeSource': {
      const [prefix, verb] = mariadb ? ['MASTER', 'CHANGE MASTER TO'] : ['SOURCE', 'CHANGE REPLICATION SOURCE TO']
      const position = op.autoPosition
        ? mariadb
          ? ['MASTER_USE_GTID = slave_pos']
          : ['SOURCE_AUTO_POSITION = 1']
        : [
            ...(op.logFile ? [`${prefix}_LOG_FILE = ${mysqlLiteral(op.logFile)}`] : []),
            ...(op.logPos !== undefined ? [`${prefix}_LOG_POS = ${op.logPos}`] : []),
          ]
      const assign = (password: string) =>
        [
          `${prefix}_HOST = ${mysqlLiteral(op.host)}`,
          `${prefix}_PORT = ${op.port}`,
          `${prefix}_USER = ${mysqlLiteral(op.user)}`,
          `${prefix}_PASSWORD = ${password}`,
          ...position,
        ].join(', ')
      return [
        plain('STOP REPLICA'),
        {
          sql: `${verb} ${assign(mysqlLiteral(op.password))}`,
          display: `${verb} ${assign(mysqlLiteral(PASSWORD_MASK))}`,
        },
        ...(op.start ? [plain('START REPLICA')] : []),
      ]
    }
  }
}

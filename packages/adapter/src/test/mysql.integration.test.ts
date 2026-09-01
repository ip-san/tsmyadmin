import { createAdapter } from '../index.ts'
import type { ConnectionConfig } from '../types.ts'
import { describeAdapterConformance } from './conformance.ts'

const url = new URL(process.env.TEST_MYSQL_URL ?? 'mysql://tsmyadmin:tsmyadmin@127.0.0.1:13306/tsmyadmin_test')
const config: ConnectionConfig = {
  dialect: 'mysql',
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
}

describeAdapterConformance({
  dialect: 'mysql',
  create: () => createAdapter(config),
  createBad: () => createAdapter({ ...config, password: `${config.password}-wrong` }),
  ns: { database: config.database ?? 'tsmyadmin_test' },
  otherDatabase: 'tsmyadmin_other',
  schemas: [],
  typesRow1: {
    big_col: '9223372036854775807',
    dec_col: '12345678901234.567891',
    float_col: 1.5,
    double_col: 2.25,
    bool_col: 1,
    date_col: '2024-03-04',
    time_col: '13:14:15',
    datetime_col: '2024-03-04 13:14:15.123',
    timestamp_col: '2024-03-04 13:14:15',
    json_col: '{"a": 1, "b": [true, null]}',
    blob_col: { $bin: '3q2+7w==' },
    varbinary_col: { $bin: 'AQI=' },
    enum_col: 'beta',
    set_col: 'x,z',
    bit_col: { $bin: 'qg==' },
    text_col: 'some text',
    char_col: 'abc',
  },
  // SLEEP() returns 1 instead of failing when interrupted, and a bare cross join is optimised away,
  // so use a cross join with a WHERE clause that must be evaluated per row.
  slowSql: `SELECT COUNT(*) FROM ${Array.from({ length: 12 }, (_, i) => `users u${i}`).join(', ')} WHERE ${Array.from(
    { length: 12 },
    (_, i) => `u${i}.id`
  ).join(' + ')} > 0`,
})

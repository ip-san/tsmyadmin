import { createAdapter } from '../index.ts'
import type { ConnectionConfig } from '../types.ts'
import { describeAdapterConformance } from './conformance.ts'

const url = new URL(process.env.TEST_PG_URL ?? 'postgres://tsmyadmin:tsmyadmin@127.0.0.1:15433/tsmyadmin_test')
const config: ConnectionConfig = {
  dialect: 'postgres',
  host: url.hostname,
  port: Number(url.port || 5432),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
}

describeAdapterConformance({
  dialect: 'postgres',
  create: () => createAdapter(config),
  createBad: () => createAdapter({ ...config, password: `${config.password}-wrong` }),
  createAs: (user, password) => createAdapter({ ...config, user, password }),
  ns: { database: config.database ?? 'tsmyadmin_test', schema: 'public' },
  otherDatabase: 'tsmyadmin_other',
  schemas: ['public', 'app'],
  typesRow1: {
    big_col: '9223372036854775807',
    dec_col: '12345678901234.567891',
    float_col: 1.5,
    double_col: 2.25,
    bool_col: true,
    date_col: '2024-03-04',
    time_col: '13:14:15',
    datetime_col: '2024-03-04 13:14:15.123',
    timestamp_col: '2024-03-04 13:14:15+00',
    json_col: '{"a": 1, "b": [true, null]}',
    blob_col: { $bin: '3q2+7w==' },
    enum_col: 'sad',
    int_array_col: '{1,2,3}',
    text_array_col: '{a,"b c"}',
    uuid_col: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    text_col: 'some text',
    char_col: 'abc',
  },
  slowSql: 'SELECT pg_sleep(3)',
})

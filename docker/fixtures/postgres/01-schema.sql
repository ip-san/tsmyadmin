-- tsmyadmin test fixtures (PostgreSQL). Runs against POSTGRES_DB (tsmyadmin_test).
CREATE DATABASE tsmyadmin_other;

CREATE SCHEMA app;
CREATE TYPE mood AS ENUM ('happy', 'sad', 'neutral');

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  age INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT uq_users_email UNIQUE (email)
);
COMMENT ON TABLE users IS 'application users';
COMMENT ON COLUMN users.name IS 'display name';
CREATE INDEX idx_users_name ON users (name);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT NULL,
  published_at TIMESTAMPTZ NULL,
  tags JSONB NULL,
  CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE TABLE types_all (
  id SERIAL PRIMARY KEY,
  big_col BIGINT NULL,
  dec_col NUMERIC(20,6) NULL,
  float_col REAL NULL,
  double_col DOUBLE PRECISION NULL,
  bool_col BOOLEAN NULL,
  date_col DATE NULL,
  time_col TIME NULL,
  datetime_col TIMESTAMP(3) NULL,
  timestamp_col TIMESTAMPTZ NULL,
  json_col JSONB NULL,
  blob_col BYTEA NULL,
  enum_col mood NULL,
  int_array_col INT[] NULL,
  text_array_col TEXT[] NULL,
  uuid_col UUID NULL,
  text_col TEXT NULL,
  char_col CHAR(3) NULL
);

CREATE TABLE no_pk (
  a INT NULL,
  b VARCHAR(50) NULL
);
COMMENT ON TABLE no_pk IS 'table without primary key';

CREATE TABLE unique_only (
  code VARCHAR(20) NOT NULL,
  val INT NULL,
  CONSTRAINT uq_unique_only_code UNIQUE (code)
);

CREATE TABLE composite_pk (
  a INT NOT NULL,
  b INT NOT NULL,
  val VARCHAR(50) NULL,
  PRIMARY KEY (a, b)
);

CREATE VIEW active_users AS SELECT id, name FROM users WHERE age IS NOT NULL;

CREATE TABLE app.settings (
  key TEXT PRIMARY KEY,
  value TEXT NULL
);

INSERT INTO users (name, email, age, created_at) VALUES
  ('Alice', 'alice@example.com', 30, '2024-01-01 09:00:00'),
  ('Bob', 'bob@example.com', NULL, '2024-01-02 10:30:00'),
  ('Carol', 'carol@example.com', 41, '2024-01-03 11:45:15'),
  ('Dave', 'dave@example.com', 25, '2024-01-04 12:00:00'),
  ('Eve', 'eve@example.com', 35, '2024-01-05 13:15:00');

INSERT INTO posts (user_id, title, body, published_at, tags) VALUES
  (1, 'Hello', 'first post', '2024-02-01 00:00:00+00', '["intro","hello"]'),
  (1, 'Second', NULL, NULL, NULL),
  (2, 'Bob''s post', 'quote '' inside', '2024-02-03 08:00:00+00', '{"pinned": true}');

INSERT INTO types_all (big_col, dec_col, float_col, double_col, bool_col, date_col, time_col, datetime_col, timestamp_col, json_col, blob_col, enum_col, int_array_col, text_array_col, uuid_col, text_col, char_col) VALUES
  (9223372036854775807, 12345678901234.567891, 1.5, 2.25, TRUE, '2024-03-04', '13:14:15', '2024-03-04 13:14:15.123', '2024-03-04 13:14:15+00', '{"a": 1, "b": [true, null]}', '\xDEADBEEF', 'sad', '{1,2,3}', '{"a","b c"}', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'some text', 'abc'),
  (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (-1, 0.000001, 0, 0, FALSE, '1970-01-01', '00:00:00', '1970-01-01 00:00:00.000', '1970-01-02 00:00:01+00', '[]', '\x', 'happy', '{}', '{}', '00000000-0000-0000-0000-000000000000', '', '');

INSERT INTO no_pk (a, b) VALUES (1, 'one'), (1, 'one'), (2, 'two'), (NULL, NULL);
INSERT INTO unique_only (code, val) VALUES ('A', 1), ('B', 2);
INSERT INTO composite_pk (a, b, val) VALUES (1, 1, 'one-one'), (1, 2, 'one-two'), (2, 1, 'two-one');
INSERT INTO app.settings (key, value) VALUES ('theme', 'dark');

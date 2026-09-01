-- tsmyadmin test fixtures (MySQL). Runs as root on first container start.
-- Every "tricky" column type used by the adapter conformance suite lives in `types_all`.
GRANT ALL PRIVILEGES ON *.* TO 'tsmyadmin'@'%' WITH GRANT OPTION;
CREATE DATABASE IF NOT EXISTS tsmyadmin_other;
CREATE TABLE tsmyadmin_other.marker (id INT PRIMARY KEY);

USE tsmyadmin_test;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL COMMENT 'display name',
  email VARCHAR(255) NOT NULL,
  age INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_name (name)
) ENGINE=InnoDB COMMENT='application users';

CREATE TABLE posts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT NULL,
  published_at TIMESTAMP NULL,
  tags JSON NULL,
  CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE types_all (
  id INT AUTO_INCREMENT PRIMARY KEY,
  big_col BIGINT NULL,
  dec_col DECIMAL(20,6) NULL,
  float_col FLOAT NULL,
  double_col DOUBLE NULL,
  bool_col BOOLEAN NULL,
  date_col DATE NULL,
  time_col TIME NULL,
  datetime_col DATETIME(3) NULL,
  timestamp_col TIMESTAMP NULL,
  json_col JSON NULL,
  blob_col BLOB NULL,
  varbinary_col VARBINARY(16) NULL,
  enum_col ENUM('alpha','beta','gamma') NULL,
  set_col SET('x','y','z') NULL,
  bit_col BIT(8) NULL,
  text_col TEXT NULL,
  char_col CHAR(3) NULL
) ENGINE=InnoDB;

CREATE TABLE no_pk (
  a INT NULL,
  b VARCHAR(50) NULL
) ENGINE=InnoDB COMMENT='table without primary key';

CREATE TABLE unique_only (
  code VARCHAR(20) NOT NULL,
  val INT NULL,
  UNIQUE KEY uq_unique_only_code (code)
) ENGINE=InnoDB;

CREATE TABLE composite_pk (
  a INT NOT NULL,
  b INT NOT NULL,
  val VARCHAR(50) NULL,
  PRIMARY KEY (a, b)
) ENGINE=InnoDB;

CREATE VIEW active_users AS SELECT id, name FROM users WHERE age IS NOT NULL;

INSERT INTO users (name, email, age, created_at) VALUES
  ('Alice', 'alice@example.com', 30, '2024-01-01 09:00:00'),
  ('Bob', 'bob@example.com', NULL, '2024-01-02 10:30:00'),
  ('Carol', 'carol@example.com', 41, '2024-01-03 11:45:15'),
  ('Dave', 'dave@example.com', 25, '2024-01-04 12:00:00'),
  ('Eve', 'eve@example.com', 35, '2024-01-05 13:15:00');

INSERT INTO posts (user_id, title, body, published_at, tags) VALUES
  (1, 'Hello', 'first post', '2024-02-01 00:00:00', '["intro","hello"]'),
  (1, 'Second', NULL, NULL, NULL),
  (2, 'Bob''s post', 'quote '' inside', '2024-02-03 08:00:00', '{"pinned": true}');

INSERT INTO types_all (big_col, dec_col, float_col, double_col, bool_col, date_col, time_col, datetime_col, timestamp_col, json_col, blob_col, varbinary_col, enum_col, set_col, bit_col, text_col, char_col) VALUES
  (9223372036854775807, 12345678901234.567891, 1.5, 2.25, TRUE, '2024-03-04', '13:14:15', '2024-03-04 13:14:15.123', '2024-03-04 13:14:15', '{"a": 1, "b": [true, null]}', X'DEADBEEF', X'0102', 'beta', 'x,z', b'10101010', 'some text', 'abc'),
  (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (-1, 0.000001, 0, 0, FALSE, '1970-01-01', '00:00:00', '1970-01-01 00:00:00.000', '1970-01-02 00:00:01', '[]', X'', X'', 'alpha', '', b'00000000', '', '');

INSERT INTO no_pk (a, b) VALUES (1, 'one'), (1, 'one'), (2, 'two'), (NULL, NULL);
INSERT INTO unique_only (code, val) VALUES ('A', 1), ('B', 2);
INSERT INTO composite_pk (a, b, val) VALUES (1, 1, 'one-one'), (1, 2, 'one-two'), (2, 1, 'two-one');

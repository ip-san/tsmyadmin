# Changelog

このプロジェクトは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) の形式と [セマンティック バージョニング](https://semver.org/lang/ja/) に従います。バージョンはルートと各ワークスペースの `package.json` で管理し、ログイン画面の下部に表示されます。Docker イメージのラベル（`org.opencontainers.image.version`）は `docker build --build-arg VERSION=…` で渡します（`docs/deployment.md`）。

## [Unreleased]

### 修正

- SQL ダンプで `DEFAULT CURRENT_TIMESTAMP` など式デフォルトを持つ MySQL 列（`EXTRA = DEFAULT_GENERATED`）が生成列と誤判定され INSERT から欠落していた
- MySQL: サーバーの `sql_mode` に `NO_BACKSLASH_ESCAPES` が含まれていても、値のプレースホルダが正しく解釈されるようセッションで無効化
- MySQL: JSON / FLOAT / DECIMAL 列を行キーとする更新・削除・エクスポートが一致しない／同じ行を繰り返す問題（型に合わせて `CAST`）、ENUM/SET キーのキーセットページング
- MySQL: `SQL_CALC_FOUND_ROWS` などトップレベル専用の修飾子、構文エラー時のメッセージが読み取り専用ラッパーの影響を受けていた
- MySQL: `2--2` のような減算を行コメントとして扱っていた（`-- ` の後に空白が必要）
- MySQL: GEOMETRY 列をバイナリとして往復（`{x, y}` への変換で SRID が失われていた）
- MySQL: 接続ごとのキャッシュがプールの再借用で効いていなかった（`USE` と timeout 設定が毎回送られていた）、リセット後の照合順序が握手時と異なっていた
- MariaDB: `max_execution_time` が無いサーバーでは `max_statement_time` へ、`STATISTICS.EXPRESSION` が無い場合は式なしへフォールバック
- 操作タブ: ビューに対して `TRUNCATE` / コピーを出さず、`DROP VIEW`（PostgreSQL は `DROP MATERIALIZED VIEW`）を生成。テーブルコピーの列一覧をサーバー側で決定（生成列を除外）
- `.env.example` をそのまま `.env` にコピーすると空の値が enum 検証で拒否されていた
- E2E: 並列ワーカーでの `SESSION_MAX_PER_IDENTITY` 超過によるセッション失効、後始末でユーザー・DB・スキーマも削除
- PostgreSQL: 主キーのないテーブルのエクスポートで行の欠落・重複が起きていた（`ORDER BY ctid` が `ctid::text` の出力列に束縛されていた）
- CSV: バイナリ列を base64 のまま文字列として取り込んでいた（列の型を見て復元）、引用符付きの `\N` を NULL と誤認、空行で中断
- エクスポートで存在しないテーブルを指定すると 200 + ダウンロード開始後に切断されていた（開始前に 404 を返す）
- PostgreSQL: データ付きテーブルコピーの後、コピー先の identity 列のシーケンスが 1 のままで次の挿入が重複エラーになっていた
- ソートの URL パラメータでカラム名に `,` / `:` を含められなかった（パーセントエンコード）。識別子に NUL を含むリクエストが 500 になっていた
- 設定: `TSMYADMIN_ALLOWED_HOSTS=`（空）の「プリセットのみ」の意味を維持、起動時エラーは常に `Invalid environment:` で始まる、プリセットの未知キー（`password` など）を拒否
- SQLite セッションストア: 開けない場合は `session_store.open_failed` を記録して終了、`SESSION_SECRET` 変更時に保存済みセッションを起動時に削除（`session_store.reset`）
- ログ: 成功した `/healthz` `/readyz` をアクセスログに出さない
- MariaDB: SQL コンソールで `ORDER BY` 付きの SELECT が並び順を失っていた（派生テーブルのマージ）→ MySQL / MariaDB は `sql_select_limit` で行数を制限する方式に変更
- MySQL: BIGINT を含む複合キーで 2^53 超の値があるとエクスポートで行が欠落（行コンストラクタ内で DOUBLE 比較）→ 整数型を SIGNED / UNSIGNED にキャスト。バイナリ照合の ENUM/SET キーで大小文字違いのラベルが同一視され欠落 → `COLLATE utf8mb4_bin`
- MySQL: 先頭コメントの後の `DELIMITER` が認識されなかった（mysqldump のルーチン出力）
- 監査ログ: 失敗時にサーバーのエラーメッセージ（値を引用する `Duplicate entry 'x'` など）を記録していた → エラーコードだけを記録。MariaDB の `IDENTIFIED VIA … USING '…'` もマスク
- キャンセルを専用接続から送る（セッションのプールが埋まっていると「キャンセル」が効かなかった）、送信直前に対象がまだ実行中か再確認
- ログイン失敗の応答からサーバーのメッセージ（API 側のアドレスを含む）を除去、0.1.0 のセッションファイルも `SESSION_SECRET` 変更時に削除
- PostgreSQL: エクスポートをサーバーサイドカーソルに変更（主キーのないテーブルで `ctid` のキーセットが O(N²) だった、パーティション親などキーのない関係を 1 回の SELECT で全件読み込んでいた）。継承の親テーブルは子の行を含めずに出力（重複と欠落の原因だった）
- PostgreSQL: シーケンスの前進（`setval`）を最小値でクランプし空テーブルでは実行しない（`MINVALUE 1000` の identity 列でエラーになっていた）、SERIAL 列を持つテーブルのコピーに独自のシーケンスを付ける（元テーブルのシーケンスを共有して DROP できなくなっていた）
- キャンセル後の接続はプールに戻さず閉じる（遅れて届いた `KILL QUERY` / `pg_cancel_backend` が次の利用者の文を中断していた）
- 文字列リテラル・コメント内の `delete` などを DML と誤認して読み取りの行数上限が効かなくなっていた
- CSV エクスポートで空文字列を引用符付きで出力（1 カラムのテーブルで空行として読み飛ばされていた）、ヘッダー不一致のエラーメッセージを上限付きに、サーバーに到達できない場合は「サーバーと通信できません」と表示、エクスポート対象のテーブル名に `,` を含められるように（重複も除去）
- SQL コンソールの「キャンセル」が実行直後に押されると空振りすることがあった（`KILL QUERY` / `pg_cancel_backend` が文の到着前に届くと無効）→ 文の実行中は再送する
- MariaDB: ユーザー一覧（`mysql.user.account_locked` がない）を `global_priv` から取得、`SHOW GRANTS` のパスワードハッシュを除去、errno 1969 などに名前を補完。CI に MariaDB 11 の conformance ジョブを追加
- API: 許可外ホストへのログインは `HOST_NOT_ALLOWED`、上限超過は `PAYLOAD_TOO_LARGE`（インポートのファイル超過も 413）

### 変更

- 日本語 UI の用語統一（カラム / 行・件 / データベース / ユーザーを作成 / システム変数 など）、送信ボタンは「〜する」、取り消せない操作の警告はデータが失われる操作だけに「データは失われます」を付ける、英語メッセージの二重表示を廃止

## [0.1.0] - 2026-09-02

初回リリース。phpMyAdmin と同じ 3 階層（サーバー / データベース / テーブル）の画面構成。検証済み: MySQL 8.4 / PostgreSQL 17（想定: MySQL 8.0+ / MariaDB 10.6+ / PostgreSQL 13+）。

### 追加

- 接続: 運用側が定義する接続先プリセット、接続先 allowlist、ログインのレート制限、暗号化 SQLite セッションストア
- 閲覧: DB・スキーマ・テーブルのツリー（数千テーブルでも仮想化スクロール）、行のブラウズ（ソート・ページング・絞り込み・表示列の選択・外部キーの参照先 / 参照元リンク・概算件数）
- 編集: 行の挿入（続けて挿入・複製）、ダイアログ / インライン編集、一括削除。主キーがないテーブルも安全に 1 行だけ更新（PostgreSQL は `ctid`、MySQL は全カラム一致 + 影響行数検証）
- SQL コンソール: CodeMirror、複数文（MySQL `DELIMITER`、PostgreSQL ドル引用）、文ごとの結果ストリーミング、キャンセル、EXPLAIN、履歴、保存済みクエリ、結果の CSV / JSON ダウンロード
- 構造: テーブルの作成、カラムの追加・変更・削除、インデックス / 外部キーの追加・削除、名前変更・コピー、TRUNCATE / DROP（名前を再入力して確認）、データベース / スキーマの作成・削除
- エクスポート（SQL / CSV / JSON、ストリーミング）/ インポート（SQL スクリプト、CSV）
- ルーチン・トリガー・イベントスケジューラ（MySQL）の一覧と定義表示
- ユーザーアカウントの一覧・権限表示・作成・パスワード変更・削除、DB 単位の GRANT / REVOKE
- サーバー情報・ステータス変数・システム変数・プロセス一覧（KILL）
- 運用: `/healthz` `/readyz`、リクエスト ID 付き構造化ログ、監査ログ、CSP、グレースフルシャットダウン、Docker イメージ
- 品質: MySQL / PostgreSQL 両方で実行するアダプター適合テスト、API / Web ユニットテスト、Playwright（機能 × 両方言、axe、VRT）、静的検査（アーキテクチャ・SQL 安全性・ドキュメント同期）

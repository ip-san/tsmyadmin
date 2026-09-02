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

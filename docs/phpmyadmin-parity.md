# phpMyAdmin との機能対応表

phpMyAdmin 5.2 の全画面（サーバー・データベース・テーブル・設定、計 122 画面）から入力項目と操作を抜き出し、tsmyadmin と照合した一覧です。**この表のすべての行が「✅」か「対象外」になった時点を、phpMyAdmin 相当の完成とします。**

| 記号 | 意味 |
|---|---|
| ✅ | 同等の機能がある（PostgreSQL では対応する機能） |
| △ | 一部だけある |
| ✗ | まだない |
| 対象外 | 作らない（理由を併記） |

基本機能（閲覧・編集、構造変更、SQL、検索、QBE、エクスポート / インポートの基本、権限、ルーチン・トリガー・イベントの作成、追跡、セントラルカラム、表示変換、ユーザーグループ、個人設定、GIS、正規化、コンソール、ズーム検索）は済んでいるため、この表には残りの差だけを載せます。

2026-09 に phpMyAdmin の全画面を再監査し、✅ にしていた 10 行を △ に戻し、新しい行（S18〜、D16〜、T17〜、E9〜、G13〜）と品質負債（Q1〜）を足しました。残作業の詳しい手順は末尾の「残作業の詳細」にあります。

## サーバー

| # | 機能 | 状態 |
|---|---|---|
| S1 | データベース作成時の照合順序の指定、複数データベースの一括削除 | ✅ |
| S2 | SQL: 整形、パラメータのバインド、区切り文字の指定欄、終了時にロールバック、外部キー検査の切替 | ✅ |
| S3 | ステータス: 概要（通信量・接続数）、クエリ統計、変数のカテゴリ絞り込みと警告表示 | ✅ |
| S4 | リアルタイムモニター（グラフ・更新間隔）。スロークエリ / 一般ログの分析は `log_output=TABLE` の場合のみ | ✅ |
| S5 | アドバイザー（設定の改善提案） | ✅ |
| S6 | プロセス: 実行中だけ表示、更新間隔の選択 | ✅ |
| S7 | システム変数の値の変更（SET GLOBAL） | ✅ |
| S8 | ストレージエンジンの詳細（InnoDB の状態など） | ✅ |
| S9 | バイナリログのイベント表示 | ✅ |
| S10 | レプリケーションの操作（開始 / 停止、エラーのスキップ、設定） | ✅ |
| S11 | アカウントのロック / 解除、権限の SQL エクスポート | ✅ |
| S12 | アカウント作成: ホストの選択肢、認証プラグイン、パスワード生成、同名データベースの作成と付与 | ✅ |
| S13 | リソース制限、SSL 要件 | ✅ |
| S14 | グローバル権限の個別編集 | ✅ |
| S15 | カラム単位・ルーチン単位の権限の編集 | ✅ |
| S16 | アカウントの名前変更 / コピー | ✅ |
| S17 | サーバー全体のエクスポート / インポート（複数データベース） | ✅ |
| S18 | ユーザーの一括削除（同名データベースの削除、先に REVOKE して切断） | ✗ |
| S19 | アカウントごとの「データベース権限」一覧（そのアカウントが権限を持つ全 DB と、行ごとの編集 / 取り消し） | ✗ |
| S20 | DB / テーブル権限の WITH GRANT OPTION | ✗ |
| S21 | 自分のパスワードの変更（トップ画面から。アカウント管理権限がなくても） | △（ユーザー一覧からのみ） |
| S22 | レプリケーション: レプリカ用ユーザーの作成、ソース設定（server_id / log_bin / binlog_format / gtid_mode）の案内 | ✗ |
| S23 | エンジンごとの詳細（そのエンジンの変数） | △（InnoDB の状態のみ） |
| S24 | ステータスの起動日時、プロセス一覧の列での並べ替えと「クエリ全文」の切替 | △ |
| S25 | 変数ごとのドキュメントへのリンク（MySQL / MariaDB / PostgreSQL のマニュアル） | ✗ |
| S26 | データベース一覧: 統計（サイズ）の計算の切替と列での並べ替え | △（サイズは常に計算） |

## データベース

| # | 機能 | 状態 |
|---|---|---|
| D1 | 選んだテーブルの一括操作: コピー、CREATE 文の表示、ANALYZE / CHECK / CHECKSUM / OPTIMIZE / REPAIR、接頭辞の追加 / 置換 | ✅ |
| D2 | 一覧の表示項目（文字セット・作成 / 更新日時）、正確な行数をその場で数える | ✅ |
| D3 | データ辞書（全テーブルの定義を印刷用に） | ✅ |
| D4 | 検索の種類（いずれかの語 / すべての語 / 完全一致 / 正規表現）、カラム名での絞り込み | ✅ |
| D5 | 複数テーブルのクエリ（結合を指定） | ✅ |
| D6 | クエリビルダーの条件の保存 | ✅ |
| D7 | 既定の照合順序の変更（全テーブル・全カラムへの反映つき） | ✅ |
| D8 | コピーのオプション（外部キー・AUTO_INCREMENT・権限の引き継ぎなど） | △（データベース単位のコピーは「データも写す」だけ。構造のみ / データのみ・AUTO_INCREMENT・制約・コピー先へ移動は未対応 → D8）|
| D9 | ルーチン: 既存の編集、実行、削除、エクスポート、DEFINER / SQL SECURITY / データアクセス特性 | △（編集は「SQL タブで開く」。引数・本体を埋めたフォームでの編集は未対応 → D9）|
| D10 | トリガー: 既存の編集、エクスポート、DEFINER | △（編集は「SQL タブで開く」→ D10）|
| D11 | イベント: 既存の編集、エクスポート、ON COMPLETION PRESERVE、DEFINER | △（編集は「SQL タブで開く」。PostgreSQL にはイベントがない → D11）|
| D12 | ビュー: OR REPLACE、ALGORITHM、DEFINER、SQL SECURITY、カラム名、WITH CHECK OPTION、既存ビューの編集 | ✅ |
| D13 | デザイナ: 図上でのリレーション作成 / 削除、表示カラム、ページの保存、スキーマ図の出力（SVG / PDF） | △（大小切替・格子への吸着・線上のラベル・直線/折れ線・線の表示切替・全画面が未対応 → D13）|
| D14 | 追跡: データベース単位の一覧、実行された DDL / DML の記録 | ✅ |
| D15 | 正規化の手順（新しいテーブルを作るところまで） | ✅ |
| D16 | テーブル作成フォームのテーブルオプション（エンジン・照合順序・コメント） | ✗（作成後に「操作」で設定） |
| D17 | 構造一覧の行ごとのお気に入り（星） | ✗（テーブル画面にのみ） |
| D18 | セントラルカラムの編集とダウンロード | ✗ |
| D19 | 追跡: バージョンごとの削除と、その定義の SQL ダウンロード | ✗ |
| D20 | クエリビルダー: カラムの前への挿入（Ins / Del） | △（末尾に追加のみ） |
| D21 | データベース検索: 一致した行の削除 | ✗（表示のみ） |
| D22 | デザイナ: DIA / EPS 形式でのスキーマ図の出力 | ✗ |
| D23 | 構造: テーブル構造の提案（各カラムの値から最適な型を提案。MySQL 8.0 に PROCEDURE ANALYSE はないため、値を読んでクライアント側で推定する） | ✗ |

## テーブル

| # | 機能 | 状態 |
|---|---|---|
| T1 | 閲覧: 複数行の編集、選んだ行のエクスポート / コピー、結果からビューを作成、結果のグラフ | △（実行した SQL の枠に 編集 / EXPLAIN / コード化 / ブックマーク / 更新 がない → T1）|
| T2 | 閲覧: カラムの並べ替え（記憶つき）、全文 / 一部の切替、バイナリの 16 進表示、BLOB のダウンロード、空間データの WKT 表示 | ✅ |
| T3 | 閲覧: インデックス順の並べ替え、外部キーの表示カラムで表示、プロファイリング | ✅ |
| T4 | 挿入: 関数（NOW / UUID / MD5 など）、複数行の同時挿入、外部キーの値を選ぶ、新しい行として挿入（行の複製）、ファイルからの BLOB 投入 | △（挿入後の動作の選択・SQL のプレビュー・エラーを無視して挿入が未対応 → T4）|
| T5 | 検索の演算子: IN / NOT IN / BETWEEN / REGEXP / 空文字との比較 | ✅ |
| T6 | 検索: 表示カラムの選択、DISTINCT、任意の WHERE、並べ替え、件数 | ✅ |
| T7 | 検索して置換: 正規表現 | ✅ |
| T8 | ズーム検索: 軸ごとの条件、ラベルのカラム、描画件数の上限 | ✅ |
| T9 | カラム定義: 照合順序、属性（UNSIGNED / ZEROFILL / BINARY / ON UPDATE）、生成カラム、位置の移動、追加時のキー | ✅ |
| T10 | 構造: 選んだカラムにキーを付ける、まとめて変更 / 削除、カラムの並べ替え | ✅ |
| T11 | インデックス: FULLTEXT / SPATIAL、方式、プレフィックス長、名前変更、編集 | ✅ |
| T12 | 構造の情報: 使用容量、行の統計、印刷 | ✅ |
| T13 | パーティションの作成と管理 | ✅ |
| T14 | リレーション: 別データベースへの外部キー、表示カラム | ✅ |
| T15 | 操作: ROW_FORMAT、全カラムの照合順序の変更、ALTER TABLE ORDER BY、CHECKSUM、FLUSH、コピーの詳細オプション | ✅ |
| T16 | 追跡: 記録する文の種類の選択 | ✅ |
| T17 | 表示: すべての行を表示（設定で 1 ページ 1,000 行の上限を外せるようにし、10,000 行を超えるときは警告する） | ✗ |
| T18 | 構造: カラムの「個別の値を表示」（DISTINCT と件数） | ✗ |
| T19 | 操作: 参照整合性の確認（外部キーごとに親のない行を探す） | ✗ |
| T20 | 操作: テーブルオプションの追加（PACK_KEYS / DELAY_KEY_WRITE / TRANSACTIONAL / PAGE_CHECKSUM / STATS_PERSISTENT / STATS_AUTO_RECALC） | ✗ |
| T21 | 表示: プロファイリングの切替（MySQL） | ✗（SQL タブのみ） |
| T22 | 表示: 行のホバー強調 | ✗ |
| T23 | 検索: ENUM / SET のカラムは選択肢から選ぶ | ✗ |

## エクスポート / インポート

| # | 機能 | 状態 |
|---|---|---|
| E1 | 形式: ODS、ODT、Word、Excel 用 CSV、LaTeX、Texy!、MediaWiki、HTML（PDF は対象外、下記） | ✅ |
| E2 | 圧縮（zip / gzip）、テーブルごとに別ファイル、ファイル名テンプレート、文字コードの指定 | ✅ |
| E3 | SQL オプション: INSERT / UPDATE / REPLACE、完全 / 拡張 INSERT、1 文の最大長、INSERT IGNORE、バイナリの 16 進出力、UTC 時刻、トランザクション、ビューをテーブルとして、CREATE DATABASE / USE、IF NOT EXISTS、コメント | ✅ |
| E4 | 行の範囲の指定、テーブルのロック | ✅ |
| E5 | インポート形式: ODS、XML、MediaWiki | ✅ |
| E6 | 圧縮ファイルの取り込み、文字コードの指定、途中からの再開、ドラッグ & ドロップ | ✅ |
| E7 | CSV: 新しいテーブルを作って取り込む、REPLACE / IGNORE、囲み文字・エスケープ文字 | ✅ |
| E8 | SQL: NO_AUTO_VALUE_ON_ZERO | ✅ |
| E9 | 形式ごとのエクスポートオプション（LaTeX の見出し / ラベル、XML の対象（ルーチン・トリガー・ビュー・データ）、JSON の整形 / 圧縮、CSV の改行除去・常に引用符・見出し行の有無、YAML / Markdown / Texy! / MediaWiki / ODT / Word の構造とデータの選択、ODS の NULL の表記） | ✗ |
| E10 | 形式ごとのインポートオプション（CSV のカラム対応表と行の終端、ODS / XML の割合・通貨・日付の扱い、空行を飛ばす） | ✗ |

## 全体

| # | 機能 | 状態 |
|---|---|---|
| G1 | 設定画面（機能・SQL・ナビゲーション・メインパネル・エクスポート / インポートの既定値、ファイル入出力とリセット） | △（「機能」「メインパネル」の項目（既定のタブ、挿入の既定行数、見出しの繰り返し等）が未対応 → G1）|
| G2 | 保存済みクエリの共有と `[VARIABLE]` の置き換え、SQL 履歴のサーバー保存 | ✅ |
| G3 | コンソール: 履歴、ブックマーク、オプション | △（Enter で実行・起動時に開く・メッセージの展開の設定が未対応 → G3）|
| G4 | 実行後の SQL: 編集 / EXPLAIN / アプリ用コードの生成 / 再実行 | ✅ |
| G5 | グラフの種類（縦棒・スプライン・面・円・タイムライン・散布図）、画像として保存 | ✅ |
| G6 | GIS: PNG / SVG で保存 | ✅ |
| G7 | 表示変換の追加（16 進・部分文字列・真偽値・日付書式・IPv4・前後に文字列・画像やテキストのリンク）、入力用の変換（画像のアップロード、正規表現での検証、JSON / XML / SQL エディタ） | △（ダウンロードのリンク、IP → 整数の入力変換が未対応。Formatted / Imagelink / External は対象外 → G7）|
| G8 | ナビゲーション: 接頭辞でのグループ化、項目の非表示、多数のときのページ分け | ✅ |
| G9 | 接続の照合順序の選択、トップページのサーバー情報 | ✅ |
| G12 | 一覧の印刷用表示 | ✅ |
| G13 | お気に入り・最近使ったテーブル・列の並びと表示・表示カラム・サイドバーの開閉をアカウントに保存（pmadb の recent / favorite / table_uiprefs / table_info 相当） | ✗（このブラウザーのみ） |
| G14 | ナビゲーション: 全展開 / 全折りたたみ / 再読み込み | ✗ |
| G15 | ナビゲーションのツリーにルーチン・イベント（任意の設定） | ✗ |
| G16 | サイドバーの幅の変更（記憶つき、キーボードでも） | ✗ |
| G17 | ツリーのテーブルにコメントのツールチップ | ✗ |
| G18 | コンソール設定: Enter で実行（改行は Shift+Enter）、起動時に開く、メッセージの展開 | ✗ |
| G19 | ページごとの設定アイコン（その画面の設定項目へ） | ✗ |
| G20 | ページごとのマニュアルへのリンク（方言ごと） | ✗（ヘルプ 1 つのみ） |
| G21 | セッション期限の事前警告と延長 | ✗（切れてからリダイレクト） |
| G22 | キーボードショートカットの追加（d / s / t / h / b / e、補完の Ctrl+Space） | △（7 個） |
| G23 | 設定の「機能」「メインパネル」の項目（既定のタブ、挿入の既定行数、N 行ごとの見出し、DROP の確認、グリッド編集の既定、フォーカスが外れたら保存 など） | ✗ |
| G24 | 表示変換: バイナリのダウンロードリンク。入力変換: IPv4 → 整数 | ✗ |
| G25 | 対応表の各行に PostgreSQL での差（同等機能がない・代替）を注記する（S1 / S8 / S13 / D1 / D9 / D11 / T10 / T13 / T15） | ✗（文書のみ） |
| G26 | コンソールの「デバッグ SQL」タブ（画面が発行した文と所要時間の一覧） | ✗ |
| G27 | 表示変換の Formatted（値を HTML として表示。サニタイズ必須） | ✗ |
| G28 | 表示変換の Imagelink（外部の画像 URL を表示。許可するホストを環境変数で指定し、CSP の `img-src` に足す） | ✗ |

## 品質負債（レビューで見つかり、未対応のもの）

| # | 内容 | 状態 |
|---|---|---|
| Q1 | `POST /sql-history` の読み取り→書き込みが原子的でなく、同じアカウントの 2 つのタブで実行が消える（`apps/api/src/routes/sql-lists.ts`） | ✅ |
| Q2 | 共有ブックマークの名前の重複検査が原子的でなく、同時保存で持ち主が入れ替わる（同上） | ✅ |
| Q3 | `toLocaleString('ja-JP')` などの直書きが `apps/web/src` に 32 か所（英語 UI でも日本語の区切り・時刻）。`config/locale.ts` に数値 / 時刻の書式関数を置いて置き換える | ✅ |
| Q4 | グラフを SVG / PNG に保存すると凡例が入らない（凡例が `<figcaption>` で SVG の外にある）。散布図と時系列は画面にも凡例がない | ✅ |
| Q5 | 入力変換の正規表現 / JSON / XML の検査がキー入力ごとにメインスレッドで走る。デバウンスするか blur 時に検査する | ✅ |
| Q6 | MySQL の「重複を飛ばす」は `INSERT IGNORE` で、切り詰めなど重複以外の警告も黙って通る。`SHOW WARNINGS` を取り込み結果に出す（任意） | ✅ |
| Q7 | ブックマークの `[DB]` などは引用符なしで展開する。方言ごとに識別子として引用する | ✅ |
| Q8 | 共有ブックマークの「読み込む」は、クリックまでに一覧が再取得されるとエディターを空にする（`SqlPanels.tsx`）。`NamedEntry` に本体を持たせる | ✅ |
| Q9 | 300 行を超えるコンポーネント（`SqlConsole.tsx` 380、`ExportOptionFields.tsx` 303、`AccountDialogs.tsx` 302）を分割する | ✅ |
| Q10 | サイドバーのグループの開閉状態が接頭辞だけをキーにしている（`TableList.tsx`）。DB / スキーマを含める | ✅ |

## 対象外

| 機能 | 理由 |
|---|---|
| MySQL 3.23 / 4.0 などの互換モード（エクスポート / インポート） | 現行のサーバーでは使われない |
| エクスポート: CodeGen（NHibernate）、PHP 配列 | 特定の言語・フレームワーク向けで、汎用の管理ツールの範囲外 |
| インポート: LOAD DATA | `LOCAL` はサーバーがクライアントの任意のファイルを要求できるため無効にしている（mysql2 も既定で無効）。`LOCAL` なしはデータベースサーバー側のファイルを読むため、コンテナ運用に合わない |
| エクスポート: PDF の直接生成 | 日本語などのフォントを PDF に埋め込むにはフォントの同梱が要る。「HTML（印刷 / PDF 用）」を開いて「PDF に保存」で得られる |
| インポート: ESRI Shape ファイル | GIS 専用のバイナリ形式で、データベース管理の用途から外れる（空間データは SQL / CSV の WKT で取り込める） |
| 約 80 言語への翻訳 | 品質を保てない。言語はファイル 1 つと 2 行を足せば追加できる構成にしてある（手順は architecture.md の「言語を足す手順」） |
| ライト / ダーク以外のテーマ | 色はすべて CSS の変数で定義しており、配布先の配色はそこで変えられる |
| 更新の確認、エラーレポートの送信 | 外部への通信になるため、社内に置く管理ツールでは行わない |
| GIS の地図タイル（OpenStreetMap） | 表示中の座標が外部に渡る |
| HTTP / config / signon 認証、reCAPTCHA、Web の設定スクリプト | ログインフォーム・2 要素認証・環境変数で置き換えている |
| サーバー上へのファイル保存、アップロード用ディレクトリ | コンテナで動かす前提と合わない（ダウンロード / アップロードで扱う） |
| 外部コマンドを使う表示変換 | サーバーで任意のコマンドを実行することになる |
| 表示変換の External（外部コマンド） | サーバーで任意のコマンドを実行することになる（上の行と同じ理由） |

## 残作業の詳細

次のセッション（実装担当）向けの手順です。バッチ A から順に、1 バッチ 1 コミットで進めます。目安の S / M / L は見積もりで、実際の規模は着手時に確かめてください。各項目は着手前に「現状」の場所を grep で確かめ、着手後は `CLAUDE.md` の YOU MUST（Zod → API → `hc<AppType>`、DdlOp の `SAMPLE_OPS` 両方言スナップショット、DDL はプレビュー経由、ja / en の両方の locale、`CHANGELOG.md`、`docs/` と `docs/en/` の対応 + `bun run docs:sync`）を守ります。終わった行はこの表を ✅ にします。

### バッチ A: 品質負債（Q1〜Q10）

- **Q1 / Q2**（M）: `apps/api/src/session/store.ts` の `SavedItems` に、読み取りと書き込みを 1 つのトランザクション（SQLite）/ WATCH-MULTI（Redis）で行う `update(config, kind, name, fn)` を足し、`sqlite-store.ts` / `redis-store.ts` / `session/conformance.ts` に実装とテストを足す。`routes/sql-lists.ts` の履歴の追加と共有ブックマークの保存をそれで書き直す。完了条件: 同じアカウントの 2 クライアントからの同時 POST が両方 `GET /sql-history` に残る（`app.test.ts`）。取られた名前への 2 回目の保存が必ず 409。
- **Q3**（M）: `config/locale.ts` に `numberLocale`（`'ja-JP' | 'en-US'`）と `formatNumber` / `formatTime` を置き、`git grep "'ja-JP'" apps/web/src` の 32 か所を置き換える（`SqlPanels.tsx`、`MonitorChart.tsx`、`ResultChart.tsx`、`ChartXY.tsx`、`ConsoleOptions.tsx` など）。完了条件: grep が `locales/ja.ts` だけを返す。`en` で HistoryPanel を描く web テストが `1,234` と 24 時間表記を確かめる。
- **Q4**（M）: 凡例を SVG の中（右上の `<g>` に系列ごとの rect + text）に描き、HTML の `<figcaption>` は sr-only の説明だけにする（`components/results/ResultChart.tsx`、`ChartPie.tsx`、`ChartXY.tsx`）。完了条件: `e2e/sql-results.spec.ts` で保存した SVG の文字列に各系列名が入っている。
- **Q5**（S）: `components/rows/RowField.tsx` の検査を 150 ms デバウンス、または blur 時にする。パターン長の上限（200）は既にある。完了条件: RowForm のテストでキー入力ごとに `JSON.parse` が呼ばれない。
- **Q6**（M、任意）: `packages/adapter/src/base.ts` の `insertRows` で `INSERT IGNORE` の後に `SHOW WARNINGS` を読み、重複以外（1265 / 1366 など）を `ImportResult` の警告に出す。完了条件: 統合テストで、切り詰められた値が警告として現れる。
- **Q7**（S）: `features/sql/variables.ts` で方言に応じて `` ` `` / `"` で識別子として引用する（web は adapter を import できないので小さな関数を置く）。完了条件: `my db` が `` `my db` `` / `"my db"` になる単体テスト。
- **Q8**（S）: `components/panels/NamedListPanel.tsx` の `NamedEntry` に `payload` を持たせ、`SqlPanels.tsx` の共有ブックマークがそれを読み込む。
- **Q9**（M）: `SqlConsole.tsx` の履歴 / ブックマーク配線を `useConsoleLists` フックへ、`ExportOptionFields.tsx` の `SqlFields` を別ファイルへ、`AccountDialogs.tsx` を 2 つに分ける。完了条件: `node scripts/check-architecture.mjs` の警告が 0。
- **Q10**（S）: `features/sidebar/TableList.tsx` の `openGroups` のキーを `${db}/${schema}/${prefix}` にする。

### バッチ B: サーバー（S18〜S26）

- **S18**（M）: `packages/shared/src/schemas/users.ts` に `dropUsers` op（`users[]`、`dropSameNameDatabases`、`revokeFirst`）を足し、`packages/adapter/src/{mysql,postgres}/users.ts` と `test/users.test.ts` の `SAMPLE_OPS` に両方言のスナップショット、`features/users/UsersPage.tsx` にチェックボックス列と一括バー（`confirmName` はホスト名）。完了条件: 2 アカウントを選ぶ → プレビューに `DROP USER a, b`（チェック時は `DROP DATABASE` も）→ 両方言で消える（`e2e/users.spec.ts`）。
- **S19**（M）: `features/users/AccountDatabasesPanel.tsx` を新設し、`grantsQuery`（`SHOW GRANTS` の解析は `global-privileges.ts` と同じ）からそのアカウントが権限を持つ DB を行にし、`/db/$db/privileges` へのリンクと取り消しボタンを付ける。
- **S20**（S）: `PrivilegeTarget` に `grantOption: boolean` を足し、両方言のビルダー（PostgreSQL は `WITH GRANT OPTION` / `REVOKE GRANT OPTION FOR`）とスナップショット、`PrivilegeChooser.tsx` のチェックボックス。
- **S21**（S〜M）: `apps/api/src/routes/users.ts` で `user === session.user` のときは `canManageAccount` なしでもパスワード変更を許可し、`features/server/ServerInfoCard.tsx` からダイアログ（`features/users/PasswordForm.tsx` を再利用）を開く。完了条件: フィクスチャの `reader` アカウントがトップ画面から自分のパスワードを変えられる（`e2e/server-home.spec.ts`）。
- **S22**（M）: `ReplicationControls.tsx` に「レプリカ用ユーザーを作成…」（`createUser` + `REPLICATION SLAVE` の付与。PostgreSQL は `WITH REPLICATION`）と、`variablesQuery` から `server_id` / `log_bin` / `binlog_format` / `gtid_mode` を読む案内カード。
- **S23**（S）: `ServerCatalogPage.tsx` のエンジン行を開くと、その接頭辞（`innodb_` / `myisam_` / `aria_`）の変数を表示。
- **S24**（S）: `insights.ts` に起動日時（now − uptime）、`ProcessesPage.tsx` に列の並べ替えと 100 文字で切る / 全文の切替。
- **S25**（S）: `VariablesPage.tsx` の各行に方言ごとのマニュアル URL（MySQL `…/server-system-variables.html#sysvar_<name>`、MariaDB KB、PostgreSQL `runtime-config`）。外部リンクの方針は `docs/security.md` に合わせる。
- **S26**（S〜M）: `listDatabases({ stats })` を adapter と API に足し、トップ画面に「サイズを数える」の切替と列の並べ替え。

### バッチ C: データベース（D8〜D13 の △、D16〜D21）

- **D9 / D10 / D11**（L）: `packages/shared/src/schemas/ddl.ts` に `replaceRoutine` / `replaceTrigger` / `replaceEvent`（DROP + CREATE、または CREATE OR REPLACE）を足し、両方言のビルダーと `SAMPLE_OPS`、conformance。`CreateRoutineForm` / `CreateTriggerForm` / `CreateEventForm` に `initial` を渡して、各ページの「編集」で埋めた状態で開く（現状は `lib/open-in-console.ts` の `useEditDefinition` で SQL タブに送っている）。完了条件: 引数とスケジュールの編集が両方言の E2E で通る（`e2e/routine-actions.spec.ts`）。
- **D8**（M）: `copyDatabase` op にテーブルのコピーと同じ選択肢（構造のみ / 構造とデータ / データのみ、AUTO_INCREMENT、制約、コピー先へ移動）を足す（`DatabaseOperations.tsx`、`mysql/ddl.ts`、スナップショット）。
- **D13**（M）: `DesignerToolbar.tsx` に大小切替・格子への吸着・線上のラベル・直線 / 折れ線・線の表示・全画面を足し、`designer-pages.ts` の保存内容に入れる。DIA / EPS は対象外。
- **D16**（M）: `createTable` op に `engine` / `collation` / `comment`（PostgreSQL は comment のみ）、`CreateTableForm.tsx` に欄（`operations/TableOptionsForm.tsx` を再利用）。
- **D17**（S）: `TablesList.tsx` の各行に星（`lib/table-shortcuts.ts`）。
- **D18**（S）: `CentralColumnsPage.tsx` に「編集」（追加フォームに埋める）と「ダウンロード」（JSON）。
- **D19**（M）: `apps/api/src/routes/tracking.ts` に `DELETE …/tracking/:version`、`TrackingPage.tsx` に削除と「SQL をダウンロード」。
- **D20**（S）: クエリビルダーの各出力カラムに「前に挿入」。
- **D21**（S）: データベース検索の結果に「削除」（同じ WHERE の DELETE をプレビュー経由で）。
- **D22**（M）: `features/database/designer-svg.ts` と同じ配置から DIA（XML。`<dia:diagram>` に箱と線）と EPS（PostScript のテキスト）を書き出す関数を `designer-dia.ts` / `designer-eps.ts` に置き、ツールバーに追加。完了条件: 出力を `dia` と `gs` で開ける（手元で 1 度確認し、単体テストは構造だけ見る）。
- **D23**（M）: `apps/api/src/lib/import-create.ts` の型推定を `packages/shared` に移して web から使い、`ColumnsTable.tsx` の「構造の提案」で各カラムの先頭 N 行（`/rows` で最大 1,000 行）を読み、今の型より狭い型を提案して `changeColumn` のプレビューへ渡す。完了条件: `VARCHAR(255)` に整数だけ入ったカラムに `INT` を提案する E2E。

### バッチ D: テーブル（T1 / T4 の △、T17〜T23）

- **T1**（M）: `features/sql/StatementActions.tsx` と `SqlCodeDialog.tsx` を `components/` に移し、`features/browse/ExecutedStatement.tsx` に 編集 / EXPLAIN / コード化 / ブックマーク（`useSavedQueries`）/ 更新 を付ける。
- **T4**（M）: `RowForm.tsx` の末尾に「挿入後: この画面に留まる / 一覧へ戻る / 次の行を編集」と「エラーを無視」（`INSERT IGNORE` / `ON CONFLICT DO NOTHING`）、「SQL をプレビュー」（値はバインド表示）。
- **T17**（S〜M）: `Pagination.tsx` に「すべて表示」を足し、設定 `browseUnlimited`（既定オフ）で有効にする。`BROWSE_MAX_LIMIT` を超える取得は `limit=0` を許す形にし（shared スキーマと adapter の `browseRows`）、10,000 行を超えるときは取得前に警告する。グリッドは既に仮想化されている。
- **T18**（S）: `ColumnsTable.tsx` の各カラムに「個別の値」（`SELECT col, COUNT(*) … GROUP BY` を `/sql` で実行して小さなダイアログに）。
- **T19**（S）: `TableOperations.tsx` に「参照整合性の確認」（外部キーごとに `LEFT JOIN … WHERE ref IS NULL`）。
- **T20**（S）: `setTableOptions` op に MySQL のオプションを足し、`TableOptionsForm.tsx` と スナップショット（PostgreSQL は UNSUPPORTED）。
- **T21**（S〜M）: `browseRows` に `profile` を通し、`BrowseToolbar.tsx` の切替と `ProfileView.tsx` を表の下に。
- **T22**（S）: `BrowseRow.tsx` に `hover:bg-surface-sub`（ビジュアルスナップショットの更新が要る）。
- **T23**（S）: `SearchForm.tsx` で `enum(...)` / `set(...)` の型は選択肢にする。

### バッチ E: 横断（G1 / G3 / G7 の △、G13〜G25）

- **G13**（M）: `stored.ts` に per-account の項目（お気に入り・最近・列設定・表示カラム・サイドバー開閉）を足し、`SAVED_ITEM_KINDS` / `routes/stored.ts` / `lib/{table-shortcuts,display-column,account-prefs}.ts` / `browse-search.ts` をアカウント保存に切り替える（`useNamedList` の要領）。完了条件: `SESSION_STORE=sqlite` で 2 つ目のブラウザーに引き継がれる（`e2e/account-preferences.spec.ts`）。
- **G14**（S）: `DbTree.tsx` に全展開 / 全折りたたみ / 再読み込み（`databases` / `tables` の再取得）。
- **G15**（M）: 設定 `navShowRoutines` でツリーの DB の下に「ルーチン」「イベント」の枝（`routinesQuery` / `eventsQuery`）。
- **G16**（S）: `AppShell.tsx` にドラッグハンドル（200〜480 px、キーボードでも）、`navWidth` を設定に。
- **G17**（S）: `TableLink.tsx` の `title` にコメント。
- **G18**（S）: 設定に `sqlEnterRuns` / `consoleStartOpen`、`SqlEditor.tsx` のキーマップ。
- **G19**（S）: `PageTitle.tsx` の `actions` に歯車（`/settings#section`）、`SettingsPage.tsx` にアンカー。
- **G20**（S）: タブ見出しに方言ごとのマニュアルリンク（`locale.docs.*`）。
- **G21**（S）: `/session` に TTL を出し、`routes/_app.tsx` で期限 2 分前に「延長」付きの通知。
- **G22**（S）: `ShortcutHelp.tsx` / `useShortcuts` に d / s / t / h / b / e、補完の Ctrl+Space。
- **G1 / G23**（M）: `PreferencesSchema` に 既定のタブ（サーバー / DB / テーブル）、挿入の既定行数、N 行ごとの見出し、DROP の確認、グリッド編集の既定、フォーカスが外れたら保存 を足し、`SettingsSections.tsx` と利用側（`RowsGrid.tsx`、`InsertPage.tsx`、`routes/_app/db.$db/index.tsx` のリダイレクト）。
- **G3**（S）: G18 と同じ変更で満たす。
- **G7 / G24**（S）: `DISPLAY_TRANSFORMS` に `download`（`lib/cell-url.ts` のダウンロード URL）、`INPUT_TRANSFORMS` に `ipv4-to-int`（`RowForm` の `writtenValue` で変換）。
- **G25**（S、文書のみ）: 対応表の該当行に「PostgreSQL では…」を足す（イベントなし、REQUIRE SSL なし、CHECK / REPAIR なし、カラム順の変更なし、既存テーブルのパーティション化なし など。`packages/adapter/src/postgres/ddl.ts` の UNSUPPORTED を根拠に）。
- **G26**（M）: `lib/api.ts` の `unwrap` / `streamSql` で、画面が発行した SQL（`/sql`、`/rows` の `executedSql`）とその所要時間をこのブラウザーの ring buffer（最大 200 件）に記録し、ドックのコンソールに「デバッグ SQL」タブ（時刻・所要時間・文・再実行）。パスワードを含む文は監査ログと同じマスクをかける。
- **G27**（M）: `DISPLAY_TRANSFORMS` に `html` を足し、`TransformedCell.tsx` で **サニタイズしてから** 描く（`Sanitizer` API があればそれを、なければ許可タグ・属性の allowlist（`p b i u em strong a[href=http(s)] ul ol li br code pre table tr td th`）で自前に）。`javascript:` / `data:` の href と `on*` 属性は必ず落とす。完了条件: `<img onerror>` と `<script>` が描かれない単体テスト。
- **G28**（M）: 環境変数 `TSMYADMIN_IMAGE_HOSTS`（許可するホストのカンマ区切り。`apps/api/src/config.ts`・`.env.example`・`docs/deployment.md`・`docs/en/deployment.md` の 3 か所 + 英訳）を足し、CSP の `img-src` にそれを加える（`apps/api/src/app.ts`）。`DISPLAY_TRANSFORMS` に `imagelink`（値、またはテンプレートに値を差し込んだ http(s) URL を `<img>` に。ホストが許可リストになければリンクとして表示）。完了条件: 許可したホストの画像だけが描かれる E2E（テスト用の画像は API が `/e2e-image` で配る）。

### バッチ F: エクスポート / インポート（E9〜E10）

- **E9**（L）: `ExportQuerySchema` / `ExportOptionsSchema` に形式ごとの欄を足し、`apps/api/src/lib/{export,export-formats,export-documents,export-office}.ts` で反映、`components/export/ExportOptionFields.tsx` に `CsvFields` と同じ形の形式別セクション、`export-url.ts`、テンプレートの保存内容、`export.test.ts`、`e2e/export.spec.ts`。完了条件: XML にルーチン・トリガー・ビューを含められる、CSV で見出し行を省き全フィールドを引用できる、JSON を圧縮表記にできる。
- **E10**（M）: `ImportFormSchema` に CSV のカラム対応表（`columns`）と行の終端、rows 形式の「空行を飛ばす」、ODS の割合 / 通貨 / 日付の扱いを足し、`import.ts` / `import-rows.ts` / `ImportOptionFields.tsx` / `lib/import-options.ts`。

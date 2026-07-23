# TICKET_HASH_TO_VRC_TEST

Zaiko のチケット購入時アンケート（VRChat DisplayName）を自動取得し、SHA-256 ハッシュ化した JSON を GitHub Pages で配信する。VRChat ワールド側はこの JSON と来場者の DisplayName を照合して入場判定を行う。

## 仕組み

更新経路は2つあり、どちらも同じ `docs/tickets.json` を更新する:

```
【経路1: 全自動】GitHub Actions (毎時 cron)
  → Playwright で creators.zaiko.io にログイン（保存済みセッションを再利用）
  → 参加者ページからアンケート CSV をダウンロード
  → DisplayName を正規化 (trim + 小文字化) → SHA-256 → docs/tickets.json
  → 変更があれば commit & push

【経路2: 手動投入・非エンジニア向け】Google Drive + Apps Script (gas/Code.gs)
  → 運用者が Zaiko 管理画面から CSV をダウンロードし、Drive の投入フォルダに入れる
  → 5分おきの GAS トリガーが CSV を検出 → 同じ正規化・ハッシュ化 → GitHub API で push
  → 処理結果をメール通知、CSV は自動でゴミ箱へ

VRChat ワールド (VRCStringDownloader)
  → https://migiri-studio.github.io/TICKET_HASH_TO_VRC_TEST/tickets.json を取得
  → ローカルプレイヤーの DisplayName を同じ手順でハッシュ化して照合
```

経路1のセッションが失効して Actions が失敗している間も、経路2で運用を継続できる。

## 運用者向けガイド（普段の作業はこれだけ）

1. Zaiko の管理画面にログインし、[参加者ページ](https://creators.zaiko.io/migiri/events/383426/participants?answers_context=pre_purchase&ticket=203940)から CSV をダウンロード
2. ダウンロードした CSV を Google Drive の「**チケット投入フォルダ**」に入れる（ドラッグ&ドロップ）
3. 数分以内に「反映完了」メールが届けば完了。エラーメールが届いたら本文の指示に従う

## GAS（経路2）のセットアップ

`gas/Code.gs` の冒頭コメント参照。要点:

1. Drive に投入用フォルダを作成し、運用者に共有
2. [script.google.com](https://script.google.com) で新規プロジェクト → `gas/Code.gs` を貼り付け
3. スクリプト プロパティに `FOLDER_ID` / `GITHUB_TOKEN`（fine-grained PAT、このリポジトリのみ・Contents: Read and write）/ `HASH_SALT`（Secrets と同じ値）/ `NOTIFY_EMAIL` を設定
4. `setup()` を一度実行してトリガー登録

## セットアップ

### 1. Secrets 登録（必須・自分で行う）

リポジトリの **Settings → Secrets and variables → Actions** で登録:

| Secret | 内容 |
| --- | --- |
| `ZAIKO_EMAIL` | Zaiko クリエイターアカウントのメールアドレス |
| `ZAIKO_PASSWORD` | 同パスワード |
| `HASH_SALT` | **必須**。ランダムな文字列（例: `openssl rand -hex 16` で生成）。ワールド側にも同じ値を埋め込む。運用開始後に変更すると全ハッシュが変わるので固定する |
| `ZAIKO_STORAGE_STATE_B64` | 任意。CI のログインが Cloudflare Turnstile に阻まれる場合、ローカルでログイン成功後に `base64 -i data/state.json` した値を登録するとセッション再利用でログインをスキップできる |

### 2. GitHub Pages 有効化

**Settings → Pages → Source: Deploy from a branch → Branch: main / `/docs`**

配信 URL: `https://migiri-studio.github.io/TICKET_HASH_TO_VRC_TEST/tickets.json`

### 3. 初回ログイン（ローカル・人間の操作が1回必要）

Zaiko のログインフォームには Cloudflare Turnstile があるため、初回は headed モードで実行し、ブラウザに出る「私はロボットではありません」を手動でクリックする:

```sh
npm ci
npx playwright install chromium
cp .env.example .env   # 認証情報を記入
HEADED=1 npm run fetch # フォームは自動入力される。Turnstile のチェックとログインだけ手動で行う
npm run build          # data/participants.csv → docs/tickets.json
npm test
```

ログインに成功するとセッションが `data/state.json` に保存され、以降の実行はログイン自体をスキップする。CI 用にはこれを base64 化して Secret に登録する:

```sh
base64 -i data/state.json | pbcopy   # → Secret ZAIKO_STORAGE_STATE_B64 に貼り付け
```

セッションが失効すると Actions が失敗し始めるので、そのときは再度 `HEADED=1 npm run fetch` → Secret を更新する。

#### Turnstile がクリックしても通らない場合

自動化ブラウザ自体が弾かれている。回避手段を順に試す:

1. **WebKit エンジンで実行**: `BROWSER=webkit HEADED=1 npm run fetch`（`npx playwright install webkit` が必要）
2. **通常ブラウザから Cookie を移す**: Safari で creators.zaiko.io にログイン（「ログイン情報を記憶」ON）→ 参加者ページを開く → 開発メニュー → Web インスペクタ → **ネットワーク**タブ → ページを再読み込み → 一番上のドキュメントリクエストを右クリック → **「cURL としてコピー」** → `npm run make-state` に貼り付けて Enter → Ctrl-D。ストレージタブからの手動コピーは値が表示上省略・デコードされて壊れるため使わないこと

失敗時は `data/debug.png` にスクリーンショットが残る（個人情報を含みうるためコミット禁止。`data/` は gitignore 済み）。

- ログイン検出やボタン検出に失敗する場合は `scripts/fetch-csv.mjs` のセレクタを実際の DOM に合わせて調整する
- アンケートは「質問の回答」列以降に「質問, 回答, 質問, 回答…」と交互に並ぶ形式。検出は `config.json` の `answersColumnPattern`（回答開始列）と `displayNameQuestionPattern`（ディスプレイネームを聞く質問文、正規表現・大文字小文字無視）で調整する。アンケートの質問文に「ディスプレイネーム」を含めること

### 4. Actions の確認

**Actions → update-tickets → Run workflow** で手動実行し、`docs/tickets.json` が更新されることを確認。以降は毎時自動実行される（イベント当日だけ頻度を上げたい場合は `.github/workflows/update.yml` の cron を編集）。

## JSON フォーマット

```json
{
  "updatedAt": "2026-07-23T12:00:00.000Z",
  "count": 2,
  "hashes": ["<sha256 hex>", "..."]
}
```

`hashes` は `sha256(lower(trim(displayName)) + HASH_SALT)` の hex 表現。重複排除・ソート済み。

CSV が 0 件のときは誤取得の可能性があるため JSON を更新せず失敗する（前回の内容を維持）。販売開始前など正当な 0 件を許可する場合は、リポジトリの **Settings → Secrets and variables → Actions → Variables** に `ALLOW_EMPTY=1` を設定する（ローカルでは env で指定）。

## VRChat ワールド側の実装メモ

- [UdonHashLib](https://github.com/GlitchyDev/UdonHashLib) の `SHA256_UTF8` を使用
- 照合前の正規化を必ず一致させる: `Networking.LocalPlayer.displayName.Trim().ToLower()`
- `HASH_SALT` の値を正規化後の文字列に連結してからハッシュ化する
- `*.github.io` は VRChat の信頼済み URL なので String Loading がデフォルト設定で動く

## 注意事項

- ハッシュ化は難読化であり暗号学的な秘匿ではない。DisplayName を知っていれば照合可能（生の名簿を public リポジトリに置かないための措置）
- アンケート回答の表記ゆれ（全角/半角、タイポ）は照合失敗になる。購入者への案内で正確な入力を促すこと
- 管理画面の自動操作は Zaiko の仕様変更で壊れる可能性がある。イベント当日は手動実行（`workflow_dispatch`）で最新化を確認しておくと安全

# TICKET_HASH_TO_VRC_TEST

Zaiko のチケット購入時アンケート（VRChat DisplayName）を自動取得し、SHA-256 ハッシュ化した JSON を GitHub Pages で配信する。VRChat ワールド側はこの JSON と来場者の DisplayName を照合して入場判定を行う。

## 仕組み

```
GitHub Actions (毎時 cron)
  → Playwright で creators.zaiko.io にログイン
  → 参加者ページからアンケート CSV をダウンロード
  → DisplayName を正規化 (trim + 小文字化) → SHA-256 → docs/tickets.json
  → 変更があれば commit & push → GitHub Pages が自動配信
VRChat ワールド (VRCStringDownloader)
  → https://migiri-studio.github.io/TICKET_HASH_TO_VRC_TEST/tickets.json を取得
  → ローカルプレイヤーの DisplayName を同じ手順でハッシュ化して照合
```

## セットアップ

### 1. Secrets 登録（必須・自分で行う）

リポジトリの **Settings → Secrets and variables → Actions** で登録:

| Secret | 内容 |
| --- | --- |
| `ZAIKO_EMAIL` | Zaiko クリエイターアカウントのメールアドレス |
| `ZAIKO_PASSWORD` | 同パスワード |
| `HASH_SALT` | 任意。設定する場合はワールド側にも同じ値を埋め込む |

### 2. GitHub Pages 有効化

**Settings → Pages → Source: Deploy from a branch → Branch: main / `/docs`**

配信 URL: `https://migiri-studio.github.io/TICKET_HASH_TO_VRC_TEST/tickets.json`

### 3. ローカルで動作確認

Zaiko のログインフォームや CSV ボタンのセレクタは汎用検出なので、初回は必ずローカルの headed モードで確認する:

```sh
npm ci
cp .env.example .env   # 認証情報を記入
HEADED=1 npm run fetch # ブラウザが開き、ログイン → CSV ダウンロードまで自動実行
npm run build          # data/participants.csv → docs/tickets.json
npm test
```

失敗時は `data/debug.png` にスクリーンショットが残る（個人情報を含みうるためコミット禁止。`data/` は gitignore 済み）。

- ログイン検出やボタン検出に失敗する場合は `scripts/fetch-csv.mjs` のセレクタを実際の DOM に合わせて調整する
- DisplayName 列の検出は `config.json` の `displayNameColumnPattern`（正規表現、大文字小文字無視）で調整する

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

## VRChat ワールド側の実装メモ

- [UdonHashLib](https://github.com/GlitchyDev/UdonHashLib) の `SHA256_UTF8` を使用
- 照合前の正規化を必ず一致させる: `Networking.LocalPlayer.displayName.Trim().ToLower()`
- `HASH_SALT` を設定した場合は正規化後の文字列に連結してからハッシュ化
- `*.github.io` は VRChat の信頼済み URL なので String Loading がデフォルト設定で動く

## 注意事項

- ハッシュ化は難読化であり暗号学的な秘匿ではない。DisplayName を知っていれば照合可能（生の名簿を public リポジトリに置かないための措置）
- アンケート回答の表記ゆれ（全角/半角、タイポ）は照合失敗になる。購入者への案内で正確な入力を促すこと
- 管理画面の自動操作は Zaiko の仕様変更で壊れる可能性がある。イベント当日は手動実行（`workflow_dispatch`）で最新化を確認しておくと安全

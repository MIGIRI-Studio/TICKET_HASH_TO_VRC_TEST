// Safari 等の通常ブラウザでログインしたセッション Cookie を貼り付けて
// Playwright 用の data/state.json を作るヘルパー
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = resolve(root, "data/state.json");

console.log(`Cookie を1行ずつ貼り付けてください。形式（区切りはタブまたは空白）:

  <名前> <値> [<ドメイン>]

ドメイン省略時は creators.zaiko.io。全部貼ったら空行で Enter（または Ctrl-D）。
`);

const cookies = [];
const rl = createInterface({ input: process.stdin });

for await (const line of rl) {
  const trimmed = line.trim();
  if (trimmed === "") break;
  // タブ区切り（インスペクタからのコピー）を優先し、なければ空白区切り
  const parts = (trimmed.includes("\t") ? trimmed.split("\t") : trimmed.split(/ +/))
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length < 2) {
    console.error(`  スキップ（名前と値の2つが必要）: ${trimmed.slice(0, 40)}`);
    continue;
  }
  const name = parts[0];
  let valueParts = parts.slice(1);
  let domain = "creators.zaiko.io";
  const last = valueParts[valueParts.length - 1];
  if (valueParts.length >= 2 && /^\.?[\w-]+(\.[\w-]+)+$/.test(last)) {
    domain = last;
    valueParts = valueParts.slice(0, -1);
  }
  // 先頭ドットなしは host-only 扱いになりサブドメインに送られないため正規化する
  if (!domain.startsWith(".")) domain = `.${domain}`;
  cookies.push({
    name,
    value: valueParts.join(""),
    domain,
    path: "/",
    // 実際の有効期限は不明なので180日先を指定（サーバ側で失効したら再取得）
    expires: Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
  console.log(`  追加: ${name} (${domain})`);
}

if (cookies.length === 0) {
  console.error("Cookie が1件もありません。中断します");
  process.exit(1);
}

mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, JSON.stringify({ cookies, origins: [] }, null, 2) + "\n");
console.log(`
${cookies.length} 件の Cookie で ${statePath} を作成しました。
次に npm run fetch で参加者ページに到達できるか確認してください。`);

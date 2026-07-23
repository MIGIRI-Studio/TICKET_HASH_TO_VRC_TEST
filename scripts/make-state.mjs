// 通常ブラウザでログインしたセッションから Playwright 用の data/state.json を作るヘルパー。
// Web インスペクタの「cURL としてコピー」の貼り付けを想定（Cookie ヘッダを完全な形で取れる）
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = resolve(root, "data/state.json");

console.log(`Safari で creators.zaiko.io にログイン後、Web インスペクタ → ネットワークタブで
参加者ページのリクエストを右クリック → 「cURL としてコピー」した内容を貼り付けてください。
（curl コマンド全体でも、Cookie ヘッダの中身だけでも OK）
貼り付けたら Enter → Ctrl-D で確定。
`);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString("utf8").trim();

if (input === "") {
  console.error("入力が空です。中断します");
  process.exit(1);
}

// curl コマンドなら -H 'Cookie: ...' / -b '...' を抽出、そうでなければ全体を Cookie ヘッダとみなす
let cookieHeader = null;
const curlMatch =
  input.match(/-H\s+(['"])[Cc]ookie:\s*([\s\S]*?)\1/) ?? input.match(/(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/);
if (curlMatch) {
  cookieHeader = curlMatch[2];
} else if (!input.startsWith("curl")) {
  cookieHeader = input.replace(/^[Cc]ookie:\s*/, "");
}
if (!cookieHeader) {
  console.error("Cookie ヘッダを見つけられませんでした。「cURL としてコピー」した内容をそのまま貼り付けてください");
  process.exit(1);
}

const cookies = cookieHeader
  .split(/;\s*/)
  .map((pair) => {
    const i = pair.indexOf("=");
    if (i <= 0) return null;
    return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() };
  })
  .filter(Boolean)
  .map(({ name, value }) => ({
    name,
    // ブラウザが実際に送った転送時の形をそのまま保持する（デコードすると + や % が壊れる）
    value,
    domain: ".creators.zaiko.io",
    path: "/",
    // 実際の有効期限は不明なので180日先を指定（サーバ側で失効したら再取得）
    expires: Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  }));

if (cookies.length === 0) {
  console.error("Cookie が1件も取れませんでした。中断します");
  process.exit(1);
}

mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, JSON.stringify({ cookies, origins: [] }, null, 2) + "\n");
console.log(`
${cookies.length} 件の Cookie で ${statePath} を作成しました:`);
for (const c of cookies) console.log(`  ${c.name} (${c.value.length} 文字)`);
console.log(`
次に npm run fetch で参加者ページに到達できるか確認してください。`);

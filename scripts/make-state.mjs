// 通常ブラウザでログインしたセッションから Playwright 用の data/state.json を作るヘルパー。
// Web インスペクタの「cURL としてコピー」直後に実行すると、クリップボードから直接読み取る
// （ターミナルへの貼り付けは1行の長さ制限で途中で切れるため使わない）
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = resolve(root, "data/state.json");

let input;
if (process.stdin.isTTY) {
  input = execSync("pbpaste", { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).trim();
  console.log(`クリップボードから ${input.length} 文字を読み取りました`);
} else {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  input = Buffer.concat(chunks).toString("utf8").trim();
}

if (input === "") {
  console.error("入力が空です。Safari で「cURL としてコピー」してから実行してください");
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
if (!cookieHeader || !cookieHeader.includes("=")) {
  console.error("Cookie ヘッダを見つけられませんでした。");
  console.error("Safari の ネットワークタブ → 参加者ページのリクエストを右クリック → 「cURL としてコピー」の直後に実行してください");
  console.error(`読み取った先頭部分: ${input.slice(0, 80)}`);
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

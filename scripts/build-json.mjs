import { parse } from "csv-parse/sync";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHashes, extractAnswer, findColumnIndex } from "../src/hash.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(resolve(root, "config.json"), "utf8"));

const csvPath = resolve(root, config.csvPath);
if (!existsSync(csvPath)) {
  console.error(`CSV がありません: ${csvPath}（先に npm run fetch を実行）`);
  process.exit(1);
}

// アンケートの質問・回答はヘッダーのない末尾フィールドに並ぶため、配列のまま扱う
const rows = parse(readFileSync(csvPath), {
  bom: true,
  skip_empty_lines: true,
  relax_column_count: true,
});
const headers = rows[0] ?? [];
const records = rows.slice(1);

// 0 件は「誤ったCSVの取得」の可能性があるため安全側で失敗させ、前回の JSON を維持する。
// 販売開始前など正当な 0 件は ALLOW_EMPTY=1 で明示的に許可する
if (records.length === 0 && process.env.ALLOW_EMPTY !== "1") {
  console.error("CSV が 0 件です。誤取得の可能性があるため中断します（正当な 0 件なら ALLOW_EMPTY=1）");
  process.exit(1);
}

const salt = process.env.HASH_SALT ?? "";
// 無塩だと DisplayName の辞書照合が容易になるため public 運用ではソルト必須
if (salt === "") {
  console.error("HASH_SALT が未設定です。ワールド側と共有するソルトを設定してください");
  process.exit(1);
}

let hashes = [];
if (records.length > 0) {
  const idx = findColumnIndex(headers, config.answersColumnPattern);
  if (idx === -1) {
    console.error(`アンケート回答列が見つかりません。ヘッダー: ${headers.join(" / ")}`);
    console.error(`config.json の answersColumnPattern を調整してください`);
    process.exit(1);
  }
  const entries = records.map((r) => {
    const fields = r.slice(idx);
    return {
      name: extractAnswer(fields, config.displayNameQuestionPattern),
      instance: extractAnswer(fields, config.instanceQuestionPattern),
    };
  });
  const missingName = entries.filter((e) => e.name == null).length;
  const missingInstance = entries.filter((e) => e.instance == null).length;
  if (missingName > 0) {
    console.warn(`注意: ${missingName} 件のレコードで DisplayName 回答が見つかりませんでした`);
  }
  if (missingInstance > 0) {
    console.warn(`注意: ${missingInstance} 件のレコードでインスタンス回答が見つかりませんでした`);
  }
  const valid = entries.filter((e) => e.name != null && e.instance != null).length;
  console.log(`有効回答: ${valid}/${entries.length} 件`);
  // 一部の行だけ抽出に失敗した状態で縮んだ JSON を配信すると、その購入者が
  // 入場不可になるため既定では中断する（質問文変更や CSV 形式ズレの検知）
  if ((missingName > 0 || missingInstance > 0) && process.env.ALLOW_PARTIAL !== "1") {
    console.error("回答を抽出できない行があります。config.json の質問文パターンが CSV と一致しているか確認してください（欠損行を除外して続行するなら ALLOW_PARTIAL=1）");
    process.exit(1);
  }
  if (valid === 0 && process.env.ALLOW_EMPTY !== "1") {
    console.error("有効回答が 0 件です。config.json の質問文パターンが CSV と一致しているか確認してください（正当な 0 件なら ALLOW_EMPTY=1）");
    process.exit(1);
  }
  hashes = buildHashes(entries, salt);
}

const outPath = resolve(root, config.outputPath);
if (existsSync(outPath)) {
  const prev = JSON.parse(readFileSync(outPath, "utf8"));
  if (JSON.stringify(prev.hashes) === JSON.stringify(hashes)) {
    console.log(`変更なし（${hashes.length} 件）`);
    process.exit(0);
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify({ updatedAt: new Date().toISOString(), count: hashes.length, hashes }, null, 2) + "\n",
);
console.log(`書き込みました: ${outPath}（${hashes.length} 件）`);

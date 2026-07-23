import { parse } from "csv-parse/sync";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHashes, findDisplayNameColumn } from "../src/hash.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(resolve(root, "config.json"), "utf8"));

const csvPath = resolve(root, config.csvPath);
if (!existsSync(csvPath)) {
  console.error(`CSV がありません: ${csvPath}（先に npm run fetch を実行）`);
  process.exit(1);
}

const records = parse(readFileSync(csvPath), {
  columns: true,
  bom: true,
  skip_empty_lines: true,
});

if (records.length === 0) {
  console.log("CSV にレコードがありません。JSON は更新しません");
  process.exit(0);
}

const headers = Object.keys(records[0]);
const column = findDisplayNameColumn(headers, config.displayNameColumnPattern);
if (!column) {
  console.error(`DisplayName 列が見つかりません。ヘッダー: ${headers.join(" / ")}`);
  console.error(`config.json の displayNameColumnPattern を調整してください`);
  process.exit(1);
}
console.log(`DisplayName 列: "${column}"`);

const salt = process.env.HASH_SALT ?? "";
const hashes = buildHashes(records, column, salt);

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

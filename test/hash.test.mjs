import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  buildHashes,
  extractAnswer,
  findColumnIndex,
  hashTicket,
  normalize,
} from "../src/hash.mjs";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

test("normalize は前後空白を除去し小文字化する", () => {
  assert.equal(normalize("  Yukke_VRC  "), "yukke_vrc");
  assert.equal(normalize("ミギリちゃん "), "ミギリちゃん");
});

test("hashTicket は正規化した DisplayName とインスタンス名を \\n 区切りで連結した SHA-256 hex を返す", () => {
  assert.equal(hashTicket(" Yukke ", " Instance-A "), sha256("yukke\ninstance-a"));
  assert.equal(hashTicket("yukke", "AdHocライブA インスタンス", "salt1"), sha256("yukke\nadhocライブa インスタンスsalt1"));
});

test("findColumnIndex はパターンに合う列の位置を返す", () => {
  const headers = ["チケット", "名", "姓", "質問の回答", ""];
  assert.equal(findColumnIndex(headers, "質問の回答"), 3);
  assert.equal(findColumnIndex(["注文番号"], "質問の回答"), -1);
});

// Zaiko の実 CSV: 「質問の回答」列以降のフィールドに質問と回答が交互に並ぶ
const FIELDS = [
  "VRChatのDisplayName",
  "takaomi",
  "VRChatのアカウントURLを教えてください",
  "https://vrchat.com/home/user/usr_addb97d3-bc04-4051-ac04-6071281fba5b",
  "チケットの種類",
  "AdHocライブA インスタンス",
];
const NAME_PATTERN = "VRChatのDisplayName";
const INSTANCE_PATTERN = "チケットの種類";

test("extractAnswer は質問の次のフィールドを回答として返す", () => {
  assert.equal(extractAnswer(FIELDS, NAME_PATTERN), "takaomi");
  assert.equal(extractAnswer(FIELDS, INSTANCE_PATTERN), "AdHocライブA インスタンス");
  assert.equal(extractAnswer(["チケットの種類", "AdHocライブA インスタンス"], NAME_PATTERN), null);
  assert.equal(extractAnswer([], NAME_PATTERN), null);
  assert.equal(extractAnswer(null, NAME_PATTERN), null);
  // 質問はあるが回答が空
  assert.equal(extractAnswer(["VRChatのDisplayName", "", "次の質問", "回答"], NAME_PATTERN), null);
});

test("extractAnswer は先頭の空フィールドを読み飛ばして質問位置を合わせる", () => {
  // 「質問の回答」列自体が空のエクスポート形式
  assert.equal(extractAnswer(["", ...FIELDS], NAME_PATTERN), "takaomi");
  assert.equal(extractAnswer(["", ...FIELDS], INSTANCE_PATTERN), "AdHocライブA インスタンス");
});

test("extractAnswer は回答値が質問文と同じでも誤検出しない", () => {
  // DisplayName がそのまま「VRChatのDisplayName」でも回答として返す
  const sameAsQuestion = [
    "VRChatのDisplayName",
    "VRChatのDisplayName",
    "チケットの種類",
    "AdHocライブB インスタンス",
  ];
  assert.equal(extractAnswer(sameAsQuestion, NAME_PATTERN), "VRChatのDisplayName");
  assert.equal(extractAnswer(sameAsQuestion, INSTANCE_PATTERN), "AdHocライブB インスタンス");

  // DisplayName が「チケットの種類」でもインスタンス質問と取り違えない
  const nameLikeInstanceQuestion = [
    "VRChatのDisplayName",
    "チケットの種類",
    "チケットの種類",
    "AdHocライブA インスタンス",
  ];
  assert.equal(extractAnswer(nameLikeInstanceQuestion, NAME_PATTERN), "チケットの種類");
  assert.equal(extractAnswer(nameLikeInstanceQuestion, INSTANCE_PATTERN), "AdHocライブA インスタンス");
});

// gas/Code.gs の selfTest() と共有する golden vector。
// GAS 側実装とハッシュが一致し続けることを保証するため、値は変更禁止
test("golden vector と一致する（GAS 実装とのパリティ保証）", () => {
  const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
  for (const v of vectors) {
    assert.equal(hashTicket(v.name, v.instance, v.salt), v.expected, `name=${JSON.stringify(v.name)}`);
  }
});

// gas/Code.gs の selfTest() と共有する抽出パリティ fixture。値は変更禁止
test("CSV 抽出からハッシュ生成まで GAS 実装と一致する（抽出パリティ fixture）", () => {
  // 行の内訳: 通常 / 先頭空フィールド + DisplayName が質問文と同一 / 重複ペア / インスタンス回答が空（除外）
  const fixtureRows = [
    ["VRChatのDisplayName", "takaomi", "VRChatのアカウントURLを教えてください", "https://example", "チケットの種類", "AdHocライブA インスタンス"],
    ["", "VRChatのDisplayName", "VRChatのDisplayName", "VRChatのアカウントURLを教えてください", "https://example", "チケットの種類", "AdHocライブB インスタンス"],
    ["VRChatのDisplayName", "takaomi", "VRChatのアカウントURLを教えてください", "https://example", "チケットの種類", "AdHocライブA インスタンス"],
    ["VRChatのDisplayName", "nameonly", "チケットの種類", ""],
  ];
  const entries = fixtureRows.map((fields) => ({
    name: extractAnswer(fields, NAME_PATTERN),
    instance: extractAnswer(fields, INSTANCE_PATTERN),
  }));
  assert.deepEqual(buildHashes(entries, "fixture塩"), [
    "644fc7bccc6500ca6965851312ad4cd6903e968bbf124191b672b1eb8f6c855f",
    "aabebcc1076c663119490c77dad72301b7abc4116046555eee55f55c9f08ad0a",
  ]);
});

test("buildHashes は不完全なエントリを除外し、ペア単位で重複排除してソートする", () => {
  const hashes = buildHashes([
    { name: "Alice", instance: "Instance-A" },
    { name: " alice ", instance: " instance-a " },
    { name: "Alice", instance: "Instance-B" },
    { name: "Bob", instance: "" },
    { name: "", instance: "Instance-A" },
    { name: "Bob", instance: null },
    null,
    { name: "Bob", instance: "Instance-A" },
  ]);
  assert.deepEqual(
    hashes,
    [sha256("alice\ninstance-a"), sha256("alice\ninstance-b"), sha256("bob\ninstance-a")].sort(),
  );
});

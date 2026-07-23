import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  buildHashes,
  extractAnswer,
  findColumnIndex,
  hashDisplayName,
  normalizeDisplayName,
} from "../src/hash.mjs";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

test("normalizeDisplayName は前後空白を除去し小文字化する", () => {
  assert.equal(normalizeDisplayName("  Yukke_VRC  "), "yukke_vrc");
  assert.equal(normalizeDisplayName("ミギリちゃん "), "ミギリちゃん");
});

test("hashDisplayName は正規化後の SHA-256 hex を返す", () => {
  assert.equal(hashDisplayName(" Yukke "), sha256("yukke"));
  assert.equal(hashDisplayName("yukke", "salt1"), sha256("yukkesalt1"));
});

test("findColumnIndex はパターンに合う列の位置を返す", () => {
  const headers = ["チケット", "名", "姓", "質問の回答", ""];
  assert.equal(findColumnIndex(headers, "質問の回答"), 3);
  assert.equal(findColumnIndex(["注文番号"], "質問の回答"), -1);
});

test("extractAnswer は質問の次のフィールドを回答として返す", () => {
  // Zaiko の実 CSV: 「質問の回答」列以降に質問と回答が交互に並ぶ（改行連結して渡す）
  const cell = [
    "", // 「質問の回答」列自体は空
    "ディスプレイネームを入力してください",
    "takaomi",
    "VRChatのアカウントURLを教えてください",
    "https://vrchat.com/home/user/usr_addb97d3-bc04-4051-ac04-6071281fba5b",
    "AdHocライブ",
    "AdHocライブA インスタンス",
  ].join("\n");
  const pattern = "ディスプレイネーム|displayname|display name";
  assert.equal(extractAnswer(cell, pattern), "takaomi");
  assert.equal(extractAnswer("AdHocライブ\nAdHocライブA インスタンス", pattern), null);
  assert.equal(extractAnswer("", pattern), null);
  assert.equal(extractAnswer(null, pattern), null);
  // 質問はあるが回答が空行
  assert.equal(extractAnswer("ディスプレイネームを入力してください\n\n次の質問", pattern), null);
});

// gas/Code.gs の selfTest() と共有する golden vector。
// GAS 側実装とハッシュが一致し続けることを保証するため、値は変更禁止
test("golden vector と一致する（GAS 実装とのパリティ保証）", () => {
  const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
  for (const v of vectors) {
    assert.equal(hashDisplayName(v.name, v.salt), v.expected, `name=${JSON.stringify(v.name)}`);
  }
});

test("buildHashes は空値を除外し、重複を排除してソートする", () => {
  const hashes = buildHashes(["Alice", " alice ", "", null, "Bob"]);
  assert.deepEqual(hashes, [sha256("alice"), sha256("bob")].sort());
});

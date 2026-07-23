import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  buildHashes,
  findDisplayNameColumn,
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

test("findDisplayNameColumn はパターンに合う列名を返す", () => {
  const headers = ["注文番号", "メールアドレス", "VRChatのDisplayNameを入力してください"];
  assert.equal(
    findDisplayNameColumn(headers, "displayname|display name|vrchat"),
    "VRChatのDisplayNameを入力してください",
  );
  assert.equal(findDisplayNameColumn(["注文番号"], "vrchat"), null);
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
  const records = [
    { name: "Alice" },
    { name: " alice " },
    { name: "" },
    { name: null },
    { name: "Bob" },
  ];
  const hashes = buildHashes(records, "name");
  assert.deepEqual(hashes, [sha256("alice"), sha256("bob")].sort());
});

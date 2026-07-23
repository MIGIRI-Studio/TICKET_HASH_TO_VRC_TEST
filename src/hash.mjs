import { createHash } from "node:crypto";

// VRChat ワールド側 (Udon) でも同じ正規化を再現する必要があるため、
// Udon で確実に使える Trim + ToLower のみに留める
export function normalizeDisplayName(name) {
  return String(name).trim().toLowerCase();
}

export function hashDisplayName(name, salt = "") {
  return createHash("sha256")
    .update(normalizeDisplayName(name) + salt, "utf8")
    .digest("hex");
}

export function findColumnIndex(headers, pattern) {
  const re = new RegExp(pattern, "i");
  return headers.findIndex((h) => re.test(h));
}

// Zaiko のアンケートは「質問の回答」列以降のヘッダーなしフィールドに
// 「質問, 回答, 質問, 回答…」と交互に並ぶ。フィールドを改行連結した文字列を渡す
export function extractAnswer(cell, questionPattern) {
  const re = new RegExp(questionPattern, "i");
  const lines = String(cell ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim());
  for (let i = 0; i < lines.length - 1; i++) {
    if (re.test(lines[i]) && lines[i + 1] !== "") return lines[i + 1];
  }
  return null;
}

export function buildHashes(names, salt = "") {
  const hashes = names
    .filter((v) => v != null && String(v).trim() !== "")
    .map((v) => hashDisplayName(v, salt));
  return [...new Set(hashes)].sort();
}

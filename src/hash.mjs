import { createHash } from "node:crypto";

// VRChat ワールド側 (Udon) でも同じ正規化を再現する必要があるため、
// Udon で確実に使える Trim + ToLower のみに留める
export function normalize(value) {
  return String(value).trim().toLowerCase();
}

// DisplayName とインスタンス名は "\n" で区切って連結する（結合の曖昧さ防止。
// VRChat の DisplayName に改行は使えない）。ワールド側も同じ連結を再現すること
export function hashTicket(name, instance, salt = "") {
  return createHash("sha256")
    .update(normalize(name) + "\n" + normalize(instance) + salt, "utf8")
    .digest("hex");
}

export function findColumnIndex(headers, pattern) {
  const re = new RegExp(pattern, "i");
  return headers.findIndex((h) => re.test(h));
}

// Zaiko のアンケートは「質問の回答」列以降のヘッダーなしフィールドに
// 「質問, 回答, 質問, 回答…」と交互に並ぶ。回答値が質問文と同じ文字列でも
// 誤検出しないよう、質問位置のフィールドだけをパターン照合する
export function extractAnswer(fields, questionPattern) {
  const re = new RegExp(questionPattern, "i");
  const values = (fields ?? []).map((f) => String(f ?? "").trim());
  let start = 0;
  while (start < values.length && values[start] === "") start++;
  for (let i = start; i < values.length - 1; i += 2) {
    if (re.test(values[i]) && values[i + 1] !== "") return values[i + 1];
  }
  return null;
}

export function buildHashes(entries, salt = "") {
  const hashes = entries
    .filter((e) => e != null && normalize(e.name ?? "") !== "" && normalize(e.instance ?? "") !== "")
    .map((e) => hashTicket(e.name, e.instance, salt));
  return [...new Set(hashes)].sort();
}

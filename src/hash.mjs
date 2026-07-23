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

export function findDisplayNameColumn(headers, pattern) {
  const re = new RegExp(pattern, "i");
  return headers.find((h) => re.test(h)) ?? null;
}

export function buildHashes(records, columnName, salt = "") {
  const hashes = records
    .map((r) => r[columnName])
    .filter((v) => v != null && String(v).trim() !== "")
    .map((v) => hashDisplayName(v, salt));
  return [...new Set(hashes)].sort();
}

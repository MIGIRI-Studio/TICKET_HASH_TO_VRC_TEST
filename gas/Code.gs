// Zaiko アンケート CSV (Google Drive 投入) → ハッシュ JSON → GitHub push
//
// セットアップ（エンジニア向け・初回のみ）:
// 1. Drive に投入用フォルダを作成し、URL 末尾の ID を控える
// 2. script.google.com で新規プロジェクト → このファイルを貼り付け
// 3. プロジェクト設定 → スクリプト プロパティに以下を登録:
//    - FOLDER_ID:    投入用フォルダの ID
//    - GITHUB_TOKEN: fine-grained PAT（対象リポジトリのみ / Contents: Read and write）
//    - HASH_SALT:    GitHub Secrets と同じ値
//    - NOTIFY_EMAIL: 通知先（省略時はスクリプト所有者）
//    - ALLOW_EMPTY:  "1" で 0 件 CSV を許可（通常は未設定）
// 4. setup() を一度実行（5分おきのトリガーが作られる。初回は権限承認ダイアログが出る）
//
// 運用（非エンジニア向け）:
// Zaiko 管理画面から CSV をダウンロードして、投入用フォルダに入れるだけ。
// 数分以内に反映され、結果がメールで届く。CSV は処理後に自動でゴミ箱へ移動される。

const REPO = "MIGIRI-Studio/TICKET_HASH_TO_VRC_TEST";
const BRANCH = "main";
const JSON_PATH = "docs/tickets.json";
const ANSWERS_COLUMN_PATTERN = /質問の回答/;
const QUESTION_PATTERN = /ディスプレイネーム|displayname|display name/i;

function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("main").timeBased().everyMinutes(5).create();
  Logger.log("5分おきのトリガーを設定しました");
}

function main() {
  // トリガー多重実行で GitHub 更新が競合しないよう直列化する
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return;
  try {
    run_();
  } finally {
    lock.releaseLock();
  }
}

function run_() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty("FOLDER_ID");
  const token = props.getProperty("GITHUB_TOKEN");
  const salt = props.getProperty("HASH_SALT");
  if (!folderId || !token || !salt) {
    throw new Error("スクリプト プロパティ FOLDER_ID / GITHUB_TOKEN / HASH_SALT を設定してください");
  }

  const folder = DriveApp.getFolderById(folderId);
  const csvFiles = listCsvFiles_(folder);
  if (csvFiles.length === 0) return;

  // Zaiko の CSV は毎回全件エクスポートなので最新の1つだけ処理する
  csvFiles.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  const file = csvFiles[0];

  try {
    const hashes = csvToHashes_(file.getBlob().getDataAsString("UTF-8"), salt, props.getProperty("ALLOW_EMPTY") === "1");
    const result = publishToGitHub_(hashes, token);
    csvFiles.forEach((f) => f.setTrashed(true));
    notify_("[VRChatチケット] 反映完了", `${file.getName()} を処理しました。\n購入者ハッシュ: ${hashes.length} 件\n結果: ${result}`);
  } catch (e) {
    notify_("[VRChatチケット] エラー", `${file.getName()} の処理に失敗しました。\n\n${e.message}\n\nCSV はフォルダに残っています。ダウンロードし直して再投入するか、管理者に連絡してください。`);
    throw e;
  }
}

function listCsvFiles_(folder) {
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (/\.csv$/i.test(f.getName()) || f.getMimeType() === "text/csv") files.push(f);
  }
  return files;
}

function csvToHashes_(text, salt, allowEmpty) {
  const rows = Utilities.parseCsv(text.replace(/^\uFEFF/, ""));
  if (rows.length < 1 || rows[0].length === 0) throw new Error("CSV を解析できませんでした");

  const headers = rows[0];
  const col = headers.findIndex((h) => ANSWERS_COLUMN_PATTERN.test(h));
  if (col === -1) {
    throw new Error(`アンケート回答列が見つかりません。ヘッダー: ${headers.join(" / ")}`);
  }

  const names = rows
    .slice(1)
    .map((r) => extractAnswer_(r.slice(col).join("\n")))
    .filter((v) => v !== null && v.trim() !== "");
  if (names.length === 0 && !allowEmpty) {
    throw new Error("ディスプレイネームの回答が 0 件です。誤ったファイルの可能性があるため反映を中断しました");
  }

  const hashes = names.map((name) => sha256Hex_(name.trim().toLowerCase() + salt));
  return [...new Set(hashes)].sort();
}

// アンケートは「質問の回答」列以降に「質問, 回答, 質問, 回答…」と交互に並ぶ
// （src/hash.mjs の extractAnswer と同一ロジック。フィールドを改行連結して渡す）
function extractAnswer_(cell) {
  const lines = String(cell)
    .split(/\r?\n/)
    .map((l) => l.trim());
  for (let i = 0; i < lines.length - 1; i++) {
    if (QUESTION_PATTERN.test(lines[i]) && lines[i + 1] !== "") return lines[i + 1];
  }
  return null;
}

function sha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map((b) => (b & 0xff).toString(16).padStart(2, "0"))
    .join("");
}

function publishToGitHub_(hashes, token) {
  const url = `https://api.github.com/repos/${REPO}/contents/${JSON_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  // Actions 側の push と競合して 409 になった場合は sha を取り直して1回だけやり直す
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = UrlFetchApp.fetch(`${url}?ref=${BRANCH}`, { headers, muteHttpExceptions: true });
    let sha = null;
    if (res.getResponseCode() === 200) {
      const current = JSON.parse(res.getContentText());
      sha = current.sha;
      const existing = JSON.parse(
        Utilities.newBlob(Utilities.base64Decode(current.content.replace(/\s/g, ""))).getDataAsString("UTF-8"),
      );
      if (JSON.stringify(existing.hashes) === JSON.stringify(hashes)) {
        return "変更なし（GitHub は更新していません）";
      }
    } else if (res.getResponseCode() !== 404) {
      throw new Error(`GitHub からの取得に失敗: HTTP ${res.getResponseCode()} ${res.getContentText().slice(0, 200)}`);
    }

    const body = JSON.stringify({ updatedAt: new Date().toISOString(), count: hashes.length, hashes }, null, 2) + "\n";
    const put = UrlFetchApp.fetch(url, {
      method: "put",
      headers,
      contentType: "application/json",
      payload: JSON.stringify({
        message: "chore: チケットハッシュ JSON を更新 (via GAS)",
        content: Utilities.base64Encode(body, Utilities.Charset.UTF_8),
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
      muteHttpExceptions: true,
    });
    if (put.getResponseCode() < 300) return "GitHub を更新しました";
    if (put.getResponseCode() !== 409) {
      throw new Error(`GitHub への push に失敗: HTTP ${put.getResponseCode()} ${put.getContentText().slice(0, 200)}`);
    }
  }
  throw new Error("GitHub への push が競合により2回失敗しました。次のトリガー実行で再試行されます");
}

// gas と Node (test/vectors.json) のハッシュ一致を確認する。GAS エディタから手動実行する
function selfTest() {
  const vectors = [
    { name: "  Yukke_VRC  ", salt: "s1", expected: "7ab859c119adbc821dce569ba2b64d416f66a3935d44d143767e042f62a8b1e3" },
    { name: "ミギリちゃん", salt: "塩テスト", expected: "a1c77ec6aadca66f9ead7e22891b3a723f683e263a295281e39e64f5eeb7afc6" },
    { name: "ALLCAPS", salt: "", expected: "108d42d4b0bb58b0c6862711d3633fe07801206270f227b8a1628672a00ad8ba" },
    { name: "MiXeD Case Name", salt: "2a5d", expected: "a787ed30e14e52a55b0d7e0cb4acc871f0c328da1628e37152f4e37911b6384e" },
  ];
  for (const v of vectors) {
    const actual = sha256Hex_(v.name.trim().toLowerCase() + v.salt);
    if (actual !== v.expected) {
      throw new Error(`ハッシュ不一致: ${v.name} → ${actual}（期待値 ${v.expected}）`);
    }
  }
  Logger.log("selfTest OK: Node 実装とハッシュが一致しています");
}

function notify_(subject, body) {
  const to =
    PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAIL") || Session.getEffectiveUser().getEmail();
  if (to) MailApp.sendEmail(to, subject, body);
}

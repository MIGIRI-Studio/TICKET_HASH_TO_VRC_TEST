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
const COLUMN_PATTERN = /displayname|display name|vrchat/i;

function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("main").timeBased().everyMinutes(5).create();
  Logger.log("5分おきのトリガーを設定しました");
}

function main() {
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
  const col = headers.findIndex((h) => COLUMN_PATTERN.test(h));
  if (col === -1) {
    throw new Error(`DisplayName 列が見つかりません。ヘッダー: ${headers.join(" / ")}`);
  }

  const records = rows.slice(1).map((r) => (r[col] || "").trim()).filter((v) => v !== "");
  if (records.length === 0 && !allowEmpty) {
    throw new Error("CSV の回答が 0 件です。誤ったファイルの可能性があるため反映を中断しました");
  }

  const hashes = records.map((name) => sha256Hex_(name.toLowerCase() + salt));
  return [...new Set(hashes)].sort();
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
  if (put.getResponseCode() >= 300) {
    throw new Error(`GitHub への push に失敗: HTTP ${put.getResponseCode()} ${put.getContentText().slice(0, 200)}`);
  }
  return "GitHub を更新しました";
}

function notify_(subject, body) {
  const to =
    PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAIL") || Session.getEffectiveUser().getEmail();
  if (to) MailApp.sendEmail(to, subject, body);
}

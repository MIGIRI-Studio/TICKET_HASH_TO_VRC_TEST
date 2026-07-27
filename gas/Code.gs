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
//    - ALLOW_PARTIAL: "1" で回答を抽出できない行を除外して続行（通常は未設定）
// 4. setup() を一度実行（5分おきのトリガーが作られる。初回は権限承認ダイアログが出る）
//
// 運用（非エンジニア向け）:
// Zaiko 管理画面から CSV をダウンロードして、投入用フォルダに入れるだけ。
// 数分以内に反映され、結果がメールで届く。CSV は処理後に自動でゴミ箱へ移動される。

const REPO = "MIGIRI-Studio/TICKET_HASH_TO_VRC_TEST";
const BRANCH = "main";
const JSON_PATH = "docs/tickets.json";
const ANSWERS_COLUMN_PATTERN = /質問の回答/;
const DISPLAY_NAME_QUESTION_PATTERN = /VRChatのDisplayName/i;
const INSTANCE_QUESTION_PATTERN = /チケットの種類/i;

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
    const hashes = csvToHashes_(
      file.getBlob().getDataAsString("UTF-8"),
      salt,
      props.getProperty("ALLOW_EMPTY") === "1",
      props.getProperty("ALLOW_PARTIAL") === "1",
    );
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

function csvToHashes_(text, salt, allowEmpty, allowPartial) {
  const rows = Utilities.parseCsv(text.replace(/^\uFEFF/, ""));
  if (rows.length < 1 || rows[0].length === 0) throw new Error("CSV を解析できませんでした");

  const headers = rows[0];
  const col = headers.findIndex((h) => ANSWERS_COLUMN_PATTERN.test(h));
  if (col === -1) {
    throw new Error(`アンケート回答列が見つかりません。ヘッダー: ${headers.join(" / ")}`);
  }

  const entries = rows.slice(1).map((r) => {
    const fields = r.slice(col);
    return {
      name: extractAnswer_(fields, DISPLAY_NAME_QUESTION_PATTERN),
      instance: extractAnswer_(fields, INSTANCE_QUESTION_PATTERN),
    };
  });
  // 一部の行だけ抽出に失敗した状態で縮んだ JSON を配信すると、その購入者が
  // 入場不可になるため既定では中断する（質問文変更や CSV 形式ズレの検知）
  const missing = entries.filter((e) => e.name === null || e.instance === null).length;
  if (missing > 0 && !allowPartial) {
    throw new Error(
      `回答を抽出できない行が ${missing} 件あります。質問文の変更や CSV 形式のズレの可能性があるため反映を中断しました（欠損行を除外して続行するならスクリプト プロパティ ALLOW_PARTIAL を "1" に設定）`,
    );
  }
  const valid = entries.filter((e) => e.name !== null && e.instance !== null);
  if (valid.length === 0 && !allowEmpty) {
    throw new Error("DisplayName + インスタンスの回答が 0 件です。誤ったファイルの可能性があるため反映を中断しました");
  }

  // DisplayName とインスタンス名を "\n" 区切りで連結してハッシュ化（src/hash.mjs の hashTicket と同一）
  const hashes = valid.map((e) => sha256Hex_(e.name.trim().toLowerCase() + "\n" + e.instance.trim().toLowerCase() + salt));
  return [...new Set(hashes)].sort();
}

// アンケートは「質問の回答」列以降に「質問, 回答, 質問, 回答…」と交互に並ぶ。
// 回答値が質問文と同じ文字列でも誤検出しないよう、質問位置だけをパターン照合する
// （src/hash.mjs の extractAnswer と同一ロジック）
function extractAnswer_(fields, pattern) {
  const values = fields.map((f) => String(f).trim());
  let start = 0;
  while (start < values.length && values[start] === "") start++;
  for (let i = start; i < values.length - 1; i += 2) {
    if (pattern.test(values[i]) && values[i + 1] !== "") return values[i + 1];
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
    { name: "  Yukke_VRC  ", instance: "AdHocライブA インスタンス", salt: "s1", expected: "d02468ce28d808aca96a6b350088ceb477598ea0d4a553582309ce38e18acc12" },
    { name: "ミギリちゃん", instance: "AdHocライブB インスタンス", salt: "塩テスト", expected: "a77228919b8447e9b689e62b74a4d84d8c35b0b50dc5aeb29748b3674c7c187e" },
    { name: "ALLCAPS", instance: " Instance-1 ", salt: "", expected: "4645bc6149182392b2516dda49b498cbc82aec5eb754aeb2055f82bc0e286ed1" },
    { name: "VRChatのDisplayName", instance: "チケットの種類", salt: "2a5d", expected: "54feb7327cda5cbb76c0a7666deaa00d3a0c0c1d300d2a95320864310e36d6c5" },
  ];
  for (const v of vectors) {
    const actual = sha256Hex_(v.name.trim().toLowerCase() + "\n" + v.instance.trim().toLowerCase() + v.salt);
    if (actual !== v.expected) {
      throw new Error(`ハッシュ不一致: ${v.name} → ${actual}（期待値 ${v.expected}）`);
    }
  }

  // CSV 抽出 → ハッシュ生成のパリティ確認（test/hash.test.mjs の fixture と同一。値は変更禁止）
  // 行の内訳: 通常 / 先頭空フィールド + DisplayName が質問文と同一 / 重複ペア / インスタンス回答が空（除外）
  const fixtureRows = [
    ["VRChatのDisplayName", "takaomi", "VRChatのアカウントURLを教えてください", "https://example", "チケットの種類", "AdHocライブA インスタンス"],
    ["", "VRChatのDisplayName", "VRChatのDisplayName", "VRChatのアカウントURLを教えてください", "https://example", "チケットの種類", "AdHocライブB インスタンス"],
    ["VRChatのDisplayName", "takaomi", "VRChatのアカウントURLを教えてください", "https://example", "チケットの種類", "AdHocライブA インスタンス"],
    ["VRChatのDisplayName", "nameonly", "チケットの種類", ""],
  ];
  const fixtureExpected = [
    "644fc7bccc6500ca6965851312ad4cd6903e968bbf124191b672b1eb8f6c855f",
    "aabebcc1076c663119490c77dad72301b7abc4116046555eee55f55c9f08ad0a",
  ];
  const fixtureHashes = [
    ...new Set(
      fixtureRows
        .map((fields) => ({
          name: extractAnswer_(fields, DISPLAY_NAME_QUESTION_PATTERN),
          instance: extractAnswer_(fields, INSTANCE_QUESTION_PATTERN),
        }))
        .filter((e) => e.name !== null && e.instance !== null)
        .map((e) => sha256Hex_(e.name.trim().toLowerCase() + "\n" + e.instance.trim().toLowerCase() + "fixture塩")),
    ),
  ].sort();
  if (JSON.stringify(fixtureHashes) !== JSON.stringify(fixtureExpected)) {
    throw new Error(`抽出パリティ不一致: ${JSON.stringify(fixtureHashes)}（期待値 ${JSON.stringify(fixtureExpected)}）`);
  }
  Logger.log("selfTest OK: Node 実装とハッシュが一致しています");
}

function notify_(subject, body) {
  const to =
    PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAIL") || Session.getEffectiveUser().getEmail();
  if (to) MailApp.sendEmail(to, subject, body);
}

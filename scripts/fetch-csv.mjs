import { chromium, firefox, webkit } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(resolve(root, "config.json"), "utf8"));

const csvPath = resolve(root, config.csvPath);
const statePath = resolve(root, "data/state.json");
mkdirSync(dirname(csvPath), { recursive: true });

// CI では保存済みセッション (base64) を復元し、Cloudflare Turnstile 付きログインを回避する
if (process.env.ZAIKO_STORAGE_STATE_B64 && !existsSync(statePath)) {
  writeFileSync(statePath, Buffer.from(process.env.ZAIKO_STORAGE_STATE_B64, "base64"));
  console.log("ZAIKO_STORAGE_STATE_B64 からセッションを復元しました");
}

const email = process.env.ZAIKO_EMAIL;
const password = process.env.ZAIKO_PASSWORD;
const hasState = existsSync(statePath);
if (!hasState && (!email || !password)) {
  console.error("ZAIKO_EMAIL / ZAIKO_PASSWORD（または保存済みセッション）が必要です");
  process.exit(1);
}

const headed = process.env.HEADED === "1";
// Turnstile の自動化検出は Chromium 向けが強いため、BROWSER=webkit / firefox も選べる
const engineName = process.env.BROWSER || "chromium";
const engine = { chromium, firefox, webkit }[engineName];
if (!engine) {
  console.error(`BROWSER は chromium / firefox / webkit のいずれかを指定してください: ${engineName}`);
  process.exit(1);
}

// Chromium: headless の既定 UA は CloudFront に弾かれるため通常ブラウザの UA を名乗り、
// 人間が Turnstile を解けるよう自動化シグナル (navigator.webdriver 等) を外す
const chromiumOnly = {
  launch: {
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  },
  context: {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
};
const launchOptions = {
  headless: !headed,
  ...(engineName === "chromium" ? chromiumOnly.launch : {}),
};
const contextOptions = {
  locale: "ja-JP",
  ...(engineName === "chromium" ? chromiumOnly.context : {}),
};

let context;
let browser = null;
if (hasState) {
  browser = await engine.launch(launchOptions);
  context = await browser.newContext({ ...contextOptions, storageState: statePath });
} else {
  // 初回ログインは永続プロファイルで行い、Cookie をローカルにも残す
  context = await engine.launchPersistentContext(resolve(root, `data/profile-${engineName}`), {
    ...launchOptions,
    ...contextOptions,
  });
}
const page = context.pages()[0] ?? (await context.newPage());

try {
  await page.goto(config.participantsUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  if (page.url().includes("/login")) {
    if (!email || !password) {
      throw new Error("セッションが失効しています。ZAIKO_EMAIL / ZAIKO_PASSWORD を設定して再ログインしてください");
    }
    console.log("ログインページを検出、ログインします");
    const emailInput = page.locator('input[name="identifier"], input[type="email"]').first();
    await emailInput.waitFor({ state: "visible", timeout: 20000 });
    await emailInput.fill(email);
    await page.locator('input[name="password"], input[type="password"]').first().fill(password);
    // セッションを長持ちさせるため「ログイン情報を記憶」を有効化（失敗しても続行）
    await page.locator("#checkboxRemember").check({ force: true }).catch(() => {});

    await page.locator('form input[type="submit"], form button[type="submit"]').first().click();
    const leftLogin = (timeout) =>
      page
        .waitForURL((url) => !url.toString().includes("/login"), { timeout })
        .then(() => true)
        .catch(() => false);

    let loggedIn = await leftLogin(15000);
    // Turnstile が対話チャレンジを出した場合は人間に完了してもらう（自動突破はしない）
    if (!loggedIn && headed) {
      console.log("");
      console.log("→ ブラウザで「私はロボットではありません」をクリックし、ログインボタンを押してください（最大5分待ちます）");
      loggedIn = await leftLogin(300000);
    }
    if (!loggedIn) {
      throw new Error(
        "ログインに失敗しました。HEADED=1 で実行し、Cloudflare のチェックを手動で完了してください（成功するとセッションが保存され、以降は不要になります）",
      );
    }

    await context.storageState({ path: statePath });
    console.log(`セッションを保存しました: ${statePath}`);
    console.log("CI で Turnstile に阻まれる場合は `base64 -i data/state.json` の値を Secret ZAIKO_STORAGE_STATE_B64 に登録");

    if (!page.url().includes("/participants")) {
      await page.goto(config.participantsUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
    }
  }

  console.log(`現在のページ: ${page.url()}`);
  // 想定外のページで CSV リンクを誤クリックしないよう、参加者ページにいることを確認する
  if (!page.url().includes("/participants")) {
    throw new Error(`参加者ページに到達できませんでした: ${page.url()}`);
  }

  const csvTrigger = page
    .locator("a, button")
    .filter({ hasText: /csv/i })
    .first();
  await csvTrigger.waitFor({ state: "visible", timeout: 15000 });

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    csvTrigger.click(),
  ]);
  await download.saveAs(csvPath);
  console.log(`CSV を保存しました: ${csvPath}`);
} catch (err) {
  const shot = resolve(root, "data/debug.png");
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  console.error(`失敗: ${err.message}`);
  console.error(`URL: ${page.url()}`);
  console.error(`スクリーンショット: ${shot}（ローカル調査用・コミット禁止）`);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser?.close();
}

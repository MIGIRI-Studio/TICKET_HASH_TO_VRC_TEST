import { chromium } from "playwright";
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
const browser = await chromium.launch({ headless: !headed });
// headless の既定 UA は CloudFront に弾かれるため、通常ブラウザの UA を名乗る
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  locale: "ja-JP",
  ...(hasState ? { storageState: statePath } : {}),
});
const page = await context.newPage();

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
    await page
      .waitForURL((url) => !url.toString().includes("/login"), { timeout: 30000 })
      .catch(() => {
        throw new Error("ログインに失敗しました（認証情報、または Cloudflare Turnstile のチャレンジを確認）");
      });

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
  await browser.close();
}

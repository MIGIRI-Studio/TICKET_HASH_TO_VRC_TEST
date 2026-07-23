import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(resolve(root, "config.json"), "utf8"));

const email = process.env.ZAIKO_EMAIL;
const password = process.env.ZAIKO_PASSWORD;
if (!email || !password) {
  console.error("ZAIKO_EMAIL / ZAIKO_PASSWORD を環境変数で指定してください");
  process.exit(1);
}

const headed = process.env.HEADED === "1";
const csvPath = resolve(root, config.csvPath);
mkdirSync(dirname(csvPath), { recursive: true });

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage();

try {
  await page.goto(config.participantsUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  const passwordInput = page.locator('input[type="password"]').first();
  if (await passwordInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log("ログインページを検出、ログインします");
    const emailInput = page
      .locator('input[type="email"], input[name*="mail" i], input[name*="login" i], input[type="text"]')
      .first();
    await emailInput.fill(email);
    await passwordInput.fill(password);

    const submit = page
      .locator('button[type="submit"], input[type="submit"]')
      .or(page.getByRole("button", { name: /ログイン|log ?in|sign ?in/i }))
      .first();
    await submit.click();
    await page.waitForLoadState("networkidle").catch(() => {});

    if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) {
      throw new Error("ログインに失敗しました（認証情報または追加認証を確認してください）");
    }

    if (!page.url().includes("/participants")) {
      await page.goto(config.participantsUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
    }
  }

  console.log(`現在のページ: ${page.url()}`);

  const csvTrigger = page
    .locator('a, button')
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

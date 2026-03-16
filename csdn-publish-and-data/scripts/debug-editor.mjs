import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const outputDir = path.resolve(process.cwd(), "..", "test-output");
const htmlPath = path.join(outputDir, "editor-debug-md.html");
const textPath = path.join(outputDir, "editor-debug-md.txt");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const statePath = path.resolve(__dirname, "..", ".auth", "storageState.json");

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const storageState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  await page.goto("https://editor.csdn.net/md/?not_checkout=1&spm=1015.2103.3001.8066", {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => undefined);
  const html = await page.content();
  const bodyText = await page.locator("body").innerText().catch(() => "");
  fs.writeFileSync(htmlPath, html, "utf-8");
  fs.writeFileSync(textPath, bodyText, "utf-8");
  console.log(htmlPath);
  console.log(textPath);
  await context.close();
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
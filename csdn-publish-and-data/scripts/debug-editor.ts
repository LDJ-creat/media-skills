import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

async function main(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const statePath = path.resolve(__dirname, "..", ".auth", "storageState.json");
  const outputDir = path.resolve(process.cwd(), "..", "test-output");
  const htmlPath = path.join(outputDir, "editor-debug.html");
  const textPath = path.join(outputDir, "editor-debug.txt");
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
  await page.goto("https://mp.csdn.net/mp_blog/creation/editor?spm=1001.2014.3001.4503", {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 120_000 }).catch(() => undefined);

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
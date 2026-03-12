import fs from "node:fs";
import type {
  BrowserContext,
  BrowserContextOptions,
  Cookie,
  Locator,
  Page,
  Response,
} from "playwright";
import { chromium } from "playwright";
import type {
  ArticleInput,
  AuthFileRef,
  CapturedResponse,
  ConcretePageType,
  CookieFileEntry,
  CrawlResult,
  PageFallbackState,
  PublishRequest,
  PublishResult,
  StorageStateFile,
} from "./types";

const CREATOR_HOME_URL = "https://mp.csdn.net/";
const EDITOR_URL = "https://editor.csdn.net/md/?not_checkout=1&spm=1015.2103.3001.8066";
const ANALYTICS_URL = "https://mp.csdn.net/mp_blog/analysis/article/single";
const MANAGE_URL = "https://mp.csdn.net/mp_blog/manage/article?spm=1011.2415.3001.10336";

const PAGE_URLS: Record<ConcretePageType, string> = {
  analytics: ANALYTICS_URL,
  manage: MANAGE_URL,
};

const CAPTURE_KEYWORDS: Record<ConcretePageType, string[]> = {
  analytics: ["analysis", "article", "trend", "stat", "overview", "data"],
  manage: ["manage", "article", "list", "status", "search", "blog"],
};

const LOGIN_HINTS = ["微信登录", "验证码登录", "登录可享更多权益", "扫一扫，快速登录", "passport.csdn.net"];

type StorageState = Exclude<BrowserContextOptions["storageState"], string | undefined>;

interface CrawlOptions {
  authFile: AuthFileRef;
  pageTypes: ConcretePageType[];
  start?: string;
  end?: string;
  timeoutMs: number;
  headless: boolean;
}

interface AnalyticsRange {
  start: string;
  end: string;
  startTimestamp: number;
  endTimestamp: number;
}

interface RecentArticleRef {
  articleId: string;
}

interface SessionInfo {
  finalUrl: string;
  pageTitle: string;
  bodyPreview: string;
}

function normalizeCookie(input: CookieFileEntry): Cookie {
  return {
    name: input.name,
    value: input.value,
    domain: input.domain,
    path: input.path ?? "/",
    expires: typeof input.expires === "number"
      ? input.expires
      : typeof input.expirationDate === "number"
        ? input.expirationDate
        : -1,
    httpOnly: Boolean(input.httpOnly),
    secure: Boolean(input.secure),
    sameSite: input.sameSite ?? "Lax",
  };
}

function loadCookieFile(cookiePath: string): Cookie[] {
  const raw = fs.readFileSync(cookiePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Cookie JSON must be an array of cookie objects");
  }

  const cookies: Cookie[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<CookieFileEntry>;
    if (!candidate.name || !candidate.value || !candidate.domain) continue;
    cookies.push(normalizeCookie(candidate as CookieFileEntry));
  }

  if (cookies.length === 0) {
    throw new Error("No valid cookie entries found in cookie JSON");
  }

  return cookies;
}

function loadStorageStateFile(storageStatePath: string): StorageState {
  const raw = fs.readFileSync(storageStatePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as StorageStateFile).cookies)) {
    throw new Error("Storage state JSON must be an object with a cookies array");
  }

  const state = parsed as StorageStateFile;
  return {
    cookies: state.cookies.map((cookie) => ({
      ...cookie,
      path: cookie.path ?? "/",
      expires: typeof cookie.expires === "number"
        ? cookie.expires
        : typeof cookie.expirationDate === "number"
          ? cookie.expirationDate
          : -1,
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      sameSite: cookie.sameSite ?? "Lax",
    })),
    origins: state.origins?.map((origin) => ({
      origin: origin.origin,
      localStorage: origin.localStorage ?? [],
    })) ?? [],
  };
}

async function createAuthenticatedContext(authFile: AuthFileRef, headless: boolean): Promise<{ browser: Awaited<ReturnType<typeof chromium.launch>>; context: BrowserContext }> {
  const browser = await chromium.launch({ headless });
  const contextOptions: BrowserContextOptions = {
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1440, height: 960 },
  };

  const context = authFile.kind === "storage-state"
    ? await browser.newContext({
        ...contextOptions,
        storageState: loadStorageStateFile(authFile.path),
      })
    : await browser.newContext(contextOptions);

  if (authFile.kind === "cookie") {
    await context.addCookies(loadCookieFile(authFile.path));
  }

  return { browser, context };
}

async function safePageText(page: Page, selector: string): Promise<string> {
  return page.locator(selector).innerText().then((value) => value.slice(0, 1500)).catch(() => "");
}

async function snapshotFallbackState(page: Page): Promise<PageFallbackState | undefined> {
  return page.evaluate(() => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const visibleText = (element: Element): string => normalize((element.textContent ?? "").trim());

    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4"))
      .map((element) => visibleText(element))
      .filter(Boolean)
      .slice(0, 20);

    const tables = Array.from(document.querySelectorAll("table"))
      .map((table) => {
        const headerCells = Array.from(table.querySelectorAll("thead th, tr th"))
          .map((element) => visibleText(element))
          .filter(Boolean);
        const rows = Array.from(table.querySelectorAll("tbody tr"))
          .map((row) => Array.from(row.querySelectorAll("td"))
            .map((cell) => visibleText(cell))
            .filter((value) => value.length > 0))
          .filter((row) => row.length > 0)
          .slice(0, 100);

        return { headers: headerCells, rows };
      })
      .filter((item) => item.headers.length > 0 || item.rows.length > 0)
      .slice(0, 10);

    const cards = Array.from(document.querySelectorAll("div, li, span, p"))
      .map((element) => visibleText(element))
      .filter((text) => text.length >= 2 && text.length <= 40 && /\d/.test(text))
      .slice(0, 200)
      .map((text) => ({ text }));

    return headings.length > 0 || tables.length > 0 || cards.length > 0
      ? { headings, tables, cards }
      : undefined;
  }).catch(() => undefined);
}

function shouldCapture(response: Response, pageType: ConcretePageType): boolean {
  const url = response.url().toLowerCase();
  const requestType = response.request().resourceType();
  if (requestType !== "xhr" && requestType !== "fetch") return false;
  if (!url.includes("csdn.net")) return false;
  return CAPTURE_KEYWORDS[pageType].some((item) => url.includes(item));
}

async function safeParseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers()["content-type"] || "";
  if (contentType.includes("application/json") || contentType.includes("text/json")) {
    try {
      return await response.json();
    } catch {
      try {
        return { parseError: "response.json failed", fallbackText: await response.text() };
      } catch (error) {
        return {
          parseError: "response body unavailable",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    return {
      parseError: "response body unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function collectSessionInfo(authFile: AuthFileRef, headless: boolean, timeoutMs: number): Promise<SessionInfo> {
  const { browser, context } = await createAuthenticatedContext(authFile, headless);
  const page = await context.newPage();

  await page.goto(CREATOR_HOME_URL, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);

  const finalUrl = page.url();
  const pageTitle = await page.title().catch(() => "");
  const bodyPreview = await safePageText(page, "body");

  await context.close();
  await browser.close();

  return { finalUrl, pageTitle, bodyPreview };
}

function formatShanghaiDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
  }).format(date);
}

export function resolveAnalyticsRange(start?: string, end?: string): AnalyticsRange {
  if (start && end) {
    return {
      start,
      end,
      startTimestamp: Math.floor(new Date(`${start}T00:00:00+08:00`).getTime() / 1_000),
      endTimestamp: Math.floor(new Date(`${end}T23:59:59+08:00`).getTime() / 1_000),
    };
  }

  const now = Date.now();
  const startDate = new Date(now - 7 * 86_400_000);
  const endDate = new Date(now - 86_400_000);
  return {
    start: formatShanghaiDate(startDate),
    end: formatShanghaiDate(endDate),
    startTimestamp: Math.floor(startDate.getTime() / 1_000),
    endTimestamp: Math.floor(endDate.getTime() / 1_000),
  };
}

function extractRecentArticlesFromResponses(responses: CapturedResponse[]): RecentArticleRef[] {
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const response = responses[index];
    if (!response.url.includes("/single-article-list")) continue;
    const payload = response.payload as {
      data?: {
        list?: Array<Record<string, unknown>>;
      };
    } | undefined;
    const list = payload?.data?.list;
    if (!Array.isArray(list)) continue;
    const recentArticles: Array<RecentArticleRef | undefined> = list
      .map((item) => {
        const articleId = item.articleId;
        if (typeof articleId !== "string" && typeof articleId !== "number") {
          return undefined;
        }
        return {
          articleId: String(articleId),
        } satisfies RecentArticleRef;
      });
    return recentArticles.filter((item): item is RecentArticleRef => item !== undefined);
  }

  return [];
}

async function captureRecentArticleDetails(page: Page, responses: CapturedResponse[], _range: AnalyticsRange): Promise<void> {
  const recentArticles = extractRecentArticlesFromResponses(responses).slice(0, 5);
  for (const [index, article] of recentArticles.entries()) {
    const waitForStatistics = page.waitForResponse((response) => {
      return response.url().includes("/single-article-statistics")
        && response.url().includes(`articleId=${article.articleId}`)
        && response.ok();
    }, { timeout: 15_000 }).catch(() => undefined);

    const waitForQualityScore = page.waitForResponse((response) => {
      return response.url().includes("/quality-score-list")
        && response.url().includes(`articleId=${article.articleId}`)
        && response.ok();
    }, { timeout: 15_000 }).catch(() => undefined);

    await page.locator(".btn-single-operate").nth(index).click({ timeout: 5_000 });
    await Promise.all([waitForStatistics, waitForQualityScore]);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);

    const closeButton = page.locator(".article-drawer .el-icon-close").first();
    if (await ensureVisible(closeButton)) {
      await closeButton.click({ timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(300);
    }
  }
}

async function crawlSinglePage(pageType: ConcretePageType, authFile: AuthFileRef, timeoutMs: number, headless: boolean, range: AnalyticsRange): Promise<CrawlResult> {
  const { browser, context } = await createAuthenticatedContext(authFile, headless);
  const page = await context.newPage();
  const responses: CapturedResponse[] = [];

  page.on("response", async (response) => {
    if (!shouldCapture(response, pageType)) return;
    const payload = await safeParseResponse(response);
    responses.push({
      pageType,
      url: response.url(),
      status: response.status(),
      contentType: response.headers()["content-type"] || "",
      capturedAt: new Date().toISOString(),
      payload,
    });
  });

  await page.goto(PAGE_URLS[pageType], { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);

  if (pageType === "analytics") {
    await captureRecentArticleDetails(page, responses, range);
    await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);
  }

  const finalUrl = page.url();
  const pageTitle = await page.title().catch(() => "");
  const bodyPreview = await safePageText(page, "body");
  const fallbackState = await snapshotFallbackState(page);

  await context.close();
  await browser.close();

  return {
    pageType,
    targetUrl: PAGE_URLS[pageType],
    finalUrl,
    pageTitle,
    bodyPreview,
    responses,
    fallbackState,
  };
}

export async function inspectCreatorSession(authFile: AuthFileRef, headless: boolean, timeoutMs: number): Promise<SessionInfo> {
  return collectSessionInfo(authFile, headless, timeoutMs);
}

export function detectLoginIssue(items: Array<Pick<CrawlResult, "finalUrl" | "pageTitle" | "bodyPreview">>): string | null {
  for (const item of items) {
    const haystack = `${item.finalUrl}\n${item.pageTitle ?? ""}\n${item.bodyPreview ?? ""}`;
    if (item.finalUrl.includes("passport.csdn.net") || LOGIN_HINTS.some((hint) => haystack.includes(hint))) {
      return `Detected login page or expired auth state: ${item.finalUrl}`;
    }
  }
  return null;
}

export async function crawlAnalytics(options: CrawlOptions): Promise<CrawlResult[]> {
  const results: CrawlResult[] = [];
  const range = resolveAnalyticsRange(options.start, options.end);
  for (const pageType of options.pageTypes) {
    results.push(await crawlSinglePage(pageType, options.authFile, options.timeoutMs, options.headless, range));
  }
  return results;
}

async function ensureVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function fillLocator(locator: Locator, value: string): Promise<boolean> {
  if (!(await ensureVisible(locator))) return false;
  try {
    await locator.click({ timeout: 1_000 });
  } catch {
    return false;
  }

  try {
    await locator.fill(value, { timeout: 1_500 });
    return true;
  } catch {
    try {
      await locator.evaluate((element, text) => {
        const node = element as any;
        if (typeof node.focus === "function") node.focus();
        if ("value" in node) {
          node.value = text;
          node.dispatchEvent(new Event("input", { bubbles: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
        if (node.isContentEditable) {
          node.textContent = text;
          node.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }, value);
      return true;
    } catch {
      return false;
    }
  }
}

async function typeInEditor(page: Page, content: string): Promise<boolean> {
  const markdownEditor = page.locator("pre.editor__inner[contenteditable='true']").first();
  if (await ensureVisible(markdownEditor)) {
    try {
      await markdownEditor.click({ timeout: 1_500 });
      await page.keyboard.press("Control+A").catch(() => undefined);
      await page.keyboard.press("Backspace").catch(() => undefined);
      await page.keyboard.insertText(content);
      return true;
    } catch {
      try {
        await markdownEditor.evaluate((element, text) => {
          element.textContent = text;
          element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
        }, content);
        return true;
      } catch {
        // Fall through to other editor strategies.
      }
    }
  }

  const ckeditorFrame = page.locator("iframe.cke_wysiwyg_frame").first();
  if (await ensureVisible(ckeditorFrame)) {
    try {
      const frame = await ckeditorFrame.elementHandle();
      const contentFrame = await frame?.contentFrame();
      const body = contentFrame?.locator("body[contenteditable='true']").first();
      if (body && await ensureVisible(body)) {
        await body.click({ timeout: 1_500 });
        await body.evaluate((element) => {
          element.innerHTML = "";
        });
        await page.keyboard.press("Control+A").catch(() => undefined);
        await page.keyboard.insertText(content);
        return true;
      }
    } catch {
      // Fall through to other editor strategies.
    }
  }

  const selectors = [
    ".monaco-editor textarea",
    ".CodeMirror textarea",
    ".cm-editor textarea",
    ".cm-content[contenteditable='true']",
    "textarea[data-testid='markdown-editor']",
    "textarea[placeholder*='Markdown']",
    "textarea",
    "[contenteditable='true']",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await ensureVisible(locator))) continue;
    try {
      await locator.click({ timeout: 1_500 });
      await page.keyboard.press("Control+A").catch(() => undefined);
      await page.keyboard.insertText(content);
      return true;
    } catch {
      if (await fillLocator(locator, content)) {
        return true;
      }
    }
  }

  return false;
}

async function clickButtonByPattern(page: Page, patterns: RegExp[]): Promise<boolean> {
  for (const pattern of patterns) {
    const button = page.getByRole("button", { name: pattern }).first();
    if (await ensureVisible(button)) {
      await button.click({ timeout: 1_500 });
      return true;
    }

    const textTarget = page.locator("button, a, span, div").filter({ hasText: pattern }).first();
    if (await ensureVisible(textTarget)) {
      await textTarget.click({ timeout: 1_500 });
      return true;
    }
  }
  return false;
}

async function fillTitle(page: Page, value: string): Promise<boolean> {
  const selectors = [
    "input.article-bar__title",
    "input.article-bar__title--input",
    "#txtTitle",
    "textarea#txtTitle",
    "input[placeholder*='请输入文章标题']",
    "textarea[placeholder*='请输入文章标题']",
    "textarea[placeholder*='文章标题']",
    "textarea.input__title",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await ensureVisible(locator))) continue;
    if (await fillLocator(locator, value)) {
      return true;
    }
  }

  return fillByKeywords(page, ["请输入文章标题", "文章标题", "标题"], value);
}

async function fillByKeywords(page: Page, keywords: string[], value: string): Promise<boolean> {
  const selectors: string[] = [];
  for (const keyword of keywords) {
    selectors.push(
      `input[placeholder*='${keyword}']`,
      `textarea[placeholder*='${keyword}']`,
      `[contenteditable='true'][data-placeholder*='${keyword}']`,
      `[contenteditable='true'][placeholder*='${keyword}']`,
      `[role='textbox'][aria-label*='${keyword}']`,
      `input[aria-label*='${keyword}']`,
    );
  }

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await fillLocator(locator, value)) {
      return true;
    }
  }

  return false;
}

async function chooseCategory(page: Page, category: string): Promise<boolean> {
  const selectors = [
    "input[placeholder*='分类']",
    "[role='combobox'][aria-label*='分类']",
    "input[placeholder*='频道']",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await ensureVisible(locator))) continue;
    try {
      await locator.click({ timeout: 1_000 });
      await locator.fill(category, { timeout: 1_000 }).catch(async () => {
        await page.keyboard.insertText(category);
      });
      const option = page.locator("li, div[role='option'], .option, .dropdown-item").filter({ hasText: new RegExp(category) }).first();
      if (await ensureVisible(option)) {
        await option.click({ timeout: 1_000 });
      } else {
        await page.keyboard.press("Enter").catch(() => undefined);
      }
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

function looksSuccessful(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const source = payload as Record<string, unknown>;
  if (source.success === true) return true;
  if (source.code === 0 || source.code === 200) return true;
  if (typeof source.msg === "string" && /成功/.test(source.msg)) return true;
  if (typeof source.message === "string" && /成功/.test(source.message)) return true;
  return false;
}

function isDraftSaveUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes("/blog-console-api/v1/postedit/savearticle")
    || lower.includes("/blog-console-api/v3/mdeditor/savearticle");
}

function isDraftSavePayload(payload: unknown): payload is Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const source = payload as Record<string, unknown>;
  if (source.code !== 200) return false;
  const data = source.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  const articleId = record.article_id ?? record.articleId ?? record.id;
  const articleUrl = record.url ?? record.articleUrl;
  return (typeof articleId === "number" || typeof articleId === "string")
    && typeof articleUrl === "string"
    && /^https?:\/\//.test(articleUrl);
}

function walkNode(node: unknown, visit: (value: unknown) => void): void {
  visit(node);
  if (Array.isArray(node)) {
    for (const item of node) {
      walkNode(item, visit);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) {
      walkNode(value, visit);
    }
  }
}

function extractPublishInfo(responses: Array<{ url: string; status: number; payload: unknown }>): { articleId?: string; articleUrl?: string; message?: string; success: boolean } {
  let articleId: string | undefined;
  let articleUrl: string | undefined;
  let message: string | undefined;
  let success = false;

  for (const response of responses) {
    if (isDraftSaveUrl(response.url) && isDraftSavePayload(response.payload)) {
      const data = response.payload.data as Record<string, unknown>;
      articleId = String(data.article_id ?? data.articleId ?? data.id);
      articleUrl = String(data.url ?? data.articleUrl);
      message = typeof response.payload.msg === "string"
        ? response.payload.msg
        : typeof response.payload.message === "string"
          ? response.payload.message
          : message;
      success = true;
      continue;
    }

    if (looksSuccessful(response.payload)) {
      success = true;
    }
    walkNode(response.payload, (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const source = value as Record<string, unknown>;
      if (!articleId) {
        const candidate = source.articleId ?? source.article_id ?? source.blogId ?? source.id;
        if (typeof candidate === "string" || typeof candidate === "number") {
          articleId = String(candidate);
        }
      }
      if (!articleUrl) {
        const candidate = source.articleUrl ?? source.url ?? source.link;
        if (typeof candidate === "string" && /^https?:\/\//.test(candidate)) {
          articleUrl = candidate;
        }
      }
      if (!message) {
        const candidate = source.msg ?? source.message;
        if (typeof candidate === "string" && candidate.trim()) {
          message = candidate.trim();
        }
      }
    });
  }

  return { articleId, articleUrl, message, success };
}

async function maybeFillMetadata(page: Page, article: ArticleInput, warnings: string[]): Promise<void> {
  const isMarkdownEditor = page.url().includes("editor.csdn.net/md");

  if (article.summary) {
    if (isMarkdownEditor) {
      warnings.push("Markdown 编辑器页未提供摘要输入框，摘要需要在后续手动发布流程中补充。");
    } else {
      const filledSummary = await fillByKeywords(page, ["摘要", "简介", "描述"], article.summary);
      if (!filledSummary) {
        warnings.push("未定位到摘要输入框，摘要可能需要手动补充。");
      }
    }
  }

  if (article.category) {
    if (isMarkdownEditor) {
      warnings.push(`Markdown 编辑器页未提供分类选择器，分类 ${article.category} 需要在后续手动发布流程中补充。`);
    } else {
      const filledCategory = await chooseCategory(page, article.category);
      if (!filledCategory) {
        warnings.push(`未定位到分类选择器，分类 ${article.category} 可能需要手动补充。`);
      }
    }
  }

  if (article.tags.length > 0) {
    warnings.push(`已跳过自动填充标签：${article.tags.join(", ")}。请在 CSDN 草稿页手动确认后再发布。`);
  }

  if (article.original !== undefined) {
    warnings.push("已跳过自动处理原创/转载设置。请在手动发布前确认版权声明。");
  }
}

async function dismissEditorOverlays(page: Page): Promise<void> {
  const introButton = page.getByRole("button", { name: /我知道了/ }).first();
  if (await ensureVisible(introButton)) {
    await introButton.click({ timeout: 1_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }

  const sideCloseButton = page.locator(".side-title__button_close").first();
  if (await ensureVisible(sideCloseButton)) {
    await sideCloseButton.click({ timeout: 1_000 }).catch(() => undefined);
  }
}

function isDraftRelatedUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return ["draft", "save", "article", "blog"].some((token) => lower.includes(token));
}

async function findDraftSuccessText(page: Page): Promise<string | undefined> {
  const successTexts = ["草稿保存成功", "保存成功"];
  for (const text of successTexts) {
    const locator = page.getByText(text).first();
    if (await ensureVisible(locator)) {
      return text;
    }
  }
  return undefined;
}

async function submitDraft(page: Page, timeoutMs: number): Promise<{ success: boolean; message?: string }> {
  const clicked = await clickButtonByPattern(page, [/^保存草稿$/, /保存草稿/, /^草稿$/]);
  if (!clicked) {
    throw new Error("Draft button not found. Try running with --headful and inspect the current editor layout.");
  }

  const responseMatched = await page.waitForResponse(async (response) => {
    if (!isDraftSaveUrl(response.url())) return false;
    if (!response.ok()) return false;
    const payload = await safeParseResponse(response);
    return isDraftSavePayload(payload);
  }, { timeout: Math.min(timeoutMs, 15_000) }).then(() => true).catch(() => false);

  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForTimeout(1_500);
  const message = await findDraftSuccessText(page);

  return {
    success: responseMatched,
    message,
  };
}

export async function publishArticle(request: PublishRequest): Promise<PublishResult> {
  const { browser, context } = await createAuthenticatedContext(request.authFile, request.headless);
  const page = await context.newPage();
  const capturedResponses: Array<{ url: string; status: number; payload: unknown }> = [];
  const warnings: string[] = [];

  page.on("response", async (response) => {
    const url = response.url().toLowerCase();
    if (!url.includes("csdn.net")) return;
    if (!["xhr", "fetch"].includes(response.request().resourceType())) return;
    if (!["article", "blog", "save", "publish", "draft"].some((token) => url.includes(token))) return;
    capturedResponses.push({
      url: response.url(),
      status: response.status(),
      payload: await safeParseResponse(response),
    });
  });

  await page.goto(EDITOR_URL, { waitUntil: "domcontentloaded", timeout: request.timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: request.timeoutMs }).catch(() => undefined);
  await dismissEditorOverlays(page);

  const loginIssue = detectLoginIssue([{
    finalUrl: page.url(),
    pageTitle: await page.title().catch(() => ""),
    bodyPreview: await safePageText(page, "body"),
  }]);
  if (loginIssue) {
    await context.close();
    await browser.close();
    throw new Error(loginIssue);
  }

  const titleFilled = await fillTitle(page, request.article.title || "");
  if (!titleFilled) {
    await context.close();
    await browser.close();
    throw new Error("Title input not found in CSDN editor.");
  }

  const bodyFilled = await typeInEditor(page, request.article.body);
  if (!bodyFilled) {
    await context.close();
    await browser.close();
    throw new Error("Markdown editor input not found in CSDN editor.");
  }

  await maybeFillMetadata(page, request.article, warnings);
  const draftResult = await submitDraft(page, request.timeoutMs);

  const info = extractPublishInfo(capturedResponses);
  const finalUrl = page.url();

  await context.close();
  await browser.close();

  return {
    generatedAt: new Date().toISOString(),
    mode: request.mode,
    title: request.article.title || "",
    summary: request.article.summary,
    category: request.article.category,
    tags: request.article.tags,
    original: request.article.original,
    finalUrl,
    articleId: info.articleId,
    articleUrl: info.articleUrl,
    success: draftResult.success,
    message: draftResult.message || info.message || (draftResult.success ? "草稿保存成功" : "未检测到明确的草稿保存成功信号"),
    warnings,
    capturedResponses,
  };
}


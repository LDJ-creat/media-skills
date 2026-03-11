import fs from "node:fs";
import type { BrowserContextOptions, Cookie, Response } from "playwright";
import { chromium } from "playwright";
import {
  getContentAnalysisUrl,
  getUserAnalysisUrl,
  normalizeDate,
} from "./common";
import type {
  AuthFileRef,
  CapturedResponse,
  ConcretePageType,
  CookieFileEntry,
  CrawlResult,
  MetricPoint,
  StorageStateFile,
} from "./types";

interface CrawlOptions {
  authFile: AuthFileRef;
  pageTypes: ConcretePageType[];
  token?: string;
  timeoutMs: number;
  headless: boolean;
}

type NormalizedStorageState = Exclude<BrowserContextOptions["storageState"], string | undefined>;

interface AuthSessionInfo {
  finalUrl: string;
  pageTitle: string;
  bodyPreview: string;
  token?: string;
}

const KEYWORDS: Record<ConcretePageType, string[]> = {
  content: [
    "appmsganalysis",
    "appmsg",
    "article",
    "read_num",
    "int_page_read",
  ],
  user: [
    "useranalysis",
    "user_summary",
    "user_source",
    "new_user",
    "cancel_user",
  ],
};

function normalizeCookie(input: CookieFileEntry): Cookie {
  const cookie: Cookie = {
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

  return cookie;
}

function loadCookieFile(cookiePath: string): Cookie[] {
  const raw = fs.readFileSync(cookiePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Cookie JSON must be an array of cookie objects");
  }

  const cookies: Cookie[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || !item) continue;
    const candidate = item as Partial<CookieFileEntry>;
    if (!candidate.name || !candidate.value || !candidate.domain) continue;
    cookies.push(normalizeCookie(candidate as CookieFileEntry));
  }

  if (cookies.length === 0) {
    throw new Error("No valid cookie entries found in cookie JSON");
  }

  return cookies;
}

function loadStorageStateFile(storageStatePath: string): NormalizedStorageState {
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

function createContextWithAuth(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  contextOptions: BrowserContextOptions,
  authFile: AuthFileRef,
) {
  if (authFile.kind === "storage-state") {
    return browser.newContext({
      ...contextOptions,
      storageState: loadStorageStateFile(authFile.path),
    });
  }

  return browser.newContext(contextOptions);
}

async function applyCookieAuth(context: Awaited<ReturnType<typeof chromium.launch>> extends never ? never : any, authFile: AuthFileRef): Promise<void> {
  if (authFile.kind !== "cookie") return;
  const cookies = loadCookieFile(authFile.path);
  await context.addCookies(cookies);
}

function extractTokenFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("token") ?? undefined;
  } catch {
    return undefined;
  }
}

async function inspectAuthSession(
  contextOptions: BrowserContextOptions,
  authFile: AuthFileRef,
  headless: boolean,
  timeoutMs: number,
): Promise<AuthSessionInfo> {
  const browser = await chromium.launch({ headless });
  const context = await createContextWithAuth(browser, contextOptions, authFile);
  await applyCookieAuth(context, authFile);
  const page = await context.newPage();

  await page.goto("https://mp.weixin.qq.com/", { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);

  const finalUrl = page.url();
  const pageTitle = await page.title().catch(() => "");
  const bodyPreview = await page.locator("body").innerText().then((text) => text.slice(0, 1000)).catch(() => "");
  const token = extractTokenFromUrl(finalUrl);

  await context.close();
  await browser.close();

  return { finalUrl, pageTitle, bodyPreview, token };
}

function shouldCapture(response: Response, pageType: ConcretePageType): boolean {
  const url = response.url().toLowerCase();
  const requestType = response.request().resourceType();
  if (requestType !== "xhr" && requestType !== "fetch") return false;
  if (!url.includes("mp.weixin.qq.com")) return false;

  return KEYWORDS[pageType].some((token) => url.includes(token));
}

async function safeParseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers()["content-type"] || "";

  if (contentType.includes("application/json") || contentType.includes("text/json")) {
    try {
      return await response.json();
    } catch {
      return { parseError: "response.json failed", fallbackText: await response.text() };
    }
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function findLikelyDataByWindowState(input: unknown): unknown {
  if (!input || typeof input !== "object") return undefined;
  const source = input as Record<string, unknown>;
  const keys = Object.keys(source);
  const matched: Record<string, unknown> = {};

  for (const key of keys) {
    const lower = key.toLowerCase();
    if (lower.includes("analysis") || lower.includes("chart") || lower.includes("summary") || lower.includes("trend")) {
      matched[key] = source[key];
    }
  }

  return Object.keys(matched).length > 0 ? matched : undefined;
}

async function crawlSinglePage(
  pageType: ConcretePageType,
  contextOptions: BrowserContextOptions,
  authFile: AuthFileRef,
  token: string | undefined,
  timeoutMs: number,
  headless: boolean,
  resolvedToken: string | undefined,
): Promise<CrawlResult> {
  const browser = await chromium.launch({ headless });
  const context = await createContextWithAuth(browser, contextOptions, authFile);
  const page = await context.newPage();

  await applyCookieAuth(context, authFile);

  const activeToken = resolvedToken ?? token;
  const targetUrl = pageType === "content" ? getContentAnalysisUrl(activeToken) : getUserAnalysisUrl(activeToken);

  const responses: CapturedResponse[] = [];
  page.on("response", async (response: Response) => {
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

  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);

  const finalUrl = page.url();
  const pageTitle = await page.title().catch(() => "");
  const bodyPreview = await page.locator("body").innerText()
    .then((text) => text.slice(0, 1000))
    .catch(() => "");

  const fallbackState = await page.evaluate(() => {
    const win = window as unknown as Record<string, unknown>;
    const subset: Record<string, unknown> = {};

    for (const key of Object.keys(win)) {
      const lower = key.toLowerCase();
      if (lower.includes("analysis") || lower.includes("chart") || lower.includes("summary") || lower.includes("trend")) {
        subset[key] = win[key];
      }
    }

    return subset;
  }).catch(() => undefined);

  await context.close();
  await browser.close();

  return {
    pageType,
    targetUrl,
    finalUrl,
    resolvedToken: activeToken,
    pageTitle,
    bodyPreview,
    responses,
    fallbackState: findLikelyDataByWindowState(fallbackState),
  };
}

function walkNode(
  node: unknown,
  visit: (value: unknown, keyPath: string[], parent: unknown) => void,
  keyPath: string[] = [],
  parent: unknown = undefined,
): void {
  visit(node, keyPath, parent);

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      walkNode(node[i], visit, [...keyPath, String(i)], node);
    }
    return;
  }

  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walkNode(v, visit, [...keyPath, k], node);
    }
  }
}

function detectDateFromObject(obj: unknown): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const source = obj as Record<string, unknown>;
  const dateLikeKeys = ["date", "day", "ref_date", "stat_date"];

  for (const key of dateLikeKeys) {
    const value = source[key];
    if (typeof value === "string") {
      return normalizeDate(value);
    }
    if (typeof value === "number") {
      return normalizeDate(String(value));
    }
  }

  return undefined;
}

export function buildMetrics(results: CrawlResult[]): MetricPoint[] {
  const points: MetricPoint[] = [];

  for (const result of results) {
    for (const response of result.responses) {
      walkNode(response.payload, (value, keyPath, parent) => {
        if (typeof value !== "number" || !Number.isFinite(value)) return;

        const leaf = keyPath[keyPath.length - 1] || "value";
        if (["errcode", "ret", "status"].includes(leaf.toLowerCase())) return;

        const date = detectDateFromObject(parent) || "unknown";
        points.push({
          pageType: result.pageType,
          date,
          metric: keyPath.join("."),
          value,
          sourceUrl: response.url,
        });
      });
    }
  }

  return points;
}

export function filterMetricsByDate(
  metrics: MetricPoint[],
  start?: string,
  end?: string,
): MetricPoint[] {
  if (!start && !end) return metrics;

  return metrics.filter((item) => {
    if (item.date === "unknown") return true;
    if (start && item.date < start) return false;
    if (end && item.date > end) return false;
    return true;
  });
}

export async function crawlAnalytics(options: CrawlOptions): Promise<CrawlResult[]> {
  const contextOptions: BrowserContextOptions = {
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  };

  const authSession = await inspectAuthSession(
    contextOptions,
    options.authFile,
    options.headless,
    options.timeoutMs,
  );

  const authText = `${authSession.pageTitle}\n${authSession.bodyPreview}`.toLowerCase();
  if (authText.includes("请重新登录") || authText.includes("relogin") || authText.includes("重新登录")) {
    return options.pageTypes.map((pageType) => ({
      pageType,
      targetUrl: pageType === "content" ? getContentAnalysisUrl(options.token) : getUserAnalysisUrl(options.token),
      finalUrl: authSession.finalUrl,
      resolvedToken: authSession.token,
      pageTitle: authSession.pageTitle,
      bodyPreview: authSession.bodyPreview,
      responses: [],
    }));
  }

  const effectiveToken = authSession.token ?? options.token;

  const results: CrawlResult[] = [];
  for (const pageType of options.pageTypes) {
    const result = await crawlSinglePage(
      pageType,
      contextOptions,
      options.authFile,
      options.token,
      options.timeoutMs,
      options.headless,
      effectiveToken,
    );
    results.push(result);
  }

  return results;
}

export function detectLoginIssue(results: CrawlResult[]): string | null {
  for (const result of results) {
    const url = result.finalUrl.toLowerCase();
    if (url.includes("login") || url.includes("/cgi-bin/readtemplate?t=login")) {
      return `Detected login redirect for ${result.pageType}: ${result.finalUrl}`;
    }

    const text = `${result.pageTitle ?? ""}\n${result.bodyPreview ?? ""}`.toLowerCase();
    if (text.includes("请重新登录") || text.includes("relogin") || text.includes("重新登录")) {
      return `Detected relogin page content for ${result.pageType}: ${result.finalUrl}`;
    }
  }
  return null;
}

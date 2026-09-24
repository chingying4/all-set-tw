import { launchBrowserWithRetry } from "./browser.js";
import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import type {
  FubonsecClient,
  FubonsecConfig,
  FubonsecHolding,
  FubonsecSettlementBalance,
  FubonsecSettlementMovement,
  FubonsecTrade,
} from "@taiwan-fin-hub/connectors";

const ORIGIN = "https://www.fbs.com.tw";
const LOGIN_URL = `${ORIGIN}/Home/index?loginFlag=Y`;
const PRODUCT_OVERVIEW_URL = `${ORIGIN}/order/page_101_1`;
const DOMESTIC_STOCK_URL = `${ORIGIN}/order/page_101_2`;
const OVERSEAS_STOCK_URL = `${ORIGIN}/order/page_101_3`;
const CAPTCHA_KEEP_ALIVE_MS = 90_000;
const CAPTCHA_VALIDITY_MS = 75_000;
const CAPTCHA_IMAGE_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class FubonsecVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FubonsecVerificationRequiredError";
  }
}

export class FubonsecConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "FubonsecConnectionError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class FubonsecBrowserCapacityError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds = 20,
  ) {
    super(message);
    this.name = "FubonsecBrowserCapacityError";
  }
}

export type PreparedFubonsecCaptcha = {
  browserSessionId: string;
  browserSessionExpiresAt: string;
  captchaImage: string;
  captchaDigitCount: number;
};

export type FubonsecBrowserClient = FubonsecClient & {
  close(): Promise<void>;
};

type TableRow = {
  cells: Record<string, string>;
  values: string[];
};

type PageRows = {
  asOfDate?: string;
  rows: TableRow[];
};

export function createFubonsecBrowserClient(
  browser: Fetcher | undefined,
  config: FubonsecConfig,
): FubonsecBrowserClient {
  return new FubonsecBrowserSession(browser, config);
}

export async function prepareFubonsecCaptcha(
  browser: Fetcher | undefined,
  config: FubonsecConfig,
): Promise<PreparedFubonsecCaptcha> {
  requireCredentials(config);
  if (!browser) throw new Error("富邦證券人工驗證需要 BROWSER binding。");

  const browserInstance = await acquireBrowser(
    browser,
    config.browserSessionId,
  );
  const pages = await browserInstance.pages();
  const page = pages[0] ?? (await browserInstance.newPage());
  let preserved = false;
  try {
    await configurePage(page);
    await page.goto(LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const captchaImage = await captureCaptcha(page);
    const sessionId = browserInstance.sessionId();
    await browserInstance.disconnect();
    preserved = true;
    return {
      browserSessionId: sessionId,
      browserSessionExpiresAt: new Date(
        Date.now() + CAPTCHA_VALIDITY_MS,
      ).toISOString(),
      captchaDigitCount: 6,
      captchaImage,
    };
  } catch (error) {
    if (error instanceof FubonsecConnectionError) throw error;
    throw new FubonsecConnectionError("富邦證券驗證碼取得失敗。", error);
  } finally {
    if (!preserved) await closeFubonsecBrowser(browserInstance);
  }
}

class FubonsecBrowserSession implements FubonsecBrowserClient {
  private browserInstance?: Browser;
  private page?: Page;
  private authenticated = false;

  constructor(
    private readonly browser: Fetcher | undefined,
    private readonly config: FubonsecConfig,
  ) {}

  async fetchHoldings(): Promise<FubonsecHolding[]> {
    const page = await this.ensureAuthenticatedPage();
    const holdings = [
      ...rowsToDomesticHoldings(
        await this.fetchRows(page, DOMESTIC_STOCK_URL),
        this.config,
      ),
      ...rowsToOverseasHoldings(
        await this.fetchRows(page, OVERSEAS_STOCK_URL),
        this.config,
      ),
    ];
    if (holdings.length > 0) return holdings;

    return rowsToOverviewHoldings(
      await this.fetchRows(page, PRODUCT_OVERVIEW_URL),
      this.config,
    );
  }

  async fetchTrades(): Promise<FubonsecTrade[]> {
    await this.ensureAuthenticatedPage();
    return [];
  }

  async fetchSettlementBalances(): Promise<FubonsecSettlementBalance[]> {
    await this.ensureAuthenticatedPage();
    return [];
  }

  async fetchSettlementMovements(): Promise<FubonsecSettlementMovement[]> {
    await this.ensureAuthenticatedPage();
    return [];
  }

  async close() {
    if (!this.browserInstance) return;
    await closeFubonsecBrowser(this.browserInstance);
    this.browserInstance = undefined;
    this.page = undefined;
    this.authenticated = false;
  }

  private async ensureAuthenticatedPage() {
    if (this.authenticated && this.page) return this.page;
    requireCredentials(this.config);
    if (!this.browser) throw new Error("富邦證券同步需要 BROWSER binding。");
    if (!this.config.browserSessionId || !this.config.captcha) {
      throw new FubonsecVerificationRequiredError(
        "富邦證券 session 已失效，需要重新取得圖形驗證碼。",
      );
    }
    if (
      !this.config.browserSessionExpiresAt ||
      new Date(this.config.browserSessionExpiresAt) <= new Date()
    ) {
      throw new FubonsecVerificationRequiredError(
        "富邦證券圖形驗證碼已逾時，請重新取得驗證碼。",
      );
    }
    assertCaptcha(this.config.captcha);

    this.browserInstance = await acquireBrowser(
      this.browser,
      this.config.browserSessionId,
    );
    const pages = await this.browserInstance.pages();
    this.page = pages[0] ?? (await this.browserInstance.newPage());
    await submitLogin(this.page, this.config);
    this.authenticated = true;
    return this.page;
  }

  private async fetchRows(page: Page, url: string) {
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
      await assertStillAuthenticated(page);
      return extractTableRows(page);
    } catch (error) {
      if (error instanceof FubonsecVerificationRequiredError) throw error;
      throw new FubonsecConnectionError("富邦證券帳戶頁資料讀取失敗。", error);
    }
  }
}

async function captureCaptcha(page: Page) {
  try {
    await page.waitForFunction(
      () => Boolean(document.querySelector("#authCodeImg, img.verify-image")),
      { timeout: CAPTCHA_IMAGE_TIMEOUT_MS },
    );
    return await page.evaluate(async () => {
      const image = document.querySelector<HTMLImageElement>(
        "#authCodeImg, img.verify-image, img[src*='/Home/ULC']",
      );
      const src = image?.getAttribute("src") || "/Home/ULC";
      const url = new URL(src, window.location.origin);
      url.searchParams.set("_", String(Date.now()));
      const response = await fetch(url.href, {
        cache: "no-store",
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(`captcha request failed: ${response.status}`);
      }
      const blob = await response.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    });
  } catch (error) {
    throw new FubonsecConnectionError(
      "富邦證券登入頁沒有在期限內取得圖形驗證碼。",
      error,
    );
  }
}

async function submitLogin(page: Page, config: FubonsecConfig) {
  let stage = "fill-user-id";
  try {
    await fillLoginField(
      page,
      ["身分證", "身分證字號", "user", "id"],
      config.userId!,
    );
    stage = "fill-password";
    await fillLoginField(
      page,
      ["密碼", "password", "passwd", "pwd"],
      config.password!,
      "password",
    );
    stage = "fill-captcha";
    await fillLoginField(
      page,
      ["驗證碼", "captcha", "authcode"],
      config.captcha!,
    );
    stage = "submit-login-api";
    const result = await page.evaluate(
      async ({ userId, password, captcha }) => {
        const post = async (path: string, body: Record<string, string>) => {
          const response = await fetch(path, {
            method: "POST",
            headers: {
              Accept: "application/json, text/javascript, */*; q=0.01",
              "Content-Type":
                "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
            },
            body: new URLSearchParams(body),
            credentials: "include",
          });
          const text = await response.text();
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            return {
              ok: false,
              stage: path,
              status: response.status,
              result: "",
              message: text.slice(0, 200),
            };
          }
          const record =
            json && typeof json === "object"
              ? (json as Record<string, unknown>)
              : {};
          return {
            ok: response.ok,
            stage: path,
            status: response.status,
            result: typeof record.Result === "string" ? record.Result : "",
            message: typeof record.Message === "string" ? record.Message : "",
            mode: typeof record.Mode === "string" ? record.Mode : "",
          };
        };
        const normalizedUserId = userId.toUpperCase();
        const captchaResult = await post("/Home/VerifyCaptcha", {
          strNo: normalizedUserId,
          pValidateCode: captcha,
        });
        if (!captchaResult.ok || captchaResult.result !== "Y") {
          return captchaResult;
        }
        return post("/Home/Main", {
          strSet: "",
          strNo: normalizedUserId,
          strPass: password,
          pOTP: "",
          mode: "WebCA",
          x: "0",
        });
      },
      {
        userId: config.userId!,
        password: config.password!,
        captcha: config.captcha!,
      },
    );
    classifyLoginApiResult(result);
    stage = "open-account-overview";
    await page.goto(PRODUCT_OVERVIEW_URL, {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });
    stage = "verify-authentication";
    await assertStillAuthenticated(page);
  } catch (error) {
    if (
      error instanceof FubonsecConnectionError ||
      error instanceof FubonsecVerificationRequiredError
    ) {
      throw error;
    }
    const detail = safeFubonsecErrorDetail(error);
    console.error(
      JSON.stringify({
        event: "fubonsec_login_failed",
        connectorId: "fubonsec",
        stage,
        errorName: error instanceof Error ? error.name : typeof error,
        message: detail,
      }),
    );
    throw new FubonsecConnectionError(
      `富邦證券登入流程失敗（${stage}）：${detail}`,
      error,
    );
  }
}

function safeFubonsecErrorDetail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "未知錯誤";
}

function classifyLoginApiResult(result: {
  ok: boolean;
  stage: string;
  status: number;
  result: string;
  message: string;
  mode?: string;
}) {
  if (result.ok && result.stage === "/Home/Main" && result.result === "Y") {
    return;
  }
  const message = result.message || "富邦證券登入失敗。";
  if (result.stage === "/Home/VerifyCaptcha" || /驗證碼/.test(message)) {
    throw new FubonsecVerificationRequiredError(
      `富邦證券圖形驗證碼錯誤或已失效：${message}`,
    );
  }
  if (/OTP|動態密碼|手機|e-?mail/i.test(message) || result.result === "O") {
    throw new FubonsecVerificationRequiredError(
      `富邦證券要求 OTP 動態密碼驗證；目前富邦 connector 尚未支援 OTP 流程。${message ? `（${message}）` : ""}`,
    );
  }
  if (/WebCA|憑證|CA/i.test(message) || result.mode === "WebCA") {
    throw new FubonsecVerificationRequiredError(
      `富邦證券要求 WebCA 憑證驗證；目前富邦 connector 尚未支援憑證驗證。${message ? `（${message}）` : ""}`,
    );
  }
  if (/密碼|帳號|身分證|登入資料|錯誤|失敗|鎖定/.test(message)) {
    throw new FubonsecVerificationRequiredError(
      `富邦證券登入資料遭拒：${message}`,
    );
  }
  throw new FubonsecConnectionError(
    `富邦證券登入回應無法辨識（${result.stage} HTTP ${result.status}, Result=${result.result || "empty"}）。`,
  );
}

async function fillLoginField(
  page: Page,
  hints: string[],
  value: string,
  preferredType?: string,
) {
  const selector = await page.evaluate(
    ({ hints, preferredType }) => {
      const normalize = (text: string | null | undefined) =>
        text?.toLowerCase().replace(/\s+/g, "") ?? "";
      const isVisible = (element: HTMLElement) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const inputs = Array.from(
        document.querySelectorAll<HTMLInputElement>("input"),
      ).filter(
        (input) =>
          !input.disabled &&
          input.type !== "hidden" &&
          input.type !== "checkbox" &&
          input.type !== "radio" &&
          isVisible(input),
      );
      const candidates = preferredType
        ? [
            ...inputs.filter((input) => input.type === preferredType),
            ...inputs.filter((input) => input.type !== preferredType),
          ]
        : inputs;
      const match = candidates.find((input) => {
        const haystack = normalize(
          [
            input.placeholder,
            input.name,
            input.id,
            input.getAttribute("aria-label"),
            input.autocomplete,
          ]
            .filter(Boolean)
            .join(" "),
        );
        return hints.some((hint) => haystack.includes(normalize(hint)));
      });
      if (!match) return undefined;
      match.dataset.fubonsecLoginField = hints[0] ?? "field";
      return `[data-fubonsec-login-field="${CSS.escape(match.dataset.fubonsecLoginField)}"]`;
    },
    { hints, preferredType },
  );
  if (!selector) {
    throw new FubonsecConnectionError("富邦證券登入欄位結構已變更。");
  }
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, value);
}

async function assertStillAuthenticated(page: Page) {
  const loginVisible = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLInputElement>("input")).some(
      (input) => {
        const style = window.getComputedStyle(input);
        const rect = input.getBoundingClientRect();
        return (
          input.type !== "hidden" &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0 &&
          /身分證|密碼|驗證碼/.test(
            [input.placeholder, input.name, input.id].filter(Boolean).join(""),
          )
        );
      },
    ),
  );
  if (loginVisible) {
    throw new FubonsecVerificationRequiredError(
      "富邦證券登入狀態已失效，請重新取得圖形驗證碼。",
    );
  }
}

async function extractTableRows(page: Page): Promise<PageRows> {
  return page.evaluate(() => {
    const text = document.body.innerText ?? "";
    const asOfDate = text.match(/查詢資料時間為[:：]\s*([^\n]+)/)?.[1]?.trim();
    const normalize = (value: string | null | undefined) =>
      value?.replace(/\s+/g, " ").trim() ?? "";
    const rows = Array.from(document.querySelectorAll("table")).flatMap(
      (table) => {
        const tableRows = Array.from(table.querySelectorAll("tr"));
        const headerCells = tableRows.at(0)?.querySelectorAll("th,td");
        const headers = Array.from(headerCells ?? []).map((cell) =>
          normalize(cell.textContent),
        );
        if (headers.length === 0) return [];
        return tableRows.slice(1).flatMap((row) => {
          const values = Array.from(row.querySelectorAll("td")).map((cell) =>
            normalize(cell.textContent),
          );
          if (values.every((value) => !value)) return [];
          const cells: Record<string, string> = {};
          values.forEach((value, index) => {
            const key = headers[index];
            if (key) cells[key] = value;
          });
          return [{ cells, values }];
        });
      },
    );
    return { asOfDate, rows };
  });
}

async function configurePage(page: Page) {
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  });
}

function assertCaptcha(captcha: string) {
  if (!/^\d{6}$/.test(captcha)) {
    throw new FubonsecVerificationRequiredError(
      "富邦證券驗證碼必須是 6 位數字。",
    );
  }
}

function requireCredentials(config: FubonsecConfig) {
  if (!config.userId || !config.account || !config.password) {
    throw new FubonsecVerificationRequiredError(
      "請先儲存富邦證券身分證字號、登入代號與登入密碼。",
    );
  }
}

function rowsToDomesticHoldings(
  pageRows: PageRows,
  config: FubonsecConfig,
): FubonsecHolding[] {
  return pageRows.rows.flatMap((row) => {
    const name = pickCell(row, ["股票名稱", "個股名稱", "商品名稱", "名稱"]);
    const quantity = pickCell(row, [
      "餘額股數",
      "持有股數",
      "今餘額",
      "昨庫存",
    ]);
    if (!name || !quantity || !hasNumericValue(quantity)) return [];
    return [
      {
        accountId: accountId(config),
        brokerName: "富邦證券",
        brokerAccount: config.account,
        symbol:
          pickCell(row, ["股票代號", "股號", "代號"]) ?? symbolFromName(name),
        name: nameWithoutSymbol(name),
        assetType: "stock" as const,
        quantity,
        marketValue: pickCell(row, ["帳面價值", "參考市值", "市值"]),
        currency: "TWD",
        asOfDate: normalizeFubonDate(pageRows.asOfDate),
        raw: row.cells,
      },
    ];
  });
}

function rowsToOverseasHoldings(
  pageRows: PageRows,
  config: FubonsecConfig,
): FubonsecHolding[] {
  return pageRows.rows.flatMap((row) => {
    const name = pickCell(row, ["個股名稱", "股票名稱", "商品名稱", "名稱"]);
    const quantity = pickCell(row, ["持有股數", "股數", "數量"]);
    if (!name || !quantity || !hasNumericValue(quantity)) return [];
    return [
      {
        accountId: accountId(config),
        brokerName: "富邦證券",
        brokerAccount: config.account,
        symbol:
          pickCell(row, ["股票代號", "股號", "代號"]) ?? symbolFromName(name),
        name: nameWithoutSymbol(name),
        assetType: "stock" as const,
        quantity,
        marketValue: pickCell(row, ["參考市值", "市值"]),
        currency: "TWD",
        asOfDate: normalizeFubonDate(pageRows.asOfDate),
        raw: row.cells,
      },
    ];
  });
}

function rowsToOverviewHoldings(
  pageRows: PageRows,
  config: FubonsecConfig,
): FubonsecHolding[] {
  return pageRows.rows.flatMap((row) => {
    const product = pickCell(row, ["國內商品", "國外商品"]);
    const value = pickCell(row, ["參考帳戶價值(TWD)", "參考帳戶價值"]);
    if (!product || !value || !hasNumericValue(value)) return [];
    return [
      {
        accountId: accountId(config),
        brokerName: "富邦證券",
        brokerAccount: config.account,
        name: product,
        assetType: product.includes("基金")
          ? ("fund" as const)
          : ("stock" as const),
        quantity: "1",
        marketValue: value,
        currency: "TWD",
        asOfDate: normalizeFubonDate(
          pickCell(row, ["帳戶日期(資料日期)", "資料日期"]) ??
            pageRows.asOfDate,
        ),
        raw: row.cells,
      },
    ];
  });
}

function pickCell(row: TableRow, labels: string[]) {
  const normalize = (value: string) => value.replace(/\s+/g, "");
  for (const [key, value] of Object.entries(row.cells)) {
    if (labels.some((label) => normalize(key).includes(normalize(label)))) {
      return value || undefined;
    }
  }
  return undefined;
}

function hasNumericValue(value: string) {
  return /[0-9]/.test(value) && Number(value.replace(/[,，\s]/g, "")) !== 0;
}

function symbolFromName(name: string) {
  return name.match(/\b\d{4,6}[A-Z]?\b/)?.[0];
}

function nameWithoutSymbol(name: string) {
  return name.replace(/\b\d{4,6}[A-Z]?\b/g, "").trim() || name;
}

function normalizeFubonDate(value: string | undefined) {
  const fallback = new Date().toISOString().slice(0, 10);
  if (!value) return fallback;
  const match = value.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!match) return fallback;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function accountId(config: FubonsecConfig) {
  return ["fubonsec", config.account ?? config.userId]
    .filter(Boolean)
    .join(":");
}

async function acquireBrowser(browser: Fetcher, preferredSessionId?: string) {
  if (preferredSessionId) {
    const sessions = await puppeteer.sessions(browser).catch(() => []);
    const preferred = sessions.find(
      (session) => session.sessionId === preferredSessionId,
    );
    if (preferred?.connectionId) {
      throw new FubonsecBrowserCapacityError(
        "富邦證券驗證碼正在使用中，請稍候再試。",
        3,
      );
    }
    if (preferred) {
      try {
        return await puppeteer.connect(browser, preferred.sessionId);
      } catch {
        throw new FubonsecBrowserCapacityError(
          "前一個富邦證券驗證工作階段尚未釋放，請稍候再試。",
          3,
        );
      }
    }
  }
  const limits = await puppeteer.limits(browser).catch(() => undefined);
  if (limits && limits.allowedBrowserAcquisitions < 1) {
    throw new FubonsecBrowserCapacityError(
      "Cloudflare 瀏覽器啟動頻率已達上限，請稍後再試。",
      Math.max(
        1,
        Math.ceil(limits.timeUntilNextAllowedBrowserAcquisition / 1000),
      ),
    );
  }
  return launchBrowser(browser);
}

async function launchBrowser(browser: Fetcher): Promise<Browser> {
  try {
    return await launchBrowserWithRetry(browser, {
      keep_alive: CAPTCHA_KEEP_ALIVE_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Browser time limit exceeded for today/i.test(message)) {
      throw new FubonsecBrowserCapacityError(
        "Cloudflare 瀏覽器今日使用額度已用完。",
        60,
      );
    }
    if (/code:\s*429|rate limit exceeded/i.test(message)) {
      throw new FubonsecBrowserCapacityError(
        "Cloudflare 瀏覽器暫時達到使用上限。",
        20,
      );
    }
    throw error;
  }
}

async function closeFubonsecBrowser(browser: Browser) {
  try {
    await browser.close();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "fubonsec_browser_cleanup_failed",
        connectorId: "fubonsec",
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

function bytesToBase64(bytes: Uint8Array | string) {
  if (typeof bytes === "string") return bytes;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

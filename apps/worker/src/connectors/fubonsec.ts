import { launchBrowserWithRetry } from "./browser.js";
import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import type { FubonsecConfig } from "@taiwan-fin-hub/connectors";

const LOGIN_URL = "https://www.fbs.com.tw/Beginner/tradingNote";
const CAPTCHA_KEEP_ALIVE_MS = 150_000;
const CAPTCHA_VALIDITY_MS = 120_000;
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
      captchaDigitCount: 4,
      captchaImage,
    };
  } catch (error) {
    if (error instanceof FubonsecConnectionError) throw error;
    throw new FubonsecConnectionError("富邦證券驗證碼取得失敗。", error);
  } finally {
    if (!preserved) await closeFubonsecBrowser(browserInstance);
  }
}

async function captureCaptcha(page: Page) {
  try {
    await page.waitForSelector('img[src*="/Home/ULC"]', {
      timeout: CAPTCHA_IMAGE_TIMEOUT_MS,
      visible: true,
    });
    const target = await page.$('img[src*="/Home/ULC"]');
    if (!target) throw new Error("captcha image not found");
    const bytes = await target.screenshot({ type: "jpeg" });
    return `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
  } catch (error) {
    throw new FubonsecConnectionError(
      "富邦證券登入頁沒有在期限內取得圖形驗證碼。",
      error,
    );
  }
}

async function configurePage(page: Page) {
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  });
}

function requireCredentials(config: FubonsecConfig) {
  if (!config.userId || !config.account || !config.password) {
    throw new FubonsecVerificationRequiredError(
      "請先儲存富邦證券身分證字號、登入代號與登入密碼。",
    );
  }
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

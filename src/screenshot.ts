import { chromium, type Browser, type Page } from "playwright";
import { capturedPageErrorReason } from "./candidate-validation.js";
import { config } from "./config.js";
import { captureWithScreenshotApi } from "./screenshot-api.js";
import type { WebsiteMetadata } from "./types.js";

async function getMeta(page: Page, selector: string): Promise<string> {
  const value = await page
    .locator(selector)
    .first()
    .getAttribute("content", { timeout: 2500 })
    .catch(() => "");
  return value ?? "";
}

async function getHref(page: Page, selector: string): Promise<string> {
  const value = await page
    .locator(selector)
    .first()
    .getAttribute("href", { timeout: 2500 })
    .catch(() => "");
  return value ?? "";
}

function absoluteUrl(value: string, base: string): string {
  if (!value) return "";
  try {
    return new URL(value, base).toString();
  } catch {
    return "";
  }
}

async function stabilizePage(page: Page): Promise<void> {
  await page.waitForLoadState("load", { timeout: 25000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page
    .evaluate(async () => {
      const fontReady = "fonts" in document ? document.fonts.ready.catch(() => undefined) : Promise.resolve();
      const imageReady = Promise.all(
        Array.from(document.images)
          .slice(0, 80)
          .map((image) => {
            if (image.complete) return Promise.resolve();
            return new Promise<void>((resolve) => {
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener("error", () => resolve(), { once: true });
            });
          }),
      );
      await Promise.race([
        Promise.all([fontReady, imageReady]),
        new Promise((resolve) => setTimeout(resolve, 6000)),
      ]);
    })
    .catch(() => undefined);

  await cleanupBlockingOverlays(page);
  await page.waitForTimeout(900);
}

async function cleanupBlockingOverlays(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const blockerWords = [
        "accept all",
        "accept cookies",
        "cookie",
        "consent",
        "continue",
        "got it",
        "newsletter",
        "privacy",
        "subscribe",
        "we use cookies",
      ];
      const selectorWords = [
        "cookie",
        "consent",
        "onetrust",
        "intercom",
        "crisp",
        "drift",
        "newsletter",
      ];
      const viewportArea = window.innerWidth * window.innerHeight;

      for (const element of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

        const style = window.getComputedStyle(element);
        const isOverlayPosition = style.position === "fixed" || style.position === "sticky";
        if (!isOverlayPosition) continue;

        const text = (element.innerText || element.getAttribute("aria-label") || "").toLowerCase();
        const identity = `${element.id} ${element.className}`.toLowerCase();
        const coversLargeArea = (rect.width * rect.height) / viewportArea > 0.16;
        const looksLikeKnownOverlay = selectorWords.some((word) => identity.includes(word));
        const looksLikeBlockerText = blockerWords.some((word) => text.includes(word));

        if (looksLikeKnownOverlay || (coversLargeArea && looksLikeBlockerText)) {
          element.style.setProperty("display", "none", "important");
          element.style.setProperty("visibility", "hidden", "important");
          element.style.setProperty("opacity", "0", "important");
          element.style.setProperty("pointer-events", "none", "important");
        }
      }
    })
    .catch(() => undefined);
}

export async function captureWebsite(browser: Browser, url: string): Promise<WebsiteMetadata> {
  const viewport = { width: 1440, height: 1100 };
  const page = await browser.newPage({
    viewport,
    deviceScaleFactor: 1,
  });
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => {
    browserErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    page.setDefaultTimeout(2500);
    const response = await page.goto(url, { waitUntil: "load", timeout: 60000 });
    await stabilizePage(page);

    const finalUrl = page.url();
    const contentType = response?.headers()["content-type"] ?? "";
    const statusCode = response?.status() ?? null;
    const title =
      (await getMeta(page, 'meta[property="og:site_name"]')) ||
      (await page.title()) ||
      new URL(finalUrl).hostname.replace(/^www\./, "");
    const description =
      (await getMeta(page, 'meta[name="description"]')) ||
      (await getMeta(page, 'meta[property="og:description"]'));
    const siteName = (await getMeta(page, 'meta[property="og:site_name"]')) || title;
    const canonicalUrl = absoluteUrl(await getHref(page, 'link[rel="canonical"]'), finalUrl) || finalUrl;
    const faviconUrl =
      absoluteUrl(await getHref(page, 'link[rel="icon"]'), finalUrl) ||
      absoluteUrl(await getHref(page, 'link[rel="shortcut icon"]'), finalUrl);
    const visualContext = (await page.evaluate(`(() => {
      const cleanText = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const visibleElements = Array.from(document.querySelectorAll("body *")).filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      });
      const fontFamilies = Array.from(new Set(
        visibleElements
          .slice(0, 160)
          .map((element) => window.getComputedStyle(element).fontFamily.replace(/["']/g, ""))
          .filter(Boolean)
      )).slice(0, 8);
      const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
        .map((element) => cleanText(element.textContent))
        .filter(Boolean)
        .slice(0, 12);
      const visibleText = visibleElements
        .map((element) => cleanText(element.innerText))
        .filter((text) => text.length >= 8 && text.length <= 180)
        .slice(0, 16);
      const bodyStyle = window.getComputedStyle(document.body);

      return {
        viewport: ${JSON.stringify(viewport)},
        fullPageHeight: Math.round(document.documentElement.scrollHeight),
        backgroundColor: bodyStyle.backgroundColor,
        fontFamilies,
        headings,
        visibleText,
        imageCount: document.images.length,
        buttonCount: document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]').length,
        linkCount: document.links.length,
      };
    })()`)) as WebsiteMetadata["visualContext"];
    const preflightErrorReason = capturedPageErrorReason({
      statusCode,
      title: title.trim(),
      browserErrors,
      visualContext,
    });

    const playwrightScreenshot = async () => {
      const thumbnail = await page.screenshot({
        type: "jpeg",
        quality: 82,
        fullPage: false,
        animations: "disabled",
        timeout: 15000,
      });
      const fullPage = await page.screenshot({
        type: "jpeg",
        quality: 78,
        fullPage: true,
        animations: "disabled",
        timeout: 20000,
      });

      return {
        thumbnail,
        fullPage,
        mimeType: "image/jpeg" as const,
      };
    };

    let screenshot: WebsiteMetadata["screenshot"];
    const shouldUseScreenshotApi =
      !preflightErrorReason && config.screenshotProvider !== "playwright" && config.screenshotApiKey.trim().length > 0;

    if (shouldUseScreenshotApi) {
      try {
        screenshot = await captureWithScreenshotApi(config.screenshotApiKey, finalUrl);
      } catch (error) {
        console.warn(
          `ScreenshotAPI failed for ${finalUrl}; falling back to Playwright: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        screenshot = await playwrightScreenshot();
      }
    } else {
      screenshot = await playwrightScreenshot();
    }

    if (config.screenshotProvider === "screenshotapi" && !config.screenshotApiKey.trim()) {
      console.warn("SCREENSHOT_PROVIDER=screenshotapi but SCREENSHOTAPI_API_KEY is missing; using Playwright.");
    }

    return {
      url,
      finalUrl,
      title: title.trim(),
      description: description.trim(),
      siteName: siteName.trim(),
      canonicalUrl,
      faviconUrl,
      contentType,
      statusCode,
      browserErrors: browserErrors.slice(0, 20),
      preflightErrorReason: preflightErrorReason ?? undefined,
      visualContext,
      screenshot,
    };
  } finally {
    await page.close();
  }
}

export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

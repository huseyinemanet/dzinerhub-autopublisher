import { chromium, type Browser, type Page } from "playwright";
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

export async function captureWebsite(browser: Browser, url: string): Promise<WebsiteMetadata> {
  const viewport = { width: 1440, height: 1100 };
  const page = await browser.newPage({
    viewport,
    deviceScaleFactor: 1,
  });

  try {
    page.setDefaultTimeout(2500);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => undefined);

    const finalUrl = page.url();
    const contentType = response?.headers()["content-type"] ?? "";
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
      url,
      finalUrl,
      title: title.trim(),
      description: description.trim(),
      siteName: siteName.trim(),
      canonicalUrl,
      faviconUrl,
      contentType,
      visualContext,
      screenshot: {
        thumbnail,
        fullPage,
        mimeType: "image/jpeg",
      },
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

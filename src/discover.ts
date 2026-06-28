import type { Browser, Page } from "playwright";
import { config } from "./config.js";
import { candidateRejectReason } from "./candidate-validation.js";
import { domainFromUrl, normalizeUrl } from "./slug.js";
import { canonicalUrlKey } from "./url-identity.js";

function host(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

function isBlockedCandidate(url: string, curatorHosts: Set<string>): boolean {
  return Boolean(candidateRejectReason(url, curatorHosts));
}

function uniquePush(list: string[], seen: Set<string>, value: string): void {
  const key = canonicalUrlKey(value) || value;
  if (seen.has(key)) return;
  seen.add(key);
  list.push(value);
}

async function goto(page: Page, url: string): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function anchors(page: Page, baseUrl: string): Promise<string[]> {
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .map((anchor) => anchor.href)
      .filter(Boolean),
  );

  return hrefs
    .map((href) => {
      try {
        const url = new URL(href, baseUrl);
        url.hash = "";
        return url.toString();
      } catch {
        return "";
      }
    })
    .filter((href) => href.startsWith("http"));
}

function looksLikeDetailLink(url: string, sourceHost: string): boolean {
  if (host(url) !== sourceHost) return false;
  const path = new URL(url).pathname.toLowerCase();
  return [
    "/site/",
    "/sites/",
    "/website/",
    "/websites/",
    "/inspiration/",
    "/landing-page/",
    "/showcase/",
    "/gallery/",
    "/design/",
  ].some((needle) => path.includes(needle));
}

async function extractCandidatesFromPage(
  page: Page,
  pageUrl: string,
  curatorHosts: Set<string>,
): Promise<{ candidates: string[]; detailLinks: string[] }> {
  const pageHost = host(pageUrl);
  const hrefs = await anchors(page, pageUrl);
  const candidates: string[] = [];
  const detailLinks: string[] = [];
  const candidateSeen = new Set<string>();
  const detailSeen = new Set<string>();

  for (const href of hrefs) {
    const normalized = normalizeUrl(href);
    if (!isBlockedCandidate(normalized, curatorHosts)) {
      uniquePush(candidates, candidateSeen, normalized);
      continue;
    }
    if (looksLikeDetailLink(normalized, pageHost)) {
      uniquePush(detailLinks, detailSeen, normalized);
    }
  }

  return { candidates, detailLinks };
}

export async function discoverCandidates(browser: Browser, discoveryPages: string[], limit: number): Promise<string[]> {
  const curatorHosts = new Set(discoveryPages.map((url) => domainFromUrl(url)));
  const discovered: string[] = [];
  const seen = new Set<string>();

  for (const source of discoveryPages.slice(0, config.maxDiscoveryPages)) {
    if (discovered.length >= limit) break;

    const sourceUrl = normalizeUrl(source);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    page.setDefaultTimeout(2500);

    try {
      console.log(`Discovering from ${sourceUrl}`);
      if (!(await goto(page, sourceUrl))) continue;

      const firstPass = await extractCandidatesFromPage(page, sourceUrl, curatorHosts);
      for (const candidate of firstPass.candidates) {
        uniquePush(discovered, seen, candidate);
        if (discovered.length >= limit) break;
      }

      for (const detailUrl of firstPass.detailLinks.slice(0, config.maxDetailPagesPerSource)) {
        if (discovered.length >= limit) break;
        if (!(await goto(page, detailUrl))) continue;
        const detailPass = await extractCandidatesFromPage(page, detailUrl, curatorHosts);
        for (const candidate of detailPass.candidates) {
          uniquePush(discovered, seen, candidate);
          if (discovered.length >= limit) break;
        }
      }
    } finally {
      await page.close();
    }
  }

  return discovered;
}

import { z } from "zod";
import type { Browser, Page } from "playwright";
import { config } from "./config.js";
import {
  addStoryItem,
  connectFramer,
  getExistingStorySlugs,
  getExistingStoryUrlKeys,
  getStoriesCollection,
  publishIfRequested,
  uniqueStorySlug,
} from "./framer.js";
import { StoryReportBuilder } from "./report.js";
import { domainFromUrl, normalizeUrl, slugify } from "./slug.js";
import { loadManualSources, loadSourceFile } from "./sources.js";
import type { StoryCandidate, StorySyncSummary } from "./types.js";
import { canonicalUrlKey } from "./url-identity.js";
import { withBrowser } from "./screenshot.js";

const storyClassificationSchema = z.object({
  title: z.string().min(3).max(140),
  description: z.string().max(320).default(""),
  tags: z.array(z.string()).default([]),
  aiComment: z.string().min(20).max(520),
  qualityScore: z.number().min(0).max(1),
  shouldPublish: z.boolean(),
});

const BLOCKED_HOSTS = new Set([
  "accounts.google.com",
  "facebook.com",
  "github.com",
  "google.com",
  "instagram.com",
  "linkedin.com",
  "mailto",
  "reddit.com",
  "twitter.com",
  "vercel.link",
  "x.com",
  "youtube.com",
]);

const BLOCKED_PATH_PARTS = [
  "/account",
  "/advertise",
  "/api/",
  "/auth",
  "/careers",
  "/cdn-cgi/",
  "/contact",
  "/cookie",
  "/events",
  "/jobs",
  "/login",
  "/newsletter",
  "/privacy",
  "/search",
  "/signin",
  "/signup",
  "/sponsor",
  "/terms",
];

const SAME_HOST_NAV_ONLY_SOURCES = new Set([
  "news.ycombinator.com",
]);

function host(rawUrl: string): string {
  return domainFromUrl(rawUrl);
}

function formatTag(tag: string): string {
  const normalized = tag.trim().replace(/\s+/g, " ").toLowerCase();
  const overrides = new Map<string, string>([
    ["ai", "AI"],
    ["ux", "UX"],
    ["ui", "UI"],
    ["saas", "SaaS"],
  ]);

  return normalized
    .split(" ")
    .map((word) => overrides.get(word) ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function compactTags(tags: string[]): string[] {
  return [...new Set(tags.map(formatTag).filter(Boolean))].slice(0, 4);
}

function parseJsonContent(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] ?? content;
  return JSON.parse(source.trim());
}

function isAssetUrl(url: URL): boolean {
  return /\.(avif|css|gif|ico|jpeg|jpg|js|json|mp4|pdf|png|svg|webm|webp|xml)$/i.test(url.pathname);
}

function isUsefulStoryUrl(rawUrl: string, sourceUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (isAssetUrl(url)) return false;
  if (/challenge|security-checkpoint/i.test(`${url.pathname} ${url.search}`)) return false;
  if (canonicalUrlKey(url.toString()) === canonicalUrlKey(sourceUrl)) return false;

  const normalizedHost = host(url.toString());
  if (!normalizedHost || BLOCKED_HOSTS.has(normalizedHost)) return false;
  if (SAME_HOST_NAV_ONLY_SOURCES.has(host(sourceUrl)) && normalizedHost === host(sourceUrl)) return false;

  const path = url.pathname.toLowerCase();
  if (BLOCKED_PATH_PARTS.some((part) => path.includes(part))) return false;

  return true;
}

function uniquePush(list: string[], seen: Set<string>, value: string): void {
  const key = canonicalUrlKey(value);
  if (!key || seen.has(key)) return;
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

async function discoverStoryUrls(browser: Browser, sourceUrls: string[], limit: number): Promise<string[]> {
  const discovered: string[] = [];
  const seen = new Set<string>();

  for (const source of sourceUrls.slice(0, config.maxStoryDiscoveryPages)) {
    if (discovered.length >= limit) break;

    const sourceUrl = normalizeUrl(source);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
    page.setDefaultTimeout(3500);

    try {
      console.log(`Discovering stories from ${sourceUrl}`);
      if (!(await goto(page, sourceUrl))) continue;

      const hrefs = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
          .map((anchor) => anchor.href)
          .filter(Boolean),
      );

      for (const href of hrefs) {
        if (discovered.length >= limit) break;
        try {
          const normalized = normalizeUrl(new URL(href, sourceUrl).toString());
          if (!isUsefulStoryUrl(normalized, sourceUrl)) continue;
          uniquePush(discovered, seen, normalized);
        } catch {
          continue;
        }
      }
    } finally {
      await page.close();
    }
  }

  return discovered;
}

async function readStoryMetadata(browser: Browser, url: string): Promise<{
  finalUrl: string;
  title: string;
  ogTitle: string;
  description: string;
  headings: string[];
  articleText: string[];
  statusCode: number | null;
  visibleText: string[];
}> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(3500);

  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 }).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(500);

    const finalUrl = page.url();
    const title = (await page.title().catch(() => "")).trim();
    const ogTitle = ((await page.locator('meta[property="og:title"]').first().getAttribute("content").catch(() => "")) || "").trim();
    const description =
      (await page.locator('meta[name="description"]').first().getAttribute("content").catch(() => "")) ||
      (await page.locator('meta[property="og:description"]').first().getAttribute("content").catch(() => "")) ||
      "";
    const headings = await page
      .evaluate(() =>
        [...document.querySelectorAll("h1, h2")]
          .map((heading) => heading.textContent?.trim() ?? "")
          .filter((text) => text.length >= 4)
          .slice(0, 10),
      )
      .catch(() => []);
    const articleText = await page
      .evaluate(() =>
        [...document.querySelectorAll("article p, main p, [role='main'] p")]
          .map((paragraph) => paragraph.textContent?.trim() ?? "")
          .filter((text) => text.length >= 60)
          .slice(0, 12),
      )
      .catch(() => []);
    const visibleText = await page
      .evaluate(() =>
        (document.body?.innerText ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length >= 8)
          .slice(0, 32),
      )
      .catch(() => []);

    return {
      finalUrl,
      title,
      ogTitle,
      description: description.trim(),
      headings,
      articleText,
      statusCode: response?.status() ?? null,
      visibleText,
    };
  } finally {
    await page.close();
  }
}

function invalidStoryReason(metadata: Awaited<ReturnType<typeof readStoryMetadata>>): string {
  if (metadata.statusCode && metadata.statusCode >= 400) return `http ${metadata.statusCode}`;
  const text = [
    metadata.title,
    metadata.ogTitle,
    metadata.description,
    ...metadata.headings.slice(0, 4),
    ...metadata.articleText.slice(0, 3),
    ...metadata.visibleText.slice(0, 6),
  ].join(" ").toLowerCase();
  if (!metadata.title && !metadata.description) return "missing title and description";
  if (/access denied|are you human|captcha|enable javascript|just a moment|not found|page unavailable|verify you are human/.test(text)) {
    return "blocked or error page";
  }
  return "";
}

async function classifyStory(args: {
  url: string;
  finalUrl: string;
  sourceUrl: string;
  title: string;
  ogTitle: string;
  description: string;
  headings: string[];
  articleText: string[];
  visibleText: string[];
}): Promise<Omit<StoryCandidate, "slug"> & { shouldPublish: boolean }> {
  if (!config.deepseekApiKey) {
    throw new Error("DEEPSEEK_API_KEY is required for story classification");
  }

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      temperature: 0.25,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You curate links for DzinerHub Stories: design, AI, product, frontend, startup, growth, UX, and creative technology links. Return strict JSON only. Read the page evidence carefully and infer what the link is actually about. Keep it practical, specific, and concise. Do not publish spam, job posts, login pages, generic homepages, events, discounts, or purely promotional pages.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Decide whether this link is worth adding to a daily curated links CMS.",
            requiredShape: {
              title: "clean link title",
              description: "short neutral explanation of what the link is about, max 220 characters",
              tags: ["Design", "AI", "Product", "Frontend"],
              aiComment: "one useful editorial note explaining why this is worth opening, 35-75 words",
              qualityScore: "number from 0 to 1",
              shouldPublish: "boolean",
            },
            sourceUrl: args.sourceUrl,
            link: {
              url: args.finalUrl,
              title: args.title,
              ogTitle: args.ogTitle,
              description: args.description,
              headings: args.headings,
              articleText: args.articleText,
              visibleText: args.visibleText.slice(0, 18),
            },
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek story request failed with ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned an empty story response");

  const parsed = storyClassificationSchema.parse(parseJsonContent(content));

  return {
    sourceUrl: args.sourceUrl,
    url: args.finalUrl,
    finalUrl: args.finalUrl,
    title: parsed.title.trim(),
    description: parsed.description.trim(),
    domain: host(args.finalUrl),
    tags: compactTags(parsed.tags),
    aiComment: parsed.aiComment.trim(),
    qualityScore: parsed.qualityScore,
    shouldPublish: parsed.shouldPublish,
  };
}

async function main(): Promise<void> {
  const report = new StoryReportBuilder();
  const summary: StorySyncSummary = {
    discovered: 0,
    scanned: 0,
    skippedDuplicate: 0,
    skippedInvalid: 0,
    skippedLowQuality: 0,
    failed: 0,
    created: 0,
    dryRun: config.dryRun,
    published: false,
  };

  const framer = await connectFramer();

  try {
    const { collection, fields } = await getStoriesCollection(framer);
    const existingUrlKeys = await getExistingStoryUrlKeys(collection, fields);
    const existingSlugs = await getExistingStorySlugs(collection);
    const sourceFile = await loadSourceFile(config.storySourceFile);
    const manualUrls = await loadManualSources(config.storySourceFile, config.maxStories);
    const discoveredUrls = await withBrowser((browser) =>
      discoverStoryUrls(browser, sourceFile.discoveryPages, config.maxStories * 5),
    );
    const urls = [...discoveredUrls, ...manualUrls];
    const runUrlKeys = new Set<string>();

    summary.discovered = discoveredUrls.length;
    console.log(`Prepared ${urls.length} story candidate URL(s).`);

    await withBrowser(async (browser) => {
      for (const rawUrl of urls) {
        if (summary.created >= config.maxStories) {
          console.log(`Reached MAX_STORIES=${config.maxStories}; stopping.`);
          break;
        }

        const url = normalizeUrl(rawUrl);
        const key = canonicalUrlKey(url);
        if (!key || runUrlKeys.has(key)) continue;
        runUrlKeys.add(key);

        summary.scanned += 1;
        console.log(`Scanning story ${url}`);

        try {
          if (existingUrlKeys.has(key)) {
            summary.skippedDuplicate += 1;
            report.addSkipped(url, "duplicate URL");
            console.log(`Skipped duplicate story: ${url}`);
            continue;
          }

          const metadata = await readStoryMetadata(browser, url);
          const finalKey = canonicalUrlKey(metadata.finalUrl);
          if (finalKey && existingUrlKeys.has(finalKey)) {
            summary.skippedDuplicate += 1;
            report.addSkipped(url, "duplicate final URL");
            console.log(`Skipped duplicate story final URL: ${metadata.finalUrl}`);
            continue;
          }

          const invalidReason = invalidStoryReason(metadata);
          if (invalidReason) {
            summary.skippedInvalid += 1;
            report.addSkipped(url, invalidReason);
            console.log(`Skipped invalid story: ${url} (${invalidReason})`);
            continue;
          }

          const classified = await classifyStory({
            url,
            finalUrl: metadata.finalUrl,
            sourceUrl: url,
            title: metadata.title,
            ogTitle: metadata.ogTitle,
            description: metadata.description,
            headings: metadata.headings,
            articleText: metadata.articleText,
            visibleText: metadata.visibleText,
          });

          if (!classified.title || !classified.shouldPublish || classified.qualityScore < config.minQualityScore) {
            summary.skippedLowQuality += 1;
            report.addSkipped(url, `low quality: ${classified.qualityScore}`);
            console.log(`Skipped low quality story: ${url} (${classified.qualityScore})`);
            continue;
          }

          const candidate: StoryCandidate = {
            ...classified,
            slug: uniqueStorySlug(existingSlugs, slugify(classified.title) || slugify(classified.domain)),
          };

          if (config.dryRun) {
            console.log(JSON.stringify(candidate, null, 2));
          } else {
            await addStoryItem(collection, fields, candidate);
          }

          const candidateKey = canonicalUrlKey(candidate.finalUrl);
          if (candidateKey) existingUrlKeys.add(candidateKey);
          summary.created += 1;
          report.addCreated(candidate);
        } catch (error) {
          summary.failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          report.addFailed(url, message);
          console.error(`Failed story ${url}: ${message}`);
        }
      }
    });

    summary.published = await publishIfRequested(framer, summary.created > 0);
    await report.write(summary);
  } finally {
    await framer.disconnect();
  }

  console.log("Stories summary");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

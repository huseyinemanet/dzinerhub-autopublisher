import { z } from "zod";
import { pathToFileURL } from "node:url";
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

const rawStoryClassificationSchema = z.object({}).catchall(z.unknown());

const BLOCKED_HOSTS = new Set([
  "accounts.google.com",
  "bsky.app",
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

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1).trim()}…`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(record[key]).trim();
    if (value) return value;
  }
  return "";
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(stringValue(value));
  return Number.isFinite(parsed) ? clamp(parsed, 0, 1) : fallback;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "publish", "published"].includes(normalized)) return true;
  if (["0", "false", "no", "skip", "unpublish"].includes(normalized)) return false;
  return null;
}

function tagList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(stringValue).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((tag) => tag.trim()).filter(Boolean);
  return [];
}

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function tinyStoryBlurb(value: string, fallback = "A short link worth a quick look."): string {
  const withoutHype = value
    .replace(/\b(must-read|fascinating|essential|stunning|masterfully|revealing|in-depth|deep dive)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const source = withoutHype || fallback;
  const sentences = source.match(/[^.!?]+[.!?]?/g) ?? [source];
  const sentence =
    sentences
      .map((item) => item.trim())
      .find((item) => item.length > 0 && item.length <= 80) ?? source;

  return ensureSentence(truncate(sentence, 80));
}

function compactTags(tags: string[]): string[] {
  return [...new Set(tags.map(formatTag).filter(Boolean))].slice(0, 4);
}

export function parseJsonContent(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] ?? content;
  const trimmed = source.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!objectMatch) throw new Error("No JSON object found in model response");
    return JSON.parse(objectMatch[0]);
  }
}

export function normalizeStoryClassification(
  value: unknown,
  fallback: {
    title: string;
    ogTitle: string;
    description: string;
    finalUrl: string;
  },
): Omit<StoryCandidate, "sourceUrl" | "url" | "finalUrl" | "domain" | "slug"> & { shouldPublish: boolean } {
  const record = rawStoryClassificationSchema.parse(value);
  const title = truncate(firstString(record, ["title", "name"]) || fallback.ogTitle || fallback.title || host(fallback.finalUrl), 140);
  const description = truncate(firstString(record, ["description", "summary"]) || fallback.description, 90);
  const blurbSource =
    firstString(record, ["aiComment", "blurb", "comment", "note"]) ||
    description ||
    title ||
    "A short link worth a quick look.";
  const qualityScore = numberValue(record.qualityScore ?? record.score, 0);
  const shouldPublish = booleanValue(record.shouldPublish ?? record.publish) ?? Boolean(title && qualityScore >= config.minQualityScore);

  return {
    title,
    description,
    tags: compactTags(tagList(record.tags)),
    aiComment: tinyStoryBlurb(blurbSource),
    qualityScore,
    shouldPublish,
  };
}

function isAssetUrl(url: URL): boolean {
  return /\.(avif|css|gif|ico|jpeg|jpg|js|json|mp4|pdf|png|svg|webm|webp|xml)$/i.test(url.pathname);
}

export function isUsefulStoryUrl(rawUrl: string, sourceUrl = "", options: { rejectSame?: boolean } = {}): boolean {
  if (/^(mailto|tel|javascript):/i.test(rawUrl)) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (isAssetUrl(url)) return false;
  if (/challenge|security-checkpoint/i.test(`${url.pathname} ${url.search}`)) return false;
  if (options.rejectSame !== false && canonicalUrlKey(url.toString()) === canonicalUrlKey(sourceUrl)) return false;

  const normalizedHost = host(url.toString());
  if (!normalizedHost || BLOCKED_HOSTS.has(normalizedHost)) return false;
  if (sourceUrl && SAME_HOST_NAV_ONLY_SOURCES.has(host(sourceUrl)) && normalizedHost === host(sourceUrl)) return false;

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
          if (/^(mailto|tel|javascript):/i.test(href)) continue;
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
            "You curate links for DzinerHub Stories: design, AI, product, frontend, startup, growth, UX, and creative technology links. Return strict JSON only. Read the page evidence carefully and infer what the link is actually about. Keep it practical, specific, and very short. Do not publish spam, job posts, login pages, generic homepages, events, discounts, or purely promotional pages.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Decide whether this link is worth adding to a daily curated links CMS.",
            requiredShape: {
              title: "clean link title",
              description: "very short neutral explanation, 6-14 words, max 90 characters",
              tags: ["Design", "AI", "Product", "Frontend"],
              aiComment: "one tiny display blurb, 6-12 words, max 80 characters. Vary the phrasing. Examples: 'A quick look at AI-assisted medical interpretation.', 'A small essay on software judgment in the AI era.', 'A visual archive of historic menu design.'",
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

  const parsed = normalizeStoryClassification(parseJsonContent(content), {
    title: args.title,
    ogTitle: args.ogTitle,
    description: args.description,
    finalUrl: args.finalUrl,
  });

  return {
    sourceUrl: args.sourceUrl,
    url: args.finalUrl,
    finalUrl: args.finalUrl,
    title: parsed.title,
    description: parsed.description,
    domain: host(args.finalUrl),
    tags: compactTags(parsed.tags),
    aiComment: parsed.aiComment,
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

  const sourceFile = await loadSourceFile(config.storySourceFile);
  const manualUrls = await loadManualSources(config.storySourceFile, config.maxStories);
  const discoveredUrls = await withBrowser((browser) =>
    discoverStoryUrls(browser, sourceFile.discoveryPages, config.maxStories * 5),
  );
  const urls = [...discoveredUrls, ...manualUrls];
  const runUrlKeys = new Set<string>();

  summary.discovered = discoveredUrls.length;
  console.log(`Prepared ${urls.length} story candidate URL(s).`);

  const initialFramer = await connectFramer();
  const { existingUrlKeys, existingSlugs } = await (async () => {
    try {
      const { collection, fields } = await getStoriesCollection(initialFramer);
      return {
        existingUrlKeys: await getExistingStoryUrlKeys(collection, fields),
        existingSlugs: await getExistingStorySlugs(collection),
      };
    } finally {
      await initialFramer.disconnect();
    }
  })();

  await withBrowser(async (browser) => {
    for (const rawUrl of urls) {
      if (summary.created >= config.maxStories) {
        console.log(`Reached MAX_STORIES=${config.maxStories}; stopping.`);
        break;
      }

      let url = "";
      try {
        url = normalizeUrl(rawUrl);
      } catch {
        summary.skippedInvalid += 1;
        report.addSkipped(rawUrl, "invalid URL");
        console.log(`Skipped invalid story URL: ${rawUrl}`);
        continue;
      }

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
          if (!isUsefulStoryUrl(metadata.finalUrl, "", { rejectSame: false })) {
            summary.skippedInvalid += 1;
            report.addSkipped(url, "invalid final URL");
            console.log(`Skipped invalid story final URL: ${metadata.finalUrl}`);
            continue;
          }

          const finalKey = canonicalUrlKey(metadata.finalUrl);
          if (finalKey && runUrlKeys.has(finalKey) && finalKey !== key) {
            summary.skippedDuplicate += 1;
            report.addSkipped(url, "duplicate final URL in this run");
            console.log(`Skipped duplicate story final URL in this run: ${metadata.finalUrl}`);
            continue;
          }

          if (finalKey && existingUrlKeys.has(finalKey)) {
            summary.skippedDuplicate += 1;
            report.addSkipped(url, "duplicate final URL");
            console.log(`Skipped duplicate story final URL: ${metadata.finalUrl}`);
            continue;
          }
          if (finalKey) runUrlKeys.add(finalKey);

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
            const reason = classified.shouldPublish ? `low quality: ${classified.qualityScore}` : "not suitable for Stories";
            report.addSkipped(url, reason);
            console.log(`Skipped story: ${url} (${reason})`);
            continue;
          }

          const candidate: StoryCandidate = {
            ...classified,
            slug: uniqueStorySlug(existingSlugs, slugify(classified.title) || slugify(classified.domain)),
          };

          if (config.dryRun) {
            console.log(JSON.stringify(candidate, null, 2));
          } else {
            const writerFramer = await connectFramer();
            try {
              const { collection, fields } = await getStoriesCollection(writerFramer);
              const latestUrlKeys = await getExistingStoryUrlKeys(collection, fields);
              const latestKey = canonicalUrlKey(candidate.finalUrl);
              if (latestKey && latestUrlKeys.has(latestKey)) {
                summary.skippedDuplicate += 1;
                report.addSkipped(url, "duplicate before write");
                console.log(`Skipped duplicate story before write: ${url}`);
                continue;
              }
              await addStoryItem(collection, fields, candidate);
            } finally {
              await writerFramer.disconnect();
            }
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

  if (summary.created > 0) {
    const publishFramer = await connectFramer();
    try {
      summary.published = await publishIfRequested(publishFramer, true, { throwOnFailure: false });
      if (config.publish && !summary.published) {
        summary.failed += 1;
        report.addFailed("__publish__", "Framer publish failed after retries; final workflow publish step will retry.");
      }
    } finally {
      await publishFramer.disconnect();
    }
  }

  await report.write(summary);

  console.log("Stories summary");
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

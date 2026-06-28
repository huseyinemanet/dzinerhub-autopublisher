import { config } from "./config.js";
import { createAiComment } from "./ai-comment.js";
import { connectFramer, getWebsitesCollection } from "./framer.js";
import type { WebsiteClassification, WebsiteMetadata } from "./types.js";

function optionalNumberEnv(name: string, fallback: number | null = null): number | null {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function fieldId(fields: Map<string, { id: string }>, name: string): string {
  const field = fields.get(name.toLowerCase());
  if (!field) throw new Error(`Missing Framer field: ${name}`);
  return field.id;
}

function optionalFieldId(fields: Map<string, { id: string }>, name: string): string | undefined {
  return fields.get(name.toLowerCase())?.id;
}

function entryValue(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const value = (entry as { value?: unknown }).value;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const nestedUrl = (value as { url?: unknown }).url;
    if (typeof nestedUrl === "string") return nestedUrl;
  }
  return "";
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    url.hash = "";
    url.searchParams.delete("ref");
    return url.toString();
  } catch {
    return "";
  }
}

function textField(value: string) {
  return { type: "string" as const, value };
}

async function downloadImage(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Image download failed with ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function buildMetadata(args: {
  url: string;
  title: string;
  comment: string;
  fullImage: Buffer;
}): WebsiteMetadata {
  return {
    url: args.url,
    finalUrl: args.url,
    title: args.title,
    description: args.comment,
    siteName: args.title,
    canonicalUrl: args.url,
    faviconUrl: "",
    contentType: "text/html",
    statusCode: null,
    browserErrors: [],
    visualContext: {
      viewport: { width: 1500, height: 960 },
      fullPageHeight: 0,
      backgroundColor: "",
      fontFamilies: [],
      headings: [args.title],
      visibleText: [args.comment].filter(Boolean),
      imageCount: 0,
      buttonCount: 0,
      linkCount: 0,
    },
    screenshot: {
      thumbnail: args.fullImage,
      fullPage: args.fullImage,
      mimeType: "image/jpeg",
    },
  };
}

async function main(): Promise<void> {
  if (!config.deepseekApiKey) {
    throw new Error("DEEPSEEK_API_KEY is required");
  }

  const limit = optionalNumberEnv("REFRESH_AI_COMMENT_LIMIT");
  const minLength = optionalNumberEnv("REFRESH_AI_COMMENT_MIN_LENGTH", 360) ?? 360;
  const refreshAll = booleanEnv("REFRESH_AI_COMMENT_ALL", false);
  const onlySlugs = new Set(
    (process.env.REFRESH_AI_COMMENT_SLUGS ?? "")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean),
  );

  const framer = await connectFramer();
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const { collection, fields } = await getWebsitesCollection(framer);
    const items = await collection.getItems();

    const titleFieldId = fieldId(fields, "Title");
    const longTitleFieldId = optionalFieldId(fields, "Long Title");
    const externalLinkFieldId = fieldId(fields, "External Link");
    const categoriesFieldId = fieldId(fields, "Categories");
    const typesFieldId = fieldId(fields, "Types");
    const platformsFieldId = fieldId(fields, "Platforms");
    const stylesFieldId = fieldId(fields, "Styles");
    const typographiesFieldId = fieldId(fields, "Typographies");
    const commentFieldId = fieldId(fields, "Comment");
    const aiCommentFieldId = fieldId(fields, "AI Comment");
    const fullImageFieldId = fieldId(fields, "Full Image");

    console.log(`Found ${items.length} website item(s).`);

    for (const item of items) {
      if (limit && updated >= limit) break;
      if (onlySlugs.size > 0 && !onlySlugs.has(item.slug)) {
        skipped += 1;
        continue;
      }

      const currentAiComment = entryValue(item.fieldData[aiCommentFieldId]);
      if (!refreshAll && currentAiComment.trim().length >= minLength) {
        skipped += 1;
        continue;
      }

      const title = entryValue(item.fieldData[titleFieldId]) || item.slug;
      const longTitle = longTitleFieldId ? entryValue(item.fieldData[longTitleFieldId]) : title;
      const comment = stripHtml(entryValue(item.fieldData[commentFieldId]));
      const externalLink = normalizeUrl(entryValue(item.fieldData[externalLinkFieldId]));
      const fullImageUrl = entryValue(item.fieldData[fullImageFieldId]);

      if (!externalLink || !fullImageUrl) {
        skipped += 1;
        console.log(`Skipped ${title}: missing external link or full image`);
        continue;
      }

      try {
        console.log(`Refreshing AI Comment for ${title}`);
        const fullImage = await downloadImage(fullImageUrl);
        const classification: WebsiteClassification = {
          title,
          longTitle: longTitle || title,
          comment,
          categories: splitTags(entryValue(item.fieldData[categoriesFieldId])),
          types: splitTags(entryValue(item.fieldData[typesFieldId])),
          platforms: splitTags(entryValue(item.fieldData[platformsFieldId])),
          styles: splitTags(entryValue(item.fieldData[stylesFieldId])),
          typographies: splitTags(entryValue(item.fieldData[typographiesFieldId])),
          qualityScore: 1,
          shouldPublish: true,
        };
        const metadata = buildMetadata({ url: externalLink, title, comment, fullImage });
        const aiComment = await createAiComment(metadata, classification);

        await item.setAttributes({
          draft: item.draft,
          fieldData: {
            [aiCommentFieldId]: textField(aiComment),
          },
        });

        updated += 1;
        console.log(`Updated ${title} (${aiComment.length} chars)`);
      } catch (error) {
        failed += 1;
        console.error(`Failed ${title}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await framer.disconnect();
  }

  console.log("AI Comment refresh summary");
  console.log(JSON.stringify({ updated, skipped, failed }, null, 2));

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

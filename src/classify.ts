import { z } from "zod";
import { config } from "./config.js";
import { domainFromUrl } from "./slug.js";
import type { WebsiteClassification, WebsiteMetadata } from "./types.js";

const classificationSchema = z.object({
  title: z.string().min(1),
  longTitle: z.string().min(1),
  comment: z.string().min(1),
  categories: z.array(z.string()).default([]),
  types: z.array(z.string()).default([]),
  platforms: z.array(z.string()).default([]),
  styles: z.array(z.string()).default([]),
  typographies: z.array(z.string()).default([]),
  qualityScore: z.number().min(0).max(1),
  shouldPublish: z.boolean(),
});

function compactTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => formatTag(tag)).filter(Boolean))].slice(0, 6);
}

function formatTag(tag: string): string {
  const normalized = tag.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized || normalized === "unknown") return "";

  const overrides = new Map<string, string>([
    ["ai", "AI"],
    ["api", "API"],
    ["b2b", "B2B"],
    ["cms", "CMS"],
    ["crypto", "Crypto"],
    ["defi", "DeFi"],
    ["ecommerce", "Ecommerce"],
    ["fintech", "Fintech"],
    ["saas", "SaaS"],
    ["ui", "UI"],
    ["ux", "UX"],
    ["web3", "Web3"],
    ["3d", "3D"],
  ]);

  return normalized
    .split(" ")
    .map((word) => overrides.get(word) ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function parseJsonContent(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] ?? content;
  return JSON.parse(source.trim());
}

export async function classifyWebsite(metadata: WebsiteMetadata): Promise<WebsiteClassification> {
  if (!config.deepseekApiKey) {
    throw new Error("DEEPSEEK_API_KEY is required for classification");
  }

  const prompt = {
    url: metadata.finalUrl,
    title: metadata.title,
    description: metadata.description,
    siteName: metadata.siteName,
    domain: domainFromUrl(metadata.finalUrl),
  };

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You classify well-designed websites for a design inspiration CMS. Return strict JSON only. Keep tags short and useful for filtering. Use clean title case for tag values, preserving acronyms like AI, API, SaaS, DeFi, Web3, UI, UX, and 3D. Do not invent facts that are not supported by URL/title/description.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Create DzinerHub CMS metadata for this website.",
            requiredShape: {
              title: "short site or product name",
              longTitle: "descriptive full title",
              comment: "one concise editorial sentence",
              categories: ["web design", "branding", "typography"],
              types: ["saas", "portfolio", "ecommerce", "agency", "landing page"],
              platforms: ["framer", "webflow", "shopify", "unknown"],
              styles: ["minimal", "dark", "colorful", "editorial", "3d"],
              typographies: ["sans serif", "serif", "large type"],
              qualityScore: "number from 0 to 1",
              shouldPublish: "boolean",
            },
            website: prompt,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek request failed with ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned an empty response");

  const parsed = classificationSchema.parse(parseJsonContent(content));
  return {
    ...parsed,
    categories: compactTags(parsed.categories),
    types: compactTags(parsed.types),
    platforms: compactTags(parsed.platforms),
    styles: compactTags(parsed.styles),
    typographies: compactTags(parsed.typographies),
  };
}

import sharp from "sharp";
import { z } from "zod";
import { config } from "./config.js";
import type { WebsiteClassification, WebsiteMetadata } from "./types.js";

interface ScreenshotVisualProfile {
  dimensions: {
    width: number;
    height: number;
  };
  palette: string[];
  mood: string[];
  brightness: number;
  colorfulness: number;
}

const aiCommentSchema = z.object({
  aiComment: z.string().min(20).max(900),
});

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toHex(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function bucketColor(value: number): number {
  return Math.round(value / 32) * 32;
}

function parseJsonContent(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] ?? content;
  return JSON.parse(source.trim());
}

async function buildScreenshotVisualProfile(image: Buffer): Promise<ScreenshotVisualProfile> {
  const source = sharp(image);
  const metadata = await source.metadata();
  const resized = await source
    .resize(72, 72, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const colorBuckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  let brightnessTotal = 0;
  let colorfulnessTotal = 0;
  const pixels = resized.data.length / 3;

  for (let index = 0; index < resized.data.length; index += 3) {
    const r = resized.data[index] ?? 0;
    const g = resized.data[index + 1] ?? 0;
    const b = resized.data[index + 2] ?? 0;
    const brightness = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const colorfulness = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    const key = `${bucketColor(r)},${bucketColor(g)},${bucketColor(b)}`;
    const bucket = colorBuckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };

    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    colorBuckets.set(key, bucket);
    brightnessTotal += brightness;
    colorfulnessTotal += colorfulness;
  }

  const brightness = Number((brightnessTotal / pixels).toFixed(2));
  const colorfulness = Number((colorfulnessTotal / pixels).toFixed(2));
  const palette = [...colorBuckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((color) => rgbToHex(color.r / color.count, color.g / color.count, color.b / color.count));

  const mood = [
    brightness < 0.28 ? "dark" : brightness > 0.72 ? "light" : "balanced light",
    colorfulness < 0.12 ? "restrained palette" : colorfulness > 0.35 ? "vivid palette" : "controlled color",
    (metadata.height ?? 0) > (metadata.width ?? 0) * 2.4 ? "long-scroll narrative" : "compact composition",
  ];

  return {
    dimensions: {
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
    },
    palette,
    mood,
    brightness,
    colorfulness,
  };
}

function fallbackAiComment(classification: WebsiteClassification, visual: ScreenshotVisualProfile): string {
  const palette = visual.palette.slice(0, 3).join(", ");
  const mood = visual.mood.join(", ");
  return `The design reads as ${mood}, with a palette led by ${palette}. Its strongest move is the controlled visual system: ${classification.styles.join(", ")} cues give the page a clear editorial stance without overexplaining the product.`;
}

function minimalVisualProfile(): ScreenshotVisualProfile {
  return {
    dimensions: { width: 0, height: 0 },
    palette: ["#F5F5F5", "#222222"],
    mood: ["visually restrained"],
    brightness: 0,
    colorfulness: 0,
  };
}

export async function createAiComment(
  metadata: WebsiteMetadata,
  classification: WebsiteClassification,
): Promise<string> {
  let visual = minimalVisualProfile();

  try {
    visual = await buildScreenshotVisualProfile(metadata.screenshot.fullPage);
  } catch {
    return fallbackAiComment(classification, visual);
  }

  if (!config.deepseekApiKey) {
    return fallbackAiComment(classification, visual);
  }

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      temperature: 0.55,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are an art director and creative director writing concise design critique for a curated web design gallery. Return strict JSON only. Do not sound like marketing copy. Focus on visible composition, palette, typography, hierarchy, rhythm, and art direction. Avoid unsupported claims about business performance or product features.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Write the AI Comment field for this CMS item.",
            requiredShape: {
              aiComment:
                "2-3 sentences, 45-85 words, polished editorial English, specific visual critique, art-director tone",
            },
            website: {
              url: metadata.finalUrl,
              title: classification.title,
              longTitle: classification.longTitle,
              categories: classification.categories,
              types: classification.types,
              styles: classification.styles,
              typographies: classification.typographies,
              shortComment: classification.comment,
            },
            screenshotVisualProfile: visual,
            pageContext: metadata.visualContext,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    return fallbackAiComment(classification, visual);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return fallbackAiComment(classification, visual);

  try {
    return aiCommentSchema.parse(parseJsonContent(content)).aiComment.trim();
  } catch {
    return fallbackAiComment(classification, visual);
  }
}

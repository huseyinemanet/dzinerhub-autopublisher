import { readFile } from "node:fs/promises";
import { z } from "zod";
import { normalizeUrl } from "./slug.js";

const sourceSchema = z.object({
  urls: z.array(z.string().min(1)).default([]),
  discoveryPages: z.array(z.string().min(1)).default([]),
});

export async function loadSourceFile(filePath: string): Promise<z.infer<typeof sourceSchema>> {
  const raw = await readFile(filePath, "utf8");
  return sourceSchema.parse(JSON.parse(raw));
}

export async function loadManualSources(filePath: string, limit: number): Promise<string[]> {
  const parsed = await loadSourceFile(filePath);
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const entry of parsed.urls) {
    const url = normalizeUrl(entry);
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= limit) break;
  }

  return urls;
}

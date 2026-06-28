export type ScreenshotApiCaptureKind = "thumbnail" | "fullPage";

interface ScreenshotApiOptions {
  apiKey: string;
  url: string;
  kind: ScreenshotApiCaptureKind;
}

interface ScreenshotApiRequestOptions {
  apiKey: string;
  url: string;
  fullPage: boolean;
  viewportWidth: number;
  viewportHeight: number;
  quality: number;
}

export function buildScreenshotApiUrl(options: ScreenshotApiRequestOptions): string {
  const endpoint = new URL("https://api.screenshotapi.com/take");
  endpoint.searchParams.set("apiKey", options.apiKey);
  endpoint.searchParams.set("url", options.url);
  endpoint.searchParams.set("responseType", "redirect");
  endpoint.searchParams.set("type", "jpeg");
  endpoint.searchParams.set("quality", String(options.quality));
  endpoint.searchParams.set("viewportWidth", String(options.viewportWidth));
  endpoint.searchParams.set("viewportHeight", String(options.viewportHeight));
  endpoint.searchParams.set("fullPage", String(options.fullPage));
  endpoint.searchParams.set("blockPopups", "true");
  endpoint.searchParams.set("blockCookieBanners", "true");
  endpoint.searchParams.set("doScroll", options.fullPage ? "true" : "false");
  endpoint.searchParams.set("timeout", "45000");
  return endpoint.toString();
}

async function fetchScreenshotApiImage(options: ScreenshotApiOptions): Promise<Buffer> {
  const isFullPage = options.kind === "fullPage";
  const requestUrl = buildScreenshotApiUrl({
    apiKey: options.apiKey,
    url: options.url,
    fullPage: isFullPage,
    viewportWidth: 1440,
    viewportHeight: isFullPage ? 1600 : 1100,
    quality: isFullPage ? 82 : 86,
  });

  const response = await fetch(requestUrl, {
    redirect: "follow",
    headers: {
      Accept: "image/jpeg,image/*;q=0.9,application/json;q=0.5",
      "User-Agent": "DzinerHubAutopublisher/0.1",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ScreenshotAPI ${response.status}: ${body.slice(0, 180)}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const data = Buffer.from(await response.arrayBuffer());

  if (/application\/json/i.test(contentType)) {
    const parsed = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    return extractImageFromJson(parsed);
  }

  if (!/^image\//i.test(contentType) && data.length < 1024) {
    throw new Error(`ScreenshotAPI returned unexpected content-type: ${contentType || "unknown"}`);
  }

  return data;
}

function extractImageFromJson(payload: Record<string, unknown>): Buffer {
  const keys = ["base64", "image", "screenshot", "data", "file", "body"];

  for (const key of keys) {
    const value = payload[key];
    if (typeof value !== "string" || !value) continue;

    const dataUrlMatch = value.match(/^data:image\/[a-z]+;base64,(.+)$/i);
    const base64 = dataUrlMatch?.[1] ?? value;
    if (/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
      return Buffer.from(base64.replace(/\s+/g, ""), "base64");
    }
  }

  throw new Error("ScreenshotAPI JSON response did not include image data");
}

export async function captureWithScreenshotApi(apiKey: string, url: string) {
  const [thumbnail, fullPage] = await Promise.all([
    fetchScreenshotApiImage({ apiKey, url, kind: "thumbnail" }),
    fetchScreenshotApiImage({ apiKey, url, kind: "fullPage" }),
  ]);

  return {
    thumbnail,
    fullPage,
    mimeType: "image/jpeg" as const,
  };
}

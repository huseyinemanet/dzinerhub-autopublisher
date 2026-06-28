import "dotenv/config";

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
  framerApiKey: process.env.FRAMER_API_KEY ?? "",
  screenshotApiKey: process.env.SCREENSHOTAPI_API_KEY ?? "",
  screenshotProvider: process.env.SCREENSHOT_PROVIDER ?? "auto",
  framerProjectUrl:
    process.env.FRAMER_PROJECT_URL ??
    "https://framer.com/projects/DzinerHub--H5SEd0ka5iXGdGZg4ede-302i0",
  dryRun: booleanEnv("DRY_RUN", true),
  readFramerInDryRun: booleanEnv("READ_FRAMER_IN_DRY_RUN", true),
  publish: booleanEnv("PUBLISH", false),
  draftItems: booleanEnv("DRAFT_ITEMS", false),
  maxUrls: numberEnv("MAX_URLS", 10),
  maxDiscoveryPages: numberEnv("MAX_DISCOVERY_PAGES", 12),
  maxDetailPagesPerSource: numberEnv("MAX_DETAIL_PAGES_PER_SOURCE", 16),
  minQualityScore: numberEnv("MIN_QUALITY_SCORE", 0.68),
  refParam: process.env.REF_PARAM ?? "dzinerhub.com",
  sourceFile: process.env.SOURCE_FILE ?? "data/sources.json",
  deepseekModel: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
  reportFile: process.env.REPORT_FILE ?? "autopublisher-report.json",
  siteBaseUrl: process.env.SITE_BASE_URL ?? "https://dzinerhub.framer.website",
};

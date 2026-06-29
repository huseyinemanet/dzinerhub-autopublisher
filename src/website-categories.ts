export const WEBSITE_CATEGORY_TITLES = [
  "Landing Page",
  "Portfolio",
  "Blog",
  "E-commerce",
  "Product Page",
  "Product Listing",
  "Pricing Page",
  "About Us",
  "Career",
  "Sign Up",
  "Made in Framer",
  "Other",
] as const;

export type WebsiteCategoryTitle = (typeof WEBSITE_CATEGORY_TITLES)[number];

export const WEBSITE_CATEGORIES: Array<{ title: WebsiteCategoryTitle; slug: string }> = [
  { title: "Landing Page", slug: "landing-page" },
  { title: "Portfolio", slug: "portfolio" },
  { title: "Blog", slug: "blog" },
  { title: "E-commerce", slug: "e-commerce" },
  { title: "Product Page", slug: "product-page" },
  { title: "Product Listing", slug: "product-listing" },
  { title: "Pricing Page", slug: "pricing-page" },
  { title: "About Us", slug: "about-us" },
  { title: "Career", slug: "career" },
  { title: "Sign Up", slug: "sign-up" },
  { title: "Made in Framer", slug: "made-in-framer" },
  { title: "Other", slug: "other" },
];

const DIRECT_ALIASES = new Map<string, WebsiteCategoryTitle>([
  ["landing", "Landing Page"],
  ["landing page", "Landing Page"],
  ["home", "Landing Page"],
  ["homepage", "Landing Page"],
  ["portfolio", "Portfolio"],
  ["personal", "Portfolio"],
  ["agency", "Portfolio"],
  ["studio", "Portfolio"],
  ["blog", "Blog"],
  ["article", "Blog"],
  ["articles", "Blog"],
  ["news", "Blog"],
  ["journal", "Blog"],
  ["magazine", "Blog"],
  ["ecommerce", "E-commerce"],
  ["e-commerce", "E-commerce"],
  ["commerce", "E-commerce"],
  ["shop", "E-commerce"],
  ["store", "E-commerce"],
  ["retail", "E-commerce"],
  ["product", "Product Page"],
  ["product page", "Product Page"],
  ["physical product", "Product Page"],
  ["web app", "Product Page"],
  ["mobile app", "Product Page"],
  ["software", "Product Page"],
  ["service", "Product Page"],
  ["platform", "Product Page"],
  ["product listing", "Product Listing"],
  ["listing", "Product Listing"],
  ["directory", "Product Listing"],
  ["marketplace", "Product Listing"],
  ["pricing", "Pricing Page"],
  ["pricing page", "Pricing Page"],
  ["about", "About Us"],
  ["about us", "About Us"],
  ["career", "Career"],
  ["careers", "Career"],
  ["jobs", "Career"],
  ["hiring", "Career"],
  ["sign up", "Sign Up"],
  ["signup", "Sign Up"],
  ["register", "Sign Up"],
  ["made in framer", "Made in Framer"],
  ["framer", "Made in Framer"],
  ["other", "Other"],
]);

const IGNORED_CATEGORY_VALUES = new Set([
  "ai",
  "api",
  "b2b",
  "booking",
  "branding",
  "creative resources",
  "crypto",
  "defi",
  "fintech",
  "food & drink",
  "gaming",
  "interactive",
  "photography",
  "product design",
  "saas",
  "search tool",
  "tech",
  "technology",
  "typography",
  "ui",
  "ui design",
  "ux",
  "web design",
  "web3",
]);

export interface WebsiteCategoryContext {
  title?: string;
  longTitle?: string;
  url?: string;
  categories?: string[];
  types?: string[];
  platforms?: string[];
  comment?: string;
}

export function categorySlug(title: WebsiteCategoryTitle): string {
  return WEBSITE_CATEGORIES.find((category) => category.title === title)?.slug ?? "other";
}

export function splitCategoryText(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function normalizeCategoryKey(value: string): string {
  return value
    .trim()
    .replace(/&amp;/gi, "&")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function normalizeWebsiteCategoryName(value: string): WebsiteCategoryTitle | null {
  const key = normalizeCategoryKey(value);
  if (!key || IGNORED_CATEGORY_VALUES.has(key)) return null;
  return DIRECT_ALIASES.get(key) ?? null;
}

export function normalizeWebsiteCategories(
  values: string[],
  context: WebsiteCategoryContext = {},
): WebsiteCategoryTitle[] {
  const normalized = uniqueCategories([
    ...values.flatMap((value) => splitCategoryText(value)),
    ...(context.categories ?? []),
  ]);

  if (normalized.length > 0) return normalized;

  const inferred = inferWebsiteCategories(context);
  return inferred.length > 0 ? inferred : ["Other"];
}

export function inferWebsiteCategories(context: WebsiteCategoryContext): WebsiteCategoryTitle[] {
  const sourceValues = [
    ...(context.categories ?? []),
    ...(context.types ?? []),
    ...(context.platforms ?? []),
    context.title ?? "",
    context.longTitle ?? "",
    context.url ?? "",
    context.comment ?? "",
  ];

  const text = normalizeCategoryKey(sourceValues.join(" "));
  const result: WebsiteCategoryTitle[] = uniqueCategories(sourceValues).filter((category) => category !== "Other");

  const add = (category: WebsiteCategoryTitle) => {
    if (!result.includes(category)) result.push(category);
  };

  if (/\b(pricing|plans|packages)\b/.test(text)) add("Pricing Page");
  if (/\b(about|mission|company|team)\b/.test(text)) add("About Us");
  if (/\b(career|careers|jobs|hiring|work with us)\b/.test(text)) add("Career");
  if (/\b(sign up|signup|register|join|login|log in)\b/.test(text)) add("Sign Up");
  if (/\b(blog|article|articles|news|journal|magazine|newsletter)\b/.test(text)) add("Blog");
  if (/\b(shop|store|e commerce|ecommerce|commerce|cart|checkout|retail)\b/.test(text)) add("E-commerce");
  if (/\b(directory|marketplace|listing|catalog|collection|showcase|gallery)\b/.test(text)) add("Product Listing");
  if (/\b(portfolio|personal|agency|studio|designer|photographer|artist|creative)\b/.test(text)) add("Portfolio");
  if (/\b(framer|made in framer)\b/.test(text)) add("Made in Framer");
  if (/\b(product|app|software|tool|platform|service|web app|mobile app)\b/.test(text)) add("Product Page");
  if (/\b(landing|homepage|home page|startup|marketing|website|saas)\b/.test(text)) add("Landing Page");

  return result;
}

function uniqueCategories(values: string[]): WebsiteCategoryTitle[] {
  const result: WebsiteCategoryTitle[] = [];
  for (const value of values) {
    const category = normalizeWebsiteCategoryName(value);
    if (category && !result.includes(category)) result.push(category);
  }
  return result;
}

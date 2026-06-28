import { createHash } from "crypto";
import { canonicalUrlKey, urlIdentityKeys } from "./url-identity.js";
import type { CandidateResult } from "./types.js";

export interface WebsiteIdentityIndex {
  slugs: Set<string>;
  slugToUrlKeys: Map<string, Set<string>>;
  urlKeys: Set<string>;
}

export function createWebsiteIdentityIndex(): WebsiteIdentityIndex {
  return {
    slugs: new Set<string>(),
    slugToUrlKeys: new Map<string, Set<string>>(),
    urlKeys: new Set<string>(),
  };
}

export function candidateIdentityKeys(candidate: CandidateResult): Set<string> {
  return urlIdentityKeys(
    candidate.sourceUrl,
    candidate.metadata.url,
    candidate.metadata.finalUrl,
    candidate.metadata.canonicalUrl,
    candidate.externalLink,
  );
}

export function addExistingIdentity(index: WebsiteIdentityIndex, slug: string, rawUrls: string[]): void {
  const slugKeys = new Set<string>();

  index.slugs.add(slug);
  for (const rawUrl of rawUrls) {
    const key = canonicalUrlKey(rawUrl);
    if (!key) continue;
    index.urlKeys.add(key);
    slugKeys.add(key);
  }

  if (slugKeys.size) index.slugToUrlKeys.set(slug, slugKeys);
}

export function findDuplicateReason(index: WebsiteIdentityIndex, candidate: CandidateResult): string | null {
  const keys = candidateIdentityKeys(candidate);
  for (const key of keys) {
    if (index.urlKeys.has(key)) return `matching URL (${key})`;
  }

  const slugKeys = index.slugToUrlKeys.get(candidate.slug);
  if (!slugKeys) return null;

  for (const key of keys) {
    if (slugKeys.has(key)) return `matching slug and URL (${candidate.slug})`;
  }

  return null;
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

export function uniqueSlugForCandidate(index: WebsiteIdentityIndex, candidate: CandidateResult): string {
  if (!index.slugs.has(candidate.slug)) return candidate.slug;

  const firstKey = [...candidateIdentityKeys(candidate)][0] ?? candidate.metadata.finalUrl;
  const suffix = shortHash(firstKey);
  const base = candidate.slug.slice(0, Math.max(1, 80 - suffix.length - 1)).replace(/-+$/, "");
  let nextSlug = `${base}-${suffix}`;
  let counter = 2;

  while (index.slugs.has(nextSlug)) {
    const counterSuffix = `${suffix}-${counter}`;
    const counterBase = candidate.slug.slice(0, Math.max(1, 80 - counterSuffix.length - 1)).replace(/-+$/, "");
    nextSlug = `${counterBase}-${counterSuffix}`;
    counter += 1;
  }

  return nextSlug;
}

export function reserveCandidate(index: WebsiteIdentityIndex, candidate: CandidateResult): void {
  addExistingIdentity(index, candidate.slug, [...candidateIdentityKeys(candidate)]);
}

import { config } from "./config.js";
import { candidateRejectReason, validateCapturedWebsite } from "./candidate-validation.js";
import { createAiComment } from "./ai-comment.js";
import { classifyWebsite } from "./classify.js";
import {
  createWebsiteIdentityIndex,
  findDuplicateReason,
  reserveCandidate,
  uniqueSlugForCandidate,
} from "./dedupe.js";
import { SkippedCandidateError } from "./errors.js";
import {
  addWebsiteItem,
  connectFramer,
  getExistingWebsiteIndex,
  getWebsitesCollection,
  publishIfRequested,
} from "./framer.js";
import { discoverCandidates } from "./discover.js";
import { appendRefParam, domainFromUrl, normalizeUrl, slugForWebsite } from "./slug.js";
import { canonicalUrlKey, urlIdentityKeys } from "./url-identity.js";
import { loadManualSources, loadSourceFile } from "./sources.js";
import { captureWebsite, withBrowser } from "./screenshot.js";
import type { CandidateResult, SyncSummary } from "./types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildCandidate(url: string): Promise<CandidateResult> {
  return withBrowser(async (browser) => {
    const metadata = await captureWebsite(browser, url);
    const invalidReason = await validateCapturedWebsite(metadata);
    if (invalidReason) {
      throw new SkippedCandidateError(`Skipped invalid: ${url} (${invalidReason})`, invalidReason);
    }

    const classification = await classifyWebsite(metadata);
    const slug = slugForWebsite(classification.title || metadata.title, metadata.finalUrl);

    return {
      sourceUrl: url,
      metadata,
      classification,
      aiComment: "",
      slug,
      externalLink: appendRefParam(metadata.canonicalUrl || metadata.finalUrl, config.refParam),
    };
  });
}

function uniqueUrls(urls: string[], limit: number): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const rawUrl of urls) {
    let normalized = "";
    try {
      normalized = normalizeUrl(rawUrl);
    } catch {
      continue;
    }

    const key = canonicalUrlKey(normalized) || normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(normalized);
    if (results.length >= limit) break;
  }

  return results;
}

async function connectFramerSafely() {
  const attempts = config.dryRun ? 2 : 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await connectFramer();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Framer connection attempt ${attempt}/${attempts} failed: ${message}`);
      if (attempt < attempts) await sleep(2500 * attempt);
    }
  }

  if (config.dryRun) {
    console.error("Continuing dry run without Framer CMS duplicate checks.");
    return null;
  }

  throw lastError;
}

async function main(): Promise<void> {
  const summary: SyncSummary = {
    discovered: 0,
    scanned: 0,
    skippedDuplicate: 0,
    skippedExisting: 0,
    skippedInvalid: 0,
    skippedLowQuality: 0,
    failed: 0,
    created: 0,
    dryRun: config.dryRun,
    published: false,
  };

  const shouldReadFramer = !config.dryRun || (config.readFramerInDryRun && Boolean(config.framerApiKey));
  const framer = shouldReadFramer ? await connectFramerSafely() : null;

  try {
    const collectionData = framer ? await getWebsitesCollection(framer) : null;
    const identityIndex = collectionData
      ? await getExistingWebsiteIndex(collectionData.collection, collectionData.fields)
      : createWebsiteIdentityIndex();

    if (!collectionData) {
      console.log("Framer CMS read skipped; duplicate checks are limited to this run.");
    }

    const sourceFile = await loadSourceFile(config.sourceFile);
    const curatorHosts = new Set((sourceFile.discoveryPages ?? []).map((sourceUrl) => domainFromUrl(sourceUrl)).filter(Boolean));
    const manualUrls = await loadManualSources(config.sourceFile, config.maxUrls);
    const discoveredUrls = await withBrowser((browser) =>
      discoverCandidates(browser, sourceFile.discoveryPages, config.maxUrls),
    );
    const urls = uniqueUrls([...discoveredUrls, ...manualUrls], config.maxUrls);
    summary.discovered = discoveredUrls.length;

    console.log(`Prepared ${urls.length} candidate URL(s).`);

    for (const rawUrl of urls) {
      const url = normalizeUrl(rawUrl);
      summary.scanned += 1;
      console.log(`Scanning ${url}`);

      try {
        const rejectReason = candidateRejectReason(url, curatorHosts);
        if (rejectReason) {
          summary.skippedInvalid += 1;
          console.log(`Skipped invalid: ${url} (${rejectReason})`);
          continue;
        }

        const duplicateKey = [...urlIdentityKeys(url)].find((key) => identityIndex.urlKeys.has(key));
        if (duplicateKey) {
          summary.skippedDuplicate += 1;
          summary.skippedExisting += 1;
          console.log(`Skipped duplicate: ${url} (matching URL ${duplicateKey})`);
          continue;
        }

        const candidate = await buildCandidate(url);
        const duplicateReason = findDuplicateReason(identityIndex, candidate);

        if (duplicateReason) {
          summary.skippedDuplicate += 1;
          summary.skippedExisting += 1;
          console.log(`Skipped duplicate: ${candidate.classification.title} (${duplicateReason})`);
          continue;
        }

        candidate.slug = uniqueSlugForCandidate(identityIndex, candidate);

        if (
          !candidate.classification.shouldPublish ||
          candidate.classification.qualityScore < config.minQualityScore
        ) {
          summary.skippedLowQuality += 1;
          console.log(
            `Skipped low quality: ${candidate.classification.title} (${candidate.classification.qualityScore})`,
          );
          continue;
        }

        candidate.aiComment = await createAiComment(candidate.metadata, candidate.classification);

        if (config.dryRun) {
          console.log(
            JSON.stringify(
              {
                title: candidate.classification.title,
                slug: candidate.slug,
                externalLink: candidate.externalLink,
                qualityScore: candidate.classification.qualityScore,
                categories: candidate.classification.categories,
                types: candidate.classification.types,
                platforms: candidate.classification.platforms,
                styles: candidate.classification.styles,
                typographies: candidate.classification.typographies,
                aiComment: candidate.aiComment,
              },
              null,
              2,
            ),
          );
          reserveCandidate(identityIndex, candidate);
        } else if (framer && collectionData) {
          const latestIndex = await getExistingWebsiteIndex(collectionData.collection, collectionData.fields);
          const finalDuplicateReason = findDuplicateReason(latestIndex, candidate);
          if (finalDuplicateReason) {
            summary.skippedDuplicate += 1;
            summary.skippedExisting += 1;
            console.log(`Skipped duplicate before write: ${candidate.classification.title} (${finalDuplicateReason})`);
            continue;
          }

          candidate.slug = uniqueSlugForCandidate(latestIndex, candidate);
          await addWebsiteItem(framer, collectionData.collection, collectionData.fields, candidate);
          reserveCandidate(identityIndex, candidate);
        }

        summary.created += 1;
      } catch (error) {
        if (error instanceof SkippedCandidateError) {
          summary.skippedInvalid += 1;
          console.log(error.message);
          continue;
        }

        summary.failed += 1;
        console.error(`Failed ${url}:`, error instanceof Error ? error.message : error);
      }
    }

    if (framer) {
      summary.published = await publishIfRequested(framer, summary.created > 0);
    }
  } finally {
    await framer?.disconnect();
  }

  console.log("Summary");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

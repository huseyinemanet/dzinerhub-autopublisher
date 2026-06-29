import { connect, type Collection, type Field, type Framer } from "framer-api";
import { config } from "./config.js";
import { addExistingIdentity, createWebsiteIdentityIndex, type WebsiteIdentityIndex } from "./dedupe.js";
import type { CandidateResult, InspirationCandidate, StoryCandidate } from "./types.js";
import { canonicalUrlKey } from "./url-identity.js";
import { normalizeWebsiteCategories } from "./website-categories.js";

type FieldByName = Map<string, Field>;

function fieldMap(fields: Field[]): FieldByName {
  return new Map(fields.map((field) => [field.name.toLowerCase(), field]));
}

function fieldId(fields: FieldByName, name: string): string {
  const field = fields.get(name.toLowerCase());
  if (!field) throw new Error(`Missing Framer field: ${name}`);
  return field.id;
}

function optionalFieldId(fields: FieldByName, name: string): string | undefined {
  return fields.get(name.toLowerCase())?.id;
}

function textField(value: string) {
  return { type: "string" as const, value };
}

function linkField(value: string) {
  return { type: "link" as const, value };
}

function dateField(value: string) {
  return { type: "date" as const, value };
}

function imageField(value: string, alt: string) {
  return { type: "image" as const, value, alt };
}

function formattedTextField(value: string) {
  return { type: "formattedText" as const, value: `<p>${escapeHtml(value)}</p>` };
}

function formattedParagraphsField(values: string[]) {
  const value = values.length
    ? values.map((paragraph) => `<p dir="auto">${escapeHtml(paragraph)}</p>`).join("")
    : "";
  return { type: "formattedText" as const, value };
}

function multiCollectionReferenceField(value: string[]) {
  return { type: "multiCollectionReference" as const, value };
}

function setOptional(
  fieldData: Record<string, unknown>,
  fields: FieldByName,
  name: string,
  value:
    | ReturnType<typeof textField>
    | ReturnType<typeof linkField>
    | ReturnType<typeof dateField>
    | ReturnType<typeof imageField>
    | ReturnType<typeof formattedTextField>,
): void {
  const id = optionalFieldId(fields, name);
  if (id) fieldData[id] = value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function entryValue(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const value = (entry as { value?: unknown }).value;
  return typeof value === "string" ? value : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectFramer(): Promise<Framer> {
  if (!config.framerApiKey) {
    throw new Error("FRAMER_API_KEY is required when DRY_RUN=false");
  }
  return connect(config.framerProjectUrl, config.framerApiKey);
}

export async function getWebsitesCollection(framer: Framer): Promise<{
  collection: Collection;
  fields: FieldByName;
}> {
  const collections = await framer.getCollections();
  const collection = collections.find((candidate) => candidate.name === "Websites");
  if (!collection) throw new Error('Framer collection "Websites" was not found');
  return {
    collection,
    fields: fieldMap(await collection.getFields()),
  };
}

export async function getStoriesCollection(framer: Framer): Promise<{
  collection: Collection;
  fields: FieldByName;
}> {
  const collections = await framer.getCollections();
  const collection = collections.find((candidate) => candidate.name === "Stories");
  if (!collection) throw new Error('Framer collection "Stories" was not found');
  return {
    collection,
    fields: fieldMap(await collection.getFields()),
  };
}

export async function getInspirationCollection(framer: Framer): Promise<{
  collection: Collection;
  fields: FieldByName;
}> {
  const collections = await framer.getCollections();
  const collection = collections.find((candidate) => candidate.name === "Inspiration");
  if (!collection) throw new Error('Framer collection "Inspiration" was not found');
  return {
    collection,
    fields: fieldMap(await collection.getFields()),
  };
}

async function getContributorReferenceIds(framer: Framer, references: string[]): Promise<string[]> {
  const wanted = new Set(references.map((reference) => reference.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return [];

  const collections = await framer.getCollections();
  const contributors = collections.find((candidate) => candidate.name === "Contributors");
  if (!contributors) throw new Error('Framer collection "Contributors" was not found');

  const fields = fieldMap(await contributors.getFields());
  const handleFieldId = optionalFieldId(fields, "Handle");
  const fullNameFieldId = optionalFieldId(fields, "Full Name");
  const items = await contributors.getItems();
  const ids: string[] = [];

  for (const item of items) {
    const keys = [
      item.id,
      item.slug,
      handleFieldId ? entryValue(item.fieldData[handleFieldId]) : "",
      fullNameFieldId ? entryValue(item.fieldData[fullNameFieldId]) : "",
    ]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    if (keys.some((key) => wanted.has(key))) ids.push(item.id);
  }

  const missing = [...wanted].filter((reference) => !ids.some((id) => id.toLowerCase() === reference));
  if (ids.length === 0 || ids.length < wanted.size) {
    const foundReferences = new Set(
      items
        .filter((item) => ids.includes(item.id))
        .flatMap((item) => [
          item.id,
          item.slug,
          handleFieldId ? entryValue(item.fieldData[handleFieldId]) : "",
          fullNameFieldId ? entryValue(item.fieldData[fullNameFieldId]) : "",
        ])
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    const unresolved = missing.filter((reference) => !foundReferences.has(reference));
    if (unresolved.length > 0) throw new Error(`Missing Contributor reference: ${unresolved.join(", ")}`);
  }

  return [...new Set(ids)];
}

async function getWebsiteCategoryReferenceIds(framer: Framer, categories: string[]): Promise<string[]> {
  const wanted = new Set(categories.map((category) => category.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return [];

  const collections = await framer.getCollections();
  const categoriesCollection = collections.find((candidate) => candidate.name === "Categories");
  if (!categoriesCollection) throw new Error('Framer collection "Categories" was not found');

  const fields = fieldMap(await categoriesCollection.getFields());
  const titleFieldId = optionalFieldId(fields, "Title") ?? optionalFieldId(fields, "Name");
  const items = await categoriesCollection.getItems();
  const ids: string[] = [];

  for (const item of items) {
    const keys = [item.slug, titleFieldId ? entryValue(item.fieldData[titleFieldId]) : ""]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    if (keys.some((key) => wanted.has(key))) ids.push(item.id);
  }

  if (ids.length < wanted.size) {
    const found = new Set(
      items
        .filter((item) => ids.includes(item.id))
        .flatMap((item) => [item.slug, titleFieldId ? entryValue(item.fieldData[titleFieldId]) : ""])
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    const missing = [...wanted].filter((category) => !found.has(category));
    if (missing.length > 0) throw new Error(`Missing Website category reference: ${missing.join(", ")}`);
  }

  return [...new Set(ids)];
}

async function websiteCategoryFieldData(
  framer: Framer,
  fields: FieldByName,
  candidate: CandidateResult,
): Promise<Array<{ id: string; value: ReturnType<typeof textField> | ReturnType<typeof multiCollectionReferenceField> }>> {
  const categoriesField = fields.get("categories");
  const categoriesRefField = fields.get("categories ref");
  const relationField =
    (categoriesField as { type?: string } | undefined)?.type === "multiCollectionReference"
      ? categoriesField
      : (categoriesRefField as { type?: string } | undefined)?.type === "multiCollectionReference"
        ? categoriesRefField
        : undefined;
  const legacyTextField =
    (categoriesField as { type?: string } | undefined)?.type !== "multiCollectionReference" ? categoriesField : undefined;

  if (!relationField && !legacyTextField) throw new Error("Missing Framer field: Categories");

  const categories = normalizeWebsiteCategories(candidate.classification.categories, {
    title: candidate.classification.title,
    longTitle: candidate.classification.longTitle,
    url: candidate.externalLink,
    types: candidate.classification.types,
    platforms: candidate.classification.platforms,
    comment: candidate.classification.comment,
  });

  const entries: Array<{ id: string; value: ReturnType<typeof textField> | ReturnType<typeof multiCollectionReferenceField> }> = [];

  if (relationField) {
    entries.push({
      id: relationField.id,
      value: multiCollectionReferenceField(await getWebsiteCategoryReferenceIds(framer, categories)),
    });
  }

  if (legacyTextField) entries.push({ id: legacyTextField.id, value: textField(categories.join(", ")) });

  return entries;
}

export async function getExistingWebsiteIndex(collection: Collection, fields: FieldByName): Promise<WebsiteIdentityIndex> {
  const items = await collection.getItems();
  const index = createWebsiteIdentityIndex();
  const externalLinkFieldId = optionalFieldId(fields, "External Link");

  for (const item of items) {
    const urls: string[] = [];
    if (externalLinkFieldId) {
      const externalLink = entryValue(item.fieldData[externalLinkFieldId]);
      if (externalLink) urls.push(externalLink);
    }

    for (const entry of Object.values(item.fieldData)) {
      const value = entryValue(entry);
      if (value.startsWith("http")) urls.push(value);
    }
    addExistingIdentity(index, item.slug, urls);
  }

  return index;
}

export async function addWebsiteItem(
  framer: Framer,
  collection: Collection,
  fields: FieldByName,
  candidate: CandidateResult,
): Promise<void> {
  const categoryFields = await websiteCategoryFieldData(framer, fields, candidate);

  const thumbnail = await framer.uploadImage({
    image: {
      bytes: new Uint8Array(candidate.metadata.screenshot.thumbnail),
      mimeType: candidate.metadata.screenshot.mimeType,
    },
    name: `${candidate.slug}-thumbnail.jpg`,
    altText: `${candidate.classification.title} website thumbnail`,
  });

  const fullImage = await framer.uploadImage({
    image: {
      bytes: new Uint8Array(candidate.metadata.screenshot.fullPage),
      mimeType: candidate.metadata.screenshot.mimeType,
    },
    name: `${candidate.slug}-full.jpg`,
    altText: `${candidate.classification.title} full page website screenshot`,
  });

  const fieldData: Record<string, any> = {
    [fieldId(fields, "Title")]: textField(candidate.classification.title),
    [fieldId(fields, "Long Title")]: textField(candidate.classification.longTitle),
    [fieldId(fields, "External Link")]: linkField(candidate.externalLink),
    [fieldId(fields, "Created time")]: dateField(new Date().toISOString()),
    [fieldId(fields, "Types")]: textField(candidate.classification.types.join(", ")),
    [fieldId(fields, "Platforms")]: textField(candidate.classification.platforms.join(", ")),
    [fieldId(fields, "Styles")]: textField(candidate.classification.styles.join(", ")),
    [fieldId(fields, "Typographies")]: textField(candidate.classification.typographies.join(", ")),
    [fieldId(fields, "Comment")]: formattedTextField(candidate.classification.comment),
    [fieldId(fields, "Thumbnail")]: imageField(thumbnail.url, `${candidate.classification.title} thumbnail`),
    [fieldId(fields, "Full Image")]: imageField(fullImage.url, `${candidate.classification.title} full screenshot`),
  };

  for (const categoryField of categoryFields) fieldData[categoryField.id] = categoryField.value;

  setOptional(fieldData, fields, "id", textField(candidate.slug));
  setOptional(fieldData, fields, "AI Comment", textField(candidate.aiComment));

  await collection.addItems([
    {
      slug: candidate.slug,
      draft: config.draftItems,
      fieldData,
    },
  ]);
}

export async function getExistingStoryUrlKeys(collection: Collection, fields: FieldByName): Promise<Set<string>> {
  const items = await collection.getItems();
  const urlFieldId = optionalFieldId(fields, "URL");
  const keys = new Set<string>();

  if (!urlFieldId) return keys;

  for (const item of items) {
    const url = entryValue(item.fieldData[urlFieldId]);
    const key = canonicalUrlKey(url);
    if (key) keys.add(key);
  }

  return keys;
}

export function uniqueStorySlug(existingSlugs: Set<string>, slug: string): string {
  let candidate = slug || "story";
  let suffix = 2;

  while (existingSlugs.has(candidate)) {
    candidate = `${slug || "story"}-${suffix}`;
    suffix += 1;
  }

  existingSlugs.add(candidate);
  return candidate;
}

export async function getExistingStorySlugs(collection: Collection): Promise<Set<string>> {
  const items = await collection.getItems();
  return new Set(items.map((item) => item.slug));
}

export async function getExistingInspirationUrlKeys(collection: Collection, fields: FieldByName): Promise<Set<string>> {
  const items = await collection.getItems();
  const sourceFieldId = optionalFieldId(fields, "Source");
  const keys = new Set<string>();

  if (!sourceFieldId) return keys;

  for (const item of items) {
    const source = entryValue(item.fieldData[sourceFieldId]);
    const key = canonicalUrlKey(source);
    if (key) keys.add(key);
  }

  return keys;
}

export async function getExistingInspirationSlugs(collection: Collection): Promise<Set<string>> {
  const items = await collection.getItems();
  return new Set(items.map((item) => item.slug));
}

export async function addStoryItem(
  collection: Collection,
  fields: FieldByName,
  candidate: StoryCandidate,
): Promise<void> {
  const contentFieldId = optionalFieldId(fields, "Content");
  const fieldData = {
    [fieldId(fields, "Title")]: textField(candidate.title),
    [fieldId(fields, "Created time")]: dateField(new Date().toISOString()),
    [fieldId(fields, "Description")]: textField(candidate.description),
    [fieldId(fields, "URL")]: linkField(candidate.url),
    [fieldId(fields, "Tags")]: textField(candidate.tags.join(", ")),
    [fieldId(fields, "AI Comment")]: textField(candidate.aiComment),
    [fieldId(fields, "Domain")]: textField(candidate.domain),
    ...(contentFieldId ? { [contentFieldId]: formattedTextField("") } : {}),
  };

  await collection.addItems([
    {
      slug: candidate.slug,
      draft: config.draftItems,
      fieldData,
    },
  ]);
}

export async function addInspirationItem(
  framer: Framer,
  collection: Collection,
  fields: FieldByName,
  candidate: InspirationCandidate,
): Promise<void> {
  const contributorIds = await getContributorReferenceIds(framer, candidate.contributorSlugs);
  const photo = await framer.uploadImage({
    image: {
      bytes: new Uint8Array(candidate.photo.bytes),
      mimeType: candidate.photo.mimeType,
    },
    name: `${candidate.slug}-inspiration.jpg`,
    altText: candidate.title,
  });
  const contentFieldId = optionalFieldId(fields, "Content");

  const fieldData = {
    [fieldId(fields, "Title")]: textField(candidate.title),
    [fieldId(fields, "Photo")]: imageField(photo.url, candidate.title),
    [fieldId(fields, "Contributors")]: multiCollectionReferenceField(contributorIds),
    [fieldId(fields, "Tag")]: textField(candidate.tag),
    [fieldId(fields, "AI Content")]: formattedParagraphsField(candidate.aiContent),
    [fieldId(fields, "Source")]: linkField(candidate.finalUrl),
    [fieldId(fields, "AI Comment")]: textField(candidate.aiComment),
    [fieldId(fields, "Created time")]: dateField(new Date().toISOString()),
    ...(contentFieldId ? { [contentFieldId]: formattedParagraphsField([]) } : {}),
  };

  await collection.addItems([
    {
      slug: candidate.slug,
      draft: config.draftItems,
      fieldData,
    },
  ]);
}

export async function publishIfRequested(
  framer: Framer,
  hasNewItems: boolean,
  options: { throwOnFailure?: boolean } = {},
): Promise<boolean> {
  if (!config.publish || !hasNewItems) return false;

  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const preview = (await framer.agent.publish({ action: "preview" })) as {
        confirmationHash?: string;
      };
      if (!preview.confirmationHash) {
        throw new Error("Framer publish preview did not return a confirmation hash");
      }

      await framer.agent.publish({
        action: "confirm_publish",
        confirmationHash: preview.confirmationHash,
      });

      return true;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Framer publish attempt ${attempt}/3 failed: ${message}`);
      if (attempt < 3) await sleep(5000 * attempt);
    }
  }

  if (options.throwOnFailure === false) return false;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

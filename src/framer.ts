import { connect, type Collection, type Field, type Framer } from "framer-api";
import { config } from "./config.js";
import { addExistingIdentity, createWebsiteIdentityIndex, type WebsiteIdentityIndex } from "./dedupe.js";
import type { CandidateResult } from "./types.js";

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

function setOptional(
  fieldData: Record<string, ReturnType<typeof textField | typeof linkField | typeof dateField | typeof imageField | typeof formattedTextField>>,
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

  const fieldData = {
    [fieldId(fields, "Title")]: textField(candidate.classification.title),
    [fieldId(fields, "Long Title")]: textField(candidate.classification.longTitle),
    [fieldId(fields, "External Link")]: linkField(candidate.externalLink),
    [fieldId(fields, "Created time")]: dateField(new Date().toISOString()),
    [fieldId(fields, "Categories")]: textField(candidate.classification.categories.join(", ")),
    [fieldId(fields, "Types")]: textField(candidate.classification.types.join(", ")),
    [fieldId(fields, "Platforms")]: textField(candidate.classification.platforms.join(", ")),
    [fieldId(fields, "Styles")]: textField(candidate.classification.styles.join(", ")),
    [fieldId(fields, "Typographies")]: textField(candidate.classification.typographies.join(", ")),
    [fieldId(fields, "Comment")]: formattedTextField(candidate.classification.comment),
    [fieldId(fields, "Thumbnail")]: imageField(thumbnail.url, `${candidate.classification.title} thumbnail`),
    [fieldId(fields, "Full Image")]: imageField(fullImage.url, `${candidate.classification.title} full screenshot`),
  };

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

export async function publishIfRequested(framer: Framer, hasNewItems: boolean): Promise<boolean> {
  if (!config.publish || !hasNewItems) return false;

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
}

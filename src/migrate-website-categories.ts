import { connectFramer } from "./framer.js";
import {
  categorySlug,
  normalizeWebsiteCategories,
  splitCategoryText,
  WEBSITE_CATEGORIES,
  type WebsiteCategoryTitle,
} from "./website-categories.js";

interface CmsField {
  id: string;
  name: string;
  type?: string;
  setAttributes?: (attributes: { name?: string }) => Promise<CmsField | null>;
}

interface CmsItem {
  id: string;
  slug: string;
  draft?: boolean;
  fieldData: Record<string, unknown>;
}

interface CmsCollection {
  id: string;
  name: string;
  addFields(fields: Array<Record<string, unknown>>): Promise<CmsField[]>;
  addItems(items: Array<Record<string, unknown>>): Promise<void>;
  getFields(): Promise<CmsField[]>;
  getItems(): Promise<CmsItem[]>;
  removeFields(fieldIds: string[]): Promise<void>;
}

type FieldByName = Map<string, CmsField>;

const dryRun = booleanEnv("DRY_RUN", true);
const finalize = booleanEnv("FINALIZE_WEBSITE_CATEGORIES", false);

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function fieldMap(fields: CmsField[]): FieldByName {
  return new Map(fields.map((field) => [field.name.toLowerCase(), field]));
}

function optionalField(fields: FieldByName, name: string): CmsField | undefined {
  return fields.get(name.toLowerCase());
}

function fieldId(fields: FieldByName, name: string): string {
  const field = optionalField(fields, name);
  if (!field) throw new Error(`Missing field: ${name}`);
  return field.id;
}

function entryValue(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const value = (entry as { value?: unknown }).value;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const nestedUrl = (value as { url?: unknown }).url;
    if (typeof nestedUrl === "string") return nestedUrl;
  }
  return "";
}

function textField(value: string) {
  return { type: "string" as const, value };
}

function multiCollectionReferenceField(value: string[]) {
  return { type: "multiCollectionReference" as const, value };
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function ensureCategoriesCollection(framer: Awaited<ReturnType<typeof connectFramer>>): Promise<{
  collection: CmsCollection;
  fields: FieldByName;
  itemsByTitle: Map<WebsiteCategoryTitle, CmsItem>;
}> {
  let collections = (await framer.getCollections()) as unknown as CmsCollection[];
  let collection = collections.find((candidate) => candidate.name === "Categories");

  if (!collection) {
    if (dryRun) {
      return {
        collection: { id: "dry-run-categories", name: "Categories" } as CmsCollection,
        fields: new Map([["title", { id: "dry-run-title", name: "Title", type: "string" }]]),
        itemsByTitle: new Map(
          WEBSITE_CATEGORIES.map((category) => [
            category.title,
            { id: `dry-run-${category.slug}`, slug: category.slug, fieldData: {} } as CmsItem,
          ]),
        ),
      };
    }

    collection = (await framer.createCollection("Categories")) as unknown as CmsCollection;
    collections = (await framer.getCollections()) as unknown as CmsCollection[];
    collection = collections.find((candidate) => candidate.name === "Categories") ?? collection;
  }

  let fields = fieldMap(await collection.getFields());
  let titleField = optionalField(fields, "Title") ?? optionalField(fields, "Name");
  if (!titleField) {
    if (dryRun) {
      titleField = { id: "dry-run-title", name: "Title", type: "string" };
      fields.set("title", titleField);
    } else {
      [titleField] = await collection.addFields([{ type: "string", name: "Title", required: true }]);
      fields = fieldMap(await collection.getFields());
    }
  }

  const items = dryRun && collection.id === "dry-run-categories" ? [] : await collection.getItems();
  const itemsByTitle = new Map<WebsiteCategoryTitle, CmsItem>();
  const existingKeys = new Map<string, CmsItem>();

  for (const item of items) {
    const title = entryValue(item.fieldData[titleField.id]);
    existingKeys.set(item.slug.toLowerCase(), item);
    if (title) existingKeys.set(title.toLowerCase(), item);
  }

  const missing = WEBSITE_CATEGORIES.filter((category) => !existingKeys.has(category.title.toLowerCase()));
  if (!dryRun && missing.length > 0) {
    await collection.addItems(
      missing.map((category) => ({
        slug: category.slug,
        draft: false,
        fieldData: {
          [titleField.id]: textField(category.title),
        },
      })),
    );
  }

  const finalItems =
    dryRun && collection.id === "dry-run-categories" ? [...itemsByTitle.values()] : await collection.getItems();

  for (const category of WEBSITE_CATEGORIES) {
    const item =
      finalItems.find((candidate) => {
        const title = entryValue(candidate.fieldData[titleField.id]);
        return candidate.slug === category.slug || title === category.title;
      }) ?? ({ id: `dry-run-${category.slug}`, slug: category.slug, fieldData: {} } as CmsItem);
    itemsByTitle.set(category.title, item);
  }

  return { collection, fields, itemsByTitle };
}

async function ensureWebsiteRelationField(
  websites: CmsCollection,
  categoriesCollectionId: string,
): Promise<{ fields: FieldByName; relationField: CmsField; oldTextField: CmsField | undefined }> {
  let fields = fieldMap(await websites.getFields());
  const currentCategories = optionalField(fields, "Categories");
  const oldTextField = currentCategories?.type === "string" ? currentCategories : undefined;
  let relationField =
    currentCategories?.type === "multiCollectionReference" ? currentCategories : optionalField(fields, "Categories Ref");

  if (!relationField) {
    if (dryRun) {
      relationField = { id: "dry-run-categories-ref", name: "Categories Ref", type: "multiCollectionReference" };
    } else {
      [relationField] = await websites.addFields([
        {
          type: "multiCollectionReference",
          name: oldTextField ? "Categories Ref" : "Categories",
          collectionId: categoriesCollectionId,
        },
      ]);
      fields = fieldMap(await websites.getFields());
      relationField = optionalField(fields, oldTextField ? "Categories Ref" : "Categories") ?? relationField;
    }
  }

  return { fields, relationField, oldTextField };
}

function categoriesForItem(item: CmsItem, fields: FieldByName, oldTextField: CmsField | undefined): WebsiteCategoryTitle[] {
  const titleFieldId = fieldId(fields, "Title");
  const longTitleFieldId = optionalField(fields, "Long Title")?.id;
  const externalLinkFieldId = optionalField(fields, "External Link")?.id;
  const typesFieldId = optionalField(fields, "Types")?.id;
  const platformsFieldId = optionalField(fields, "Platforms")?.id;
  const commentFieldId = optionalField(fields, "Comment")?.id;

  const existingCategories = oldTextField ? splitCategoryText(entryValue(item.fieldData[oldTextField.id])) : [];

  return normalizeWebsiteCategories(existingCategories, {
    title: entryValue(item.fieldData[titleFieldId]) || item.slug,
    longTitle: longTitleFieldId ? entryValue(item.fieldData[longTitleFieldId]) : "",
    url: externalLinkFieldId ? entryValue(item.fieldData[externalLinkFieldId]) : "",
    categories: existingCategories,
    types: typesFieldId ? splitCategoryText(entryValue(item.fieldData[typesFieldId])) : [],
    platforms: platformsFieldId ? splitCategoryText(entryValue(item.fieldData[platformsFieldId])) : [],
    comment: commentFieldId ? stripHtml(entryValue(item.fieldData[commentFieldId])) : "",
  });
}

async function updateItemsInBatches(
  collection: CmsCollection,
  updates: Array<Record<string, unknown>>,
  batchSize = 50,
): Promise<void> {
  for (let index = 0; index < updates.length; index += batchSize) {
    await collection.addItems(updates.slice(index, index + batchSize));
  }
}

async function main(): Promise<void> {
  const framer = await connectFramer();

  try {
    const collections = (await framer.getCollections()) as unknown as CmsCollection[];
    const websites = collections.find((collection) => collection.name === "Websites");
    if (!websites) throw new Error('Framer collection "Websites" was not found');

    const categories = await ensureCategoriesCollection(framer);
    const { fields, relationField, oldTextField } = await ensureWebsiteRelationField(
      websites,
      categories.collection.id,
    );
    const items = await websites.getItems();

    const updates: Array<Record<string, unknown>> = [];
    const counts = new Map<WebsiteCategoryTitle, number>();
    const samples: Array<{ title: string; slug: string; categories: WebsiteCategoryTitle[] }> = [];

    for (const item of items) {
      const itemCategories = categoriesForItem(item, fields, oldTextField);
      for (const category of itemCategories) counts.set(category, (counts.get(category) ?? 0) + 1);

      const referenceIds = itemCategories.map((category) => {
        const categoryItem = categories.itemsByTitle.get(category);
        if (!categoryItem) throw new Error(`Missing seeded category item: ${category}`);
        return categoryItem.id;
      });

      updates.push({
        id: item.id,
        draft: item.draft,
        fieldData: {
          [relationField.id]: multiCollectionReferenceField(referenceIds),
        },
      });

      if (samples.length < 12) {
        samples.push({
          title: entryValue(item.fieldData[fieldId(fields, "Title")]) || item.slug,
          slug: item.slug,
          categories: itemCategories,
        });
      }
    }

    const summary = {
      dryRun,
      finalize,
      websites: items.length,
      categoriesCollectionItems: WEBSITE_CATEGORIES.length,
      relationField: relationField.name,
      oldTextField: oldTextField?.name ?? null,
      allWebsitesMapped: updates.length === items.length,
      categoryCounts: Object.fromEntries(WEBSITE_CATEGORY_TITLES_WITH_COUNTS(counts)),
      samples,
    };

    console.log(JSON.stringify(summary, null, 2));

    if (dryRun) return;

    await updateItemsInBatches(websites, updates);

    if (finalize) {
      if (oldTextField) await websites.removeFields([oldTextField.id]);
      if (relationField.name !== "Categories" && relationField.setAttributes) {
        await relationField.setAttributes({ name: "Categories" });
      }
    }

    console.log(
      JSON.stringify(
        {
          migrated: updates.length,
          finalized: finalize,
          relationField: finalize ? "Categories" : relationField.name,
        },
        null,
        2,
      ),
    );
  } finally {
    await framer.disconnect();
  }
}

function WEBSITE_CATEGORY_TITLES_WITH_COUNTS(counts: Map<WebsiteCategoryTitle, number>): Array<[string, number]> {
  return WEBSITE_CATEGORIES.map((category) => [category.title, counts.get(category.title) ?? 0]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export interface SourceFile {
  urls?: string[];
  discoveryPages?: string[];
}

export interface WebsiteMetadata {
  url: string;
  finalUrl: string;
  title: string;
  description: string;
  siteName: string;
  canonicalUrl: string;
  faviconUrl: string;
  contentType: string;
  statusCode: number | null;
  browserErrors: string[];
  visualContext: {
    viewport: {
      width: number;
      height: number;
    };
    fullPageHeight: number;
    backgroundColor: string;
    fontFamilies: string[];
    headings: string[];
    visibleText: string[];
    imageCount: number;
    buttonCount: number;
    linkCount: number;
  };
  screenshot: {
    thumbnail: Buffer;
    fullPage: Buffer;
    mimeType: "image/jpeg";
  };
}

export interface WebsiteClassification {
  title: string;
  longTitle: string;
  comment: string;
  categories: string[];
  types: string[];
  platforms: string[];
  styles: string[];
  typographies: string[];
  qualityScore: number;
  shouldPublish: boolean;
}

export interface CandidateResult {
  sourceUrl: string;
  metadata: WebsiteMetadata;
  classification: WebsiteClassification;
  aiComment: string;
  slug: string;
  externalLink: string;
}

export interface SyncSummary {
  discovered: number;
  scanned: number;
  skippedDuplicate: number;
  skippedExisting: number;
  skippedInvalid: number;
  skippedLowQuality: number;
  failed: number;
  created: number;
  dryRun: boolean;
  published: boolean;
}

export interface CreatedWebsiteReportItem {
  title: string;
  slug: string;
  externalLink: string;
  dzinerHubLink: string;
  qualityScore: number;
}

export interface SkippedWebsiteReportItem {
  url: string;
  reason: string;
}

export interface FailedWebsiteReportItem {
  url: string;
  error: string;
}

export interface DailyReport {
  reportDate: string;
  generatedAt: string;
  dryRun: boolean;
  published: boolean;
  summary: SyncSummary;
  created: CreatedWebsiteReportItem[];
  skipped: SkippedWebsiteReportItem[];
  failed: FailedWebsiteReportItem[];
}

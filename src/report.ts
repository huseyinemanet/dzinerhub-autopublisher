import { writeFile } from "fs/promises";
import { config } from "./config.js";
import type {
  CandidateResult,
  DailyReport,
  FailedWebsiteReportItem,
  InspirationCandidate,
  InspirationReport,
  InspirationSyncSummary,
  SkippedWebsiteReportItem,
  StoryCandidate,
  StoryReport,
  StorySyncSummary,
  SyncSummary,
} from "./types.js";

function reportDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function dzinerHubLink(slug: string): string {
  return `${config.siteBaseUrl.replace(/\/+$/, "")}/websites/${slug}`;
}

function dzinerHubStoryLink(slug: string): string {
  return `${config.siteBaseUrl.replace(/\/+$/, "")}/stories/${slug}`;
}

function dzinerHubInspirationLink(slug: string): string {
  return `${config.siteBaseUrl.replace(/\/+$/, "")}/inspiration/${slug}`;
}

export class ReportBuilder {
  readonly created: DailyReport["created"] = [];
  readonly skipped: SkippedWebsiteReportItem[] = [];
  readonly failed: FailedWebsiteReportItem[] = [];

  addCreated(candidate: CandidateResult): void {
    this.created.push({
      title: candidate.classification.title,
      slug: candidate.slug,
      externalLink: candidate.externalLink,
      dzinerHubLink: dzinerHubLink(candidate.slug),
      qualityScore: candidate.classification.qualityScore,
    });
  }

  addSkipped(url: string, reason: string): void {
    this.skipped.push({ url, reason });
  }

  addFailed(url: string, error: string): void {
    this.failed.push({ url, error });
  }

  async write(summary: SyncSummary): Promise<DailyReport> {
    const report: DailyReport = {
      reportDate: reportDate(),
      generatedAt: new Date().toISOString(),
      dryRun: summary.dryRun,
      published: summary.published,
      summary,
      created: this.created,
      skipped: this.skipped,
      failed: this.failed,
    };

    await writeFile(config.reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  }
}

export class StoryReportBuilder {
  readonly created: StoryReport["created"] = [];
  readonly skipped: SkippedWebsiteReportItem[] = [];
  readonly failed: FailedWebsiteReportItem[] = [];

  addCreated(candidate: StoryCandidate): void {
    this.created.push({
      title: candidate.title,
      slug: candidate.slug,
      url: candidate.url,
      dzinerHubLink: dzinerHubStoryLink(candidate.slug),
    });
  }

  addSkipped(url: string, reason: string): void {
    this.skipped.push({ url, reason });
  }

  addFailed(url: string, error: string): void {
    this.failed.push({ url, error });
  }

  async write(summary: StorySyncSummary): Promise<StoryReport> {
    const report: StoryReport = {
      reportDate: reportDate(),
      generatedAt: new Date().toISOString(),
      dryRun: summary.dryRun,
      published: summary.published,
      summary,
      created: this.created,
      skipped: this.skipped,
      failed: this.failed,
    };

    await writeFile(process.env.STORY_REPORT_FILE ?? "story-report.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  }
}

export class InspirationReportBuilder {
  readonly created: InspirationReport["created"] = [];
  readonly skipped: SkippedWebsiteReportItem[] = [];
  readonly failed: FailedWebsiteReportItem[] = [];

  addCreated(candidate: InspirationCandidate): void {
    this.created.push({
      title: candidate.title,
      slug: candidate.slug,
      sourceUrl: candidate.finalUrl,
      dzinerHubLink: dzinerHubInspirationLink(candidate.slug),
      tag: candidate.tag,
    });
  }

  addSkipped(url: string, reason: string): void {
    this.skipped.push({ url, reason });
  }

  addFailed(url: string, error: string): void {
    this.failed.push({ url, error });
  }

  async write(summary: InspirationSyncSummary): Promise<InspirationReport> {
    const report: InspirationReport = {
      reportDate: reportDate(),
      generatedAt: new Date().toISOString(),
      dryRun: summary.dryRun,
      published: summary.published,
      summary,
      created: this.created,
      skipped: this.skipped,
      failed: this.failed,
    };

    await writeFile(process.env.INSPIRATION_REPORT_FILE ?? "inspiration-report.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  }
}

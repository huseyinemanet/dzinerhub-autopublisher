# DzinerHub Autopublisher

Automated daily content pipeline for the DzinerHub Framer CMS `Websites` collection.

It discovers curated website inspiration from sources like Land-book, Recent Design, Craftwork, Landingfolio, SiteInspire, Lapa Ninja, One Page Love, and similar galleries; captures screenshots; asks DeepSeek for metadata and art-direction commentary; then creates Framer CMS items. It also curates daily links for the Framer CMS `Stories` collection and selective visual inspiration items for the `Inspiration` collection.

## Features

- Discovers candidate websites from curated showcase pages in `data/sources.json`
- Captures thumbnail and full-page screenshots with ScreenshotAPI.com, with Playwright fallback
- Extracts title, description, canonical URL, favicon, content type, and visible page context
- Uses DeepSeek to classify fixed website page-type categories, types, platforms, styles, typography, quality score, and publish suitability
- Builds a visual profile from the full-page screenshot and generates an art-director style `AI Comment`
- Skips exact-page duplicates using normalized URL identity
- Filters curator subdomains, asset/CDN URLs, Product Hunt links, utility pages, non-HTML pages, weak pages, and blank screenshots
- Writes accepted items into the Framer `Websites` CMS collection
- Supports draft-only review mode and optional Framer publishing
- Runs daily through GitHub Actions
- Curates daily `Stories` links from sources like TLDR, Product Hunt, Hacker News, Techmeme, Sidebar, HeyDesigner, Muzli, Indie Hackers, and AI newsletters
- Curates selective `Inspiration` items from visual art, design, architecture, photography, and culture publications, with strict image and quality filters

## GitHub Action Defaults

The GitHub Action defaults to:

- `DRY_RUN=false`
- `PUBLISH=true`
- `DRAFT_ITEMS=false`

That means the scheduled workflow creates new CMS items, publishes the Framer site, and opens a daily GitHub issue report with the added website links.

## Local Setup

Install dependencies:

```bash
npm install
npm run install:browsers
```

Create `.env` from `.env.example` and fill in the keys:

```bash
cp .env.example .env
```

Run a safe dry run:

```bash
npm run dry
```

Run checks:

```bash
npm run check
npm test
```

Run a real draft sync:

```bash
DRY_RUN=false PUBLISH=false DRAFT_ITEMS=true npm start
```

Run a real sync with publish enabled:

```bash
DRY_RUN=false PUBLISH=true DRAFT_ITEMS=false npm start
```

Run the Stories importer:

```bash
DRY_RUN=false PUBLISH=true DRAFT_ITEMS=false npm run stories
```

Run the Inspiration importer:

```bash
DRY_RUN=false PUBLISH=true DRAFT_ITEMS=false npm run inspiration
```

## GitHub Actions Setup

Create these repository secrets:

- `DEEPSEEK_API_KEY`
- `FRAMER_API_KEY`
- `FRAMER_PROJECT_URL`
- `SCREENSHOTAPI_API_KEY`

Recommended repository variables:

- `DEEPSEEK_MODEL=deepseek-v4-flash`
- `SCREENSHOT_PROVIDER=auto`
- `DRY_RUN=false`
- `READ_FRAMER_IN_DRY_RUN=true`
- `PUBLISH=true`
- `DRAFT_ITEMS=false`
- `MAX_URLS=10`
- `MAX_CREATED=0` (`0` means no cap; useful manual runs can set this to `5`, `10`, etc.)
- `MAX_STORIES=10`
- `MAX_INSPIRATION=5`
- `MAX_DISCOVERY_PAGES=32`
- `MAX_STORY_DISCOVERY_PAGES=32`
- `MAX_INSPIRATION_DISCOVERY_PAGES=32`
- `MAX_DETAIL_PAGES_PER_SOURCE=16`
- `MIN_QUALITY_SCORE=0.68`
- `MIN_INSPIRATION_QUALITY_SCORE=0.82`
- `SITE_BASE_URL=https://dzinerhub.framer.website`

The workflow runs every day at `08:12 Europe/Istanbul`.

After each run, the workflow creates a GitHub issue titled `DzinerHub Daily Autopublish Report - YYYY-MM-DD`. The issue mentions `@huseyinemanet`, includes the number of created items, publish status, and the links for newly added websites.

## Screenshot Quality

`SCREENSHOT_PROVIDER=auto` uses ScreenshotAPI.com when `SCREENSHOTAPI_API_KEY` is present. If the service fails or the key is missing, the pipeline falls back to Playwright so the daily automation can continue.

Use `SCREENSHOT_PROVIDER=playwright` to force local screenshots only.

## Source Configuration

Edit `data/sources.json` to control discovery sources.

- `discoveryPages` contains curator/gallery pages to crawl.
- `urls` is optional and only for one-off manual candidates.

## Website Categories

`Websites > Categories` is a multi-reference field connected to the `Categories` CMS collection. The automation only writes these fixed page-type categories:

`Landing Page`, `Portfolio`, `Blog`, `E-commerce`, `Product Page`, `Product Listing`, `Pricing Page`, `About Us`, `Career`, `Sign Up`, `Made in Framer`, `Other`.

Run the relation migration/report script with:

```bash
DRY_RUN=true npm run migrate:website-categories
```

## Duplicate Policy

Duplicate detection is exact-page based.

These are treated as the same page:

- `https://aave.com`
- `https://www.aave.com/`
- `https://aave.com/?ref=dzinerhub.com&utm_source=x`

These are treated as different pages:

- `https://apple.com/`
- `https://apple.com/iphone-17e/`

When a duplicate is found, the existing CMS item is left untouched and the candidate is skipped.

## License

MIT

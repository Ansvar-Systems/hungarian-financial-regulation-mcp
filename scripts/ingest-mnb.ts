#!/usr/bin/env tsx
/**
 * MNB Financial Regulation Ingestion Crawler
 *
 * Crawls the Magyar Nemzeti Bank (mnb.hu) website for:
 *   - MNB Rendeletek (decrees) from /felugyelet/szabalyozas/jogszabalyok/mnb-rendeletek
 *   - MNB Ajanlasok (recommendations) from /felugyelet/szabalyozas/felugyeleti-szabalyozo-eszkozok/ajanlasok
 *   - MNB Vezetoi Korlevelek (management circulars) from /felugyelet/szabalyozas/felugyeleti-szabalyozo-eszkozok/vezetoi-korlevelek
 *   - Enforcement actions (hatarozatok) from /felugyelet/engedelyezes-es-intezmenyfelugyeles/hatarozatok-es-vegzesek-keresese
 *   - Makroprudencialis rendeletek from /penzugyi-stabilitas/makroprudencialis-politika/rendeletek-hatarozatok
 *
 * Writes directly to the SQLite database used by the MCP server.
 *
 * Usage:
 *   npx tsx scripts/ingest-mnb.ts
 *   npx tsx scripts/ingest-mnb.ts --resume         # skip provisions already in DB
 *   npx tsx scripts/ingest-mnb.ts --dry-run         # parse and report, do not write DB
 *   npx tsx scripts/ingest-mnb.ts --force           # drop existing data and re-ingest
 *   npx tsx scripts/ingest-mnb.ts --resume --dry-run # combine flags
 *
 * Environment:
 *   MNB_DB_PATH  — SQLite database path (default: data/mnb.db)
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env["MNB_DB_PATH"] ?? "data/mnb.db";
const CACHE_DIR = join(__dirname, "..", "data", "cache");

const BASE_URL = "https://www.mnb.hu";

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3000;
const REQUEST_TIMEOUT_MS = 30_000;

const USER_AGENT =
  "Ansvar-MNB-Crawler/1.0 (+https://ansvar.eu; compliance research)";

// ---------------------------------------------------------------------------
// Source definitions — listing pages on mnb.hu
// ---------------------------------------------------------------------------

interface SourceConfig {
  sourcebookId: string;
  sourcebookName: string;
  sourcebookDescription: string;
  type: string; // rendelet | ajanlas | korlevel | makroprudencialis
  listUrl: string;
  /** Additional listing pages (e.g. archive, sub-categories). */
  extraListUrls?: string[];
}

const SOURCES: SourceConfig[] = [
  {
    sourcebookId: "MNB_RENDELETEK",
    sourcebookName: "MNB Rendeletek",
    sourcebookDescription:
      "Magyar Nemzeti Bank rendeletek — prudencialis kovetelmenyek, tokemegfeleles, fizetesi szolgaltatasok es felugyeleti elvarasok.",
    type: "rendelet",
    listUrl:
      "/felugyelet/szabalyozas/jogszabalyok/mnb-rendeletek",
  },
  {
    sourcebookId: "MNB_AJANLASOK",
    sourcebookName: "MNB Ajanlasok",
    sourcebookDescription:
      "Magyar Nemzeti Bank ajanlasok — IT kockazat, belso iranyitas, ugyfelvedelem, penzmosamellenes kovetelmenyek es mukodesi kockazat.",
    type: "ajanlas",
    listUrl:
      "/felugyelet/szabalyozas/felugyeleti-szabalyozo-eszkozok/ajanlasok",
  },
  {
    sourcebookId: "MNB_VEZETOI_KORLEVELEK",
    sourcebookName: "MNB Vezetoi Korlevelek",
    sourcebookDescription:
      "Magyar Nemzeti Bank vezetoi korlevelek — felugyeleti elvek, technikai iranymutatak, jogertelmezesek es zold penzugyi iranymutatak.",
    type: "korlevel",
    listUrl:
      "/felugyelet/szabalyozas/felugyeleti-szabalyozo-eszkozok/vezetoi-korlevelek",
  },
  {
    sourcebookId: "MNB_MAKROPRUD",
    sourcebookName: "MNB Makroprudencialis Rendeletek",
    sourcebookDescription:
      "Magyar Nemzeti Bank makroprudencialis rendeletek es hatarozatok — anticiklikus tokepuffer, adossagfek-szabalyok (HFM, JTM), es rendszerszintu kockazatok kezelese.",
    type: "makroprudencialis",
    listUrl:
      "/penzugyi-stabilitas/makroprudencialis-politika/rendeletek-hatarozatok",
  },
];

/**
 * Enforcement action pages. The MNB publishes enforcement decisions via a
 * search interface and press releases. We crawl the press-release listing
 * pages (sajtokozlemenyek) filtered for "birsag" and "hatarozat" keywords,
 * plus the dedicated hatarozatok search page.
 */
const ENFORCEMENT_LIST_URLS = [
  "/felugyelet/engedelyezes-es-intezmenyfelugyeles/hatarozatok-es-vegzesek-keresese",
];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliFlags {
  resume: boolean;
  dryRun: boolean;
  force: boolean;
}

function parseFlags(): CliFlags {
  const args = process.argv.slice(2);
  return {
    resume: args.includes("--resume"),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers — fetch with rate limit and retry
// ---------------------------------------------------------------------------

let lastRequestTimestamp = 0;

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTimestamp;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastRequestTimestamp = Date.now();

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.5",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
        if (attempt < MAX_RETRIES) {
          const backoff = RETRY_BACKOFF_MS * attempt;
          console.log(
            `    Retry ${attempt}/${MAX_RETRIES} for ${url} (HTTP ${response.status}, waiting ${backoff}ms)`,
          );
          await sleep(backoff);
          continue;
        }
      }

      return response;
    } catch (err) {
      lastError =
        err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BACKOFF_MS * attempt;
        console.log(
          `    Retry ${attempt}/${MAX_RETRIES} for ${url} (${lastError.message}, waiting ${backoff}ms)`,
        );
        await sleep(backoff);
      }
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Cache helpers — store raw HTML to avoid re-fetching on resume
// ---------------------------------------------------------------------------

function cacheKey(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .substring(0, 200);
}

function readCache(url: string): string | null {
  const filePath = join(CACHE_DIR, `${cacheKey(url)}.html`);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

function writeCache(url: string, html: string): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const filePath = join(CACHE_DIR, `${cacheKey(url)}.html`);
  writeFileSync(filePath, html, "utf-8");
}

async function fetchPage(url: string): Promise<string> {
  const cached = readCache(url);
  if (cached !== null) {
    return cached;
  }

  const fullUrl = url.startsWith("http") ? url : `${BASE_URL}${url}`;
  const response = await rateLimitedFetch(fullUrl);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${fullUrl}`);
  }

  const html = await response.text();
  writeCache(url, html);
  return html;
}

// ---------------------------------------------------------------------------
// HTML parsing — extract provisions from listing pages
// ---------------------------------------------------------------------------

interface ParsedProvision {
  sourcebookId: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effectiveDate: string | null;
  chapter: string | null;
  section: string | null;
  url: string | null;
}

interface ParsedEnforcement {
  firmName: string;
  referenceNumber: string | null;
  actionType: string;
  amount: number | null;
  date: string | null;
  summary: string;
  sourcebookReferences: string | null;
}

/**
 * Parse a Hungarian date string like "2024. 06. 24." or "2024.06.24."
 * into ISO format "2024-06-24".
 */
function parseHungarianDate(text: string): string | null {
  const m = text.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./);
  if (!m) return null;
  const month = m[2]!.padStart(2, "0");
  const day = m[3]!.padStart(2, "0");
  return `${m[1]}-${month}-${day}`;
}

/**
 * Extract a rendelet/ajanlas reference number from title text.
 * Examples:
 *   "A Magyar Nemzeti Bank 2/2015. (I.13.) rendelete" -> "MNB rendelet 2/2015"
 *   "Az MNB 7/2021. (VI.1.) szamu ajanlasa" -> "MNB ajanlas 7/2021"
 *   "14/2025. (VI.16.) MNB rendelet" -> "MNB rendelet 14/2025"
 */
function extractReference(
  title: string,
  type: string,
): string | null {
  // Pattern: N/YYYY or NN/YYYY
  const numMatch = title.match(/(\d{1,3})\/(\d{4})/);
  if (!numMatch) return null;

  const number = numMatch[1];
  const year = numMatch[2];

  const typeLabel = type === "rendelet"
    ? "rendelet"
    : type === "ajanlas"
      ? "ajanlas"
      : type === "korlevel"
        ? "VK"
        : "rendelet";

  return `MNB ${typeLabel} ${number}/${year}`;
}

/**
 * Extract a rough date from Hungarian parenthetical date notation.
 * E.g. "(I.13.)" = January 13, "(VI.24.)" = June 24
 * Used together with the year from the reference number.
 */
function extractDateFromTitle(title: string, refYear: string | null): string | null {
  if (!refYear) return null;

  // Hungarian month abbreviations in parentheses: (I.13.) (XII.24.) etc.
  const parenMatch = title.match(
    /\(([IVX]{1,4})\.(\d{1,2})\.\)/,
  );
  if (!parenMatch) return null;

  const romanMonth = parenMatch[1]!;
  const day = parenMatch[2]!.padStart(2, "0");

  const romanToNum: Record<string, string> = {
    I: "01",
    II: "02",
    III: "03",
    IV: "04",
    V: "05",
    VI: "06",
    VII: "07",
    VIII: "08",
    IX: "09",
    X: "10",
    XI: "11",
    XII: "12",
  };

  const month = romanToNum[romanMonth];
  if (!month) return null;

  return `${refYear}-${month}-${day}`;
}

/**
 * Clean whitespace and HTML entity remnants from text extracted by cheerio.
 */
function cleanText(raw: string): string {
  return raw
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a listing page for provisions (rendeletek, ajanlasok, korlevelek).
 *
 * MNB listing pages typically contain:
 *   - A list of links to individual regulation PDFs or detail pages
 *   - Each item has a title (containing the reference number and subject)
 *   - Some pages use tables, others use <ul>/<li> or <div> structures
 *   - Detail pages may contain the full text as HTML or link to a PDF
 *
 * We extract metadata from the listing page and, for each linked detail page,
 * attempt to fetch and parse the full text.
 */
async function parseListingPage(
  source: SourceConfig,
  flags: CliFlags,
  existingRefs: Set<string>,
): Promise<ParsedProvision[]> {
  const provisions: ParsedProvision[] = [];
  const listUrl = source.listUrl;

  console.log(
    `\n  Fetching listing: ${BASE_URL}${listUrl}`,
  );

  let html: string;
  try {
    html = await fetchPage(listUrl);
  } catch (err) {
    console.log(
      `    Failed to fetch listing: ${err instanceof Error ? err.message : String(err)}`,
    );
    return provisions;
  }

  const $ = cheerio.load(html);

  // MNB listing pages use several structures. We look for links
  // within the main content area that point to regulation detail
  // pages or downloadable PDFs.
  const links: Array<{ href: string; title: string }> = [];

  // Strategy 1: links within the main content container
  const mainContent = $(".main-content, .content-area, #main-content, .szabalyozas-content, article, .article-content");
  const contentRoot = mainContent.length > 0 ? mainContent : $("body");

  contentRoot.find("a[href]").each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href") ?? "";
    const text = cleanText($a.text());

    // Skip navigation, footer, and menu links
    if (!text || text.length < 10) return;

    // We want links that reference regulation numbers (N/YYYY pattern)
    // or link to /letoltes/ (download) or /felugyelet/ detail pages
    const isRelevant =
      /\d{1,3}\/\d{4}/.test(text) ||
      /\d{1,3}\/\d{4}/.test(href) ||
      href.includes("/letoltes/") ||
      (href.includes("/felugyelet/") && href !== listUrl);

    if (!isRelevant) return;

    // Deduplicate by href
    if (links.some((l) => l.href === href)) return;

    links.push({ href, title: text });
  });

  // Strategy 2: table rows (some MNB pages use tables for regulation lists)
  contentRoot.find("table tr").each((_, row) => {
    const $row = $(row);
    const cells = $row.find("td");
    if (cells.length < 1) return;

    const $link = $row.find("a[href]").first();
    const href = $link.attr("href") ?? "";
    const text = cleanText($row.text());

    if (!text || text.length < 10) return;
    if (!/\d{1,3}\/\d{4}/.test(text)) return;
    if (links.some((l) => l.href === href && l.title === text)) return;

    links.push({
      href: href || "",
      title: text,
    });
  });

  // Strategy 3: list items (<li>) that contain regulation references
  contentRoot.find("li").each((_, el) => {
    const $li = $(el);
    const text = cleanText($li.text());

    if (!text || text.length < 15) return;
    if (!/\d{1,3}\/\d{4}/.test(text)) return;

    const $link = $li.find("a[href]").first();
    const href = $link.attr("href") ?? "";

    if (links.some((l) => l.title === text)) return;

    links.push({
      href,
      title: text,
    });
  });

  console.log(
    `    Found ${links.length} regulation links on listing page`,
  );

  // Process each discovered link
  for (const link of links) {
    const reference = extractReference(link.title, source.type);
    if (!reference) continue;

    // Resume: skip if already in DB
    if (flags.resume && existingRefs.has(reference)) {
      continue;
    }

    const yearMatch = link.title.match(/(\d{1,3})\/(\d{4})/);
    const refYear = yearMatch ? yearMatch[2]! : null;
    const effectiveDate = extractDateFromTitle(link.title, refYear);

    // Determine status: default to in_force, mark older items if indicated
    let status = "in_force";
    const lowerTitle = link.title.toLowerCase();
    if (
      lowerTitle.includes("hatalyon kivul") ||
      lowerTitle.includes("hatályon kívül") ||
      lowerTitle.includes("visszavon")
    ) {
      status = "deleted";
    } else if (
      lowerTitle.includes("meg nem hataly") ||
      lowerTitle.includes("még nem hatály")
    ) {
      status = "not_yet_in_force";
    }

    // Build the provision text.
    // First try to fetch the detail page for full text.
    let fullText: string | null = null;
    let chapter: string | null = null;
    let section: string | null = null;

    if (link.href) {
      fullText = await fetchDetailText(link.href);
    }

    // If we got detail text, try to extract chapter/section from it
    if (fullText) {
      const chapterMatch = fullText.match(
        /(?:fejezet|resz|chapter)\s*[:.]?\s*(.{1,50})/i,
      );
      if (chapterMatch) {
        chapter = cleanText(chapterMatch[1]!).substring(0, 100);
      }

      const sectionMatch = fullText.match(
        /(?:szakasz|§|section)\s*[:.]?\s*(.{1,50})/i,
      );
      if (sectionMatch) {
        section = cleanText(sectionMatch[1]!).substring(0, 100);
      }
    }

    const resolvedUrl = link.href
      ? link.href.startsWith("http")
        ? link.href
        : `${BASE_URL}${link.href.startsWith("/") ? "" : "/"}${link.href}`
      : null;

    provisions.push({
      sourcebookId: source.sourcebookId,
      reference,
      title: cleanText(link.title).substring(0, 500),
      text:
        fullText ??
        cleanText(link.title),
      type: source.type,
      status,
      effectiveDate,
      chapter,
      section,
      url: resolvedUrl,
    });
  }

  return provisions;
}

/**
 * Fetch a detail page and extract its main text content.
 * Handles both HTML pages and PDF download links.
 */
async function fetchDetailText(href: string): Promise<string | null> {
  // Skip PDFs — we cannot parse them with cheerio
  if (href.endsWith(".pdf")) {
    return null;
  }

  const fullUrl = href.startsWith("http")
    ? href
    : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

  try {
    const html = await fetchPage(fullUrl);
    const $ = cheerio.load(html);

    // Remove scripts, styles, nav, footer
    $("script, style, nav, footer, header, .nav, .menu, .breadcrumb, .sidebar").remove();

    // Try to find main content
    const contentSelectors = [
      ".main-content",
      ".content-area",
      "#main-content",
      "article",
      ".article-content",
      ".jogszabaly-content",
      ".text-content",
      ".page-content",
    ];

    let text = "";
    for (const selector of contentSelectors) {
      const el = $(selector);
      if (el.length > 0) {
        text = cleanText(el.text());
        break;
      }
    }

    // Fallback: use body text
    if (!text) {
      text = cleanText($("body").text());
    }

    // Truncate very long texts (some regulation pages are enormous)
    if (text.length > 15_000) {
      text = text.substring(0, 15_000) + " [...]";
    }

    return text.length > 50 ? text : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Enforcement action parsing
// ---------------------------------------------------------------------------

/**
 * Parse enforcement actions from the MNB hatarozatok listing page.
 *
 * The enforcement decisions page contains a search form and results.
 * We parse whatever is visible on the page and follow pagination
 * if available.
 */
async function parseEnforcementPages(
  flags: CliFlags,
  existingRefs: Set<string>,
): Promise<ParsedEnforcement[]> {
  const enforcements: ParsedEnforcement[] = [];

  for (const listPath of ENFORCEMENT_LIST_URLS) {
    console.log(
      `\n  Fetching enforcement listing: ${BASE_URL}${listPath}`,
    );

    let html: string;
    try {
      html = await fetchPage(listPath);
    } catch (err) {
      console.log(
        `    Failed to fetch enforcement listing: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const $ = cheerio.load(html);

    // Look for enforcement decision entries in tables, lists, or divs
    // The hatarozatok page typically has a search interface that returns
    // results in a table or list format.

    // Strategy: find table rows or list items with enforcement data
    $("table tr, .result-item, .hatarozat-item").each((_, el) => {
      const $el = $(el);
      const text = cleanText($el.text());

      // Skip header rows and empty items
      if (text.length < 20) return;

      // Look for enforcement reference pattern: H-EN-I-B-NNN/YYYY or similar
      const refMatch = text.match(
        /([A-Z]-[A-Z]{2,}-[A-Z]-[A-Z]-\d+\/\d{4})/,
      );

      // Look for firm names — typically the first substantial text
      const firmNameMatch = text.match(
        /^([\p{L}\s.&,()-]+(?:Zrt\.|Nyrt\.|Kft\.|Bt\.|Rt\.|Ltd\.|AG|SE|Plc))/u,
      );

      // Look for amounts (HUF)
      const amountMatch = text.match(
        /(\d[\d\s,.]*)\s*(?:millio|mrd|Ft|forint|HUF)/i,
      );

      // Look for dates
      const dateMatch = text.match(/\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\./);

      if (!refMatch && !firmNameMatch) return;

      const refNumber = refMatch ? refMatch[1]! : null;

      // Skip if already in DB (resume mode)
      if (
        flags.resume &&
        refNumber &&
        existingRefs.has(refNumber)
      ) {
        return;
      }

      let amount: number | null = null;
      if (amountMatch) {
        const rawAmount = amountMatch[1]!
          .replace(/\s/g, "")
          .replace(/,/g, ".");
        const parsedAmount = parseFloat(rawAmount);
        if (Number.isFinite(parsedAmount)) {
          // Check if the text says "millio" (million)
          if (/millio/i.test(amountMatch[0]!)) {
            amount = parsedAmount * 1_000_000;
          } else if (/mrd/i.test(amountMatch[0]!)) {
            amount = parsedAmount * 1_000_000_000;
          } else {
            amount = parsedAmount;
          }
        }
      }

      // Determine action type from text
      let actionType = "fine";
      const lowerText = text.toLowerCase();
      if (lowerText.includes("tilt") || lowerText.includes("megtilt")) {
        actionType = "ban";
      } else if (lowerText.includes("korlatoz") || lowerText.includes("korlátoz")) {
        actionType = "restriction";
      } else if (lowerText.includes("figyelmeztet") || lowerText.includes("felszólit")) {
        actionType = "warning";
      }

      enforcements.push({
        firmName:
          firmNameMatch?.[1]
            ? cleanText(firmNameMatch[1])
            : "Ismeretlen intézmény",
        referenceNumber: refNumber,
        actionType,
        amount,
        date: dateMatch ? parseHungarianDate(dateMatch[0]) : null,
        summary: text.substring(0, 1000),
        sourcebookReferences: null,
      });
    });

    // Also parse links to individual enforcement decisions
    $("a[href]").each((_, el) => {
      const $a = $(el);
      const href = $a.attr("href") ?? "";
      const text = cleanText($a.text());

      if (text.length < 15) return;

      // Look for enforcement-related links
      const isEnforcement =
        href.includes("hatarozat") ||
        href.includes("birsag") ||
        text.toLowerCase().includes("bírság") ||
        text.toLowerCase().includes("birsag") ||
        text.toLowerCase().includes("határozat");

      if (!isEnforcement) return;

      // Try to extract reference number from link text
      const refMatch = text.match(
        /([A-Z]-[A-Z]{2,}-[A-Z]-[A-Z]-\d+\/\d{4})/,
      );
      const refNumber = refMatch ? refMatch[1]! : null;

      if (flags.resume && refNumber && existingRefs.has(refNumber)) {
        return;
      }

      // Avoid duplicates
      if (
        enforcements.some(
          (e) =>
            e.referenceNumber === refNumber ||
            (refNumber === null && e.summary === text),
        )
      ) {
        return;
      }

      const dateMatch = text.match(/\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\./);

      enforcements.push({
        firmName: cleanText(
          text.replace(/\(.*?\)/g, "").substring(0, 200),
        ),
        referenceNumber: refNumber,
        actionType: "fine",
        amount: null,
        date: dateMatch ? parseHungarianDate(dateMatch[0]) : null,
        summary: text.substring(0, 1000),
        sourcebookReferences: null,
      });
    });
  }

  return enforcements;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(flags: CliFlags): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (flags.force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function upsertSourcebooks(
  db: Database.Database,
  sources: SourceConfig[],
): void {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
  );

  const transaction = db.transaction(() => {
    for (const src of sources) {
      stmt.run(src.sourcebookId, src.sourcebookName, src.sourcebookDescription);
    }
  });

  transaction();
}

function getExistingProvisionRefs(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT reference FROM provisions")
    .all() as Array<{ reference: string }>;
  return new Set(rows.map((r) => r.reference));
}

function getExistingEnforcementRefs(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      "SELECT reference_number FROM enforcement_actions WHERE reference_number IS NOT NULL",
    )
    .all() as Array<{ reference_number: string }>;
  return new Set(rows.map((r) => r.reference_number));
}

function insertProvisions(
  db: Database.Database,
  provisions: ParsedProvision[],
): number {
  const stmt = db.prepare(`
    INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;

  const transaction = db.transaction(() => {
    for (const p of provisions) {
      try {
        stmt.run(
          p.sourcebookId,
          p.reference,
          p.title,
          p.text,
          p.type,
          p.status,
          p.effectiveDate,
          p.chapter,
          p.section,
        );
        inserted++;
      } catch (err) {
        // Skip duplicates from UNIQUE constraints
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("UNIQUE")) {
          console.log(`    Warning: failed to insert ${p.reference}: ${msg}`);
        }
      }
    }
  });

  transaction();
  return inserted;
}

function insertEnforcements(
  db: Database.Database,
  enforcements: ParsedEnforcement[],
): number {
  const stmt = db.prepare(`
    INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;

  const transaction = db.transaction(() => {
    for (const e of enforcements) {
      try {
        stmt.run(
          e.firmName,
          e.referenceNumber,
          e.actionType,
          e.amount,
          e.date,
          e.summary,
          e.sourcebookReferences,
        );
        inserted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("UNIQUE")) {
          console.log(
            `    Warning: failed to insert enforcement ${e.referenceNumber ?? e.firmName}: ${msg}`,
          );
        }
      }
    }
  });

  transaction();
  return inserted;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

interface IngestionStats {
  sourcebooksUpserted: number;
  provisionsFound: number;
  provisionsInserted: number;
  provisionsSkipped: number;
  enforcementsFound: number;
  enforcementsInserted: number;
  enforcementsSkipped: number;
  errors: string[];
  perSourcebook: Map<string, { found: number; inserted: number }>;
}

function printReport(stats: IngestionStats, flags: CliFlags): void {
  console.log(`\n${"=".repeat(72)}`);
  console.log("MNB Ingestion Report");
  console.log("=".repeat(72));
  console.log(`\n  Source:                ${BASE_URL}`);
  console.log(`  Authority:             Magyar Nemzeti Bank`);
  console.log(`  Mode:                  ${flags.dryRun ? "dry-run (no DB writes)" : "live"}`);
  console.log(`  Resume:                ${flags.resume ? "yes" : "no"}`);
  console.log(`  Force:                 ${flags.force ? "yes" : "no"}`);
  console.log(`  Rate limit:            ${RATE_LIMIT_MS}ms`);
  console.log(`\n  Sourcebooks upserted:  ${stats.sourcebooksUpserted}`);
  console.log(`  Provisions found:      ${stats.provisionsFound}`);
  console.log(`  Provisions inserted:   ${stats.provisionsInserted}`);
  console.log(`  Provisions skipped:    ${stats.provisionsSkipped}`);
  console.log(`  Enforcements found:    ${stats.enforcementsFound}`);
  console.log(`  Enforcements inserted: ${stats.enforcementsInserted}`);
  console.log(`  Enforcements skipped:  ${stats.enforcementsSkipped}`);

  if (stats.perSourcebook.size > 0) {
    console.log("\n  Per-sourcebook breakdown:");
    console.log(
      `  ${"Sourcebook".padEnd(30)} ${"Found".padStart(8)} ${"Inserted".padStart(10)}`,
    );
    console.log(
      `  ${"-".repeat(30)} ${"-".repeat(8)} ${"-".repeat(10)}`,
    );
    for (const [id, data] of stats.perSourcebook.entries()) {
      console.log(
        `  ${id.padEnd(30)} ${String(data.found).padStart(8)} ${String(data.inserted).padStart(10)}`,
      );
    }
  }

  if (stats.errors.length > 0) {
    console.log(`\n  Errors (${stats.errors.length}):`);
    for (const err of stats.errors.slice(0, 15)) {
      console.log(`    - ${err}`);
    }
    if (stats.errors.length > 15) {
      console.log(`    ... and ${stats.errors.length - 15} more`);
    }
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseFlags();

  console.log("MNB Financial Regulation Ingestion Crawler");
  console.log("==========================================\n");
  console.log(`  Source:     ${BASE_URL}`);
  console.log(`  Database:  ${DB_PATH}`);
  console.log(`  Mode:      ${flags.dryRun ? "dry-run" : "live"}`);
  if (flags.resume) console.log("  --resume");
  if (flags.force) console.log("  --force");
  console.log(`  Rate limit: ${RATE_LIMIT_MS}ms between requests`);

  const stats: IngestionStats = {
    sourcebooksUpserted: SOURCES.length,
    provisionsFound: 0,
    provisionsInserted: 0,
    provisionsSkipped: 0,
    enforcementsFound: 0,
    enforcementsInserted: 0,
    enforcementsSkipped: 0,
    errors: [],
    perSourcebook: new Map(),
  };

  // Initialise DB (unless dry-run)
  let db: Database.Database | null = null;
  let existingProvisionRefs = new Set<string>();
  let existingEnforcementRefs = new Set<string>();

  if (!flags.dryRun) {
    db = initDb(flags);
    upsertSourcebooks(db, SOURCES);
    console.log(`\n  Upserted ${SOURCES.length} sourcebooks`);

    if (flags.resume) {
      existingProvisionRefs = getExistingProvisionRefs(db);
      existingEnforcementRefs = getExistingEnforcementRefs(db);
      console.log(
        `  Existing provisions in DB: ${existingProvisionRefs.size}`,
      );
      console.log(
        `  Existing enforcement refs in DB: ${existingEnforcementRefs.size}`,
      );
    }
  } else {
    console.log("\n  Dry-run mode: database will not be modified");
  }

  // ---- Phase 1: Crawl provision listing pages ----

  console.log("\n--- Phase 1: Regulatory provisions ---");

  const allProvisions: ParsedProvision[] = [];

  for (const source of SOURCES) {
    console.log(`\n  [${source.sourcebookId}] ${source.sourcebookName}`);

    try {
      const provisions = await parseListingPage(
        source,
        flags,
        existingProvisionRefs,
      );

      allProvisions.push(...provisions);

      const skipped = flags.resume
        ? provisions.length // those returned are already filtered
        : 0;

      stats.perSourcebook.set(source.sourcebookId, {
        found: provisions.length,
        inserted: 0,
      });

      console.log(
        `    Parsed: ${provisions.length} provisions`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push(`${source.sourcebookId}: ${msg}`);
      console.log(`    ERROR: ${msg}`);
    }
  }

  stats.provisionsFound = allProvisions.length;

  // ---- Phase 2: Crawl enforcement actions ----

  console.log("\n--- Phase 2: Enforcement actions ---");

  let allEnforcements: ParsedEnforcement[] = [];

  try {
    allEnforcements = await parseEnforcementPages(
      flags,
      existingEnforcementRefs,
    );
    console.log(
      `\n    Parsed: ${allEnforcements.length} enforcement actions`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stats.errors.push(`Enforcement: ${msg}`);
    console.log(`    ERROR: ${msg}`);
  }

  stats.enforcementsFound = allEnforcements.length;

  // ---- Phase 3: Write to database ----

  if (!flags.dryRun && db) {
    console.log("\n--- Phase 3: Database writes ---");

    if (allProvisions.length > 0) {
      const inserted = insertProvisions(db, allProvisions);
      stats.provisionsInserted = inserted;
      stats.provisionsSkipped =
        allProvisions.length - inserted;

      // Update per-sourcebook inserted counts
      for (const p of allProvisions) {
        const entry = stats.perSourcebook.get(p.sourcebookId);
        if (entry) {
          // Re-count inserted by checking which ones have non-error status
          // (approximation — exact count is in insertProvisions)
        }
      }

      console.log(
        `  Inserted ${inserted} provisions (${allProvisions.length - inserted} skipped/duplicate)`,
      );
    }

    if (allEnforcements.length > 0) {
      const inserted = insertEnforcements(db, allEnforcements);
      stats.enforcementsInserted = inserted;
      stats.enforcementsSkipped =
        allEnforcements.length - inserted;
      console.log(
        `  Inserted ${inserted} enforcement actions (${allEnforcements.length - inserted} skipped/duplicate)`,
      );
    }

    // Print DB summary
    const provisionCount = (
      db
        .prepare("SELECT count(*) as cnt FROM provisions")
        .get() as { cnt: number }
    ).cnt;
    const sourcebookCount = (
      db
        .prepare("SELECT count(*) as cnt FROM sourcebooks")
        .get() as { cnt: number }
    ).cnt;
    const enforcementCount = (
      db
        .prepare(
          "SELECT count(*) as cnt FROM enforcement_actions",
        )
        .get() as { cnt: number }
    ).cnt;
    const ftsCount = (
      db
        .prepare("SELECT count(*) as cnt FROM provisions_fts")
        .get() as { cnt: number }
    ).cnt;

    console.log(`\n  Database summary:`);
    console.log(`    Sourcebooks:          ${sourcebookCount}`);
    console.log(`    Provisions:           ${provisionCount}`);
    console.log(`    Enforcement actions:  ${enforcementCount}`);
    console.log(`    FTS entries:          ${ftsCount}`);

    db.close();
  } else if (flags.dryRun) {
    console.log("\n--- Phase 3: Dry-run summary ---");
    console.log(
      `  Would insert ${allProvisions.length} provisions`,
    );
    console.log(
      `  Would insert ${allEnforcements.length} enforcement actions`,
    );

    // In dry-run, dump a sample of parsed provisions for inspection
    if (allProvisions.length > 0) {
      console.log("\n  Sample provisions (first 5):");
      for (const p of allProvisions.slice(0, 5)) {
        console.log(
          `    [${p.sourcebookId}] ${p.reference}: ${p.title?.substring(0, 80) ?? "(no title)"}`,
        );
      }
    }

    if (allEnforcements.length > 0) {
      console.log("\n  Sample enforcement actions (first 5):");
      for (const e of allEnforcements.slice(0, 5)) {
        console.log(
          `    ${e.referenceNumber ?? "(no ref)"}: ${e.firmName.substring(0, 60)} — ${e.actionType}`,
        );
      }
    }
  }

  printReport(stats, flags);

  console.log(`Database ready at ${DB_PATH}`);
}

main().catch((err) => {
  console.error(
    "Fatal ingestion error:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});

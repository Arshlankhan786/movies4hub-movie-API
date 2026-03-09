/**
 * VidCloud / RabbitStream provider
 *
 * Scraping flow:
 *   1.  Fetch a TMDB-ID-aware aggregator page (2embed.cc).
 *   2.  Parse the page for an iframe / script URL pointing at rabbitstream.net.
 *   3.  Fetch that RabbitStream embed page.
 *   4.  Extract `data-id` (server source ID) and the 48-char nonce key.
 *   5.  Call the getSources JSON endpoint.
 *   6.  Return HLS / MP4 sources with the required Referer header.
 *
 * Sources are cached in Redis.  Empty results have a short TTL so the next
 * cold start re-tries quickly.  Non-empty results are kept for 1 hour.
 *
 * NOTE:  The aggregator and embed domains may change — update the constants
 *        at the top of this file when they do.  The scraping logic itself
 *        is designed to be resilient (every step returns [] on failure).
 */

import * as cheerio from "cheerio";
import type { MovieDetails, TvShowDetails } from "tmdb-ts";
import { UserAgent } from "../helpers/util";
import redis from "../lib/redis";
import type { Source } from "../types/types";

// ── constants ────────────────────────────────────────────────────────────────

/** TMDB-ID-aware aggregator that embeds VidCloud servers. */
const AGGREGATOR_MOVIE = (id: number) =>
    `https://www.2embed.cc/embed/${id}`;
const AGGREGATOR_TV = (id: number, s: number, e: number) =>
    `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`;

/** RabbitStream origin — used as Referer / Origin on the getSources call. */
const RABBIT_ORIGIN = "https://rabbitstream.net";

const VIDCLOUD_SOURCE_CACHE_TTL          = 3_600; // 1 hour
const VIDCLOUD_SOURCE_NOT_FOUND_CACHE_TTL = 900;  // 15 minutes

// ── nonce extraction ─────────────────────────────────────────────────────────

/**
 * RabbitStream injects a 48-char nonce into the embed page HTML using several
 * obfuscation patterns.  We try each one in order until one succeeds.
 */
function extractNonce(html: string): string | null {
    // Pattern 1: window._lk_db = { x:"16chars", y:"16chars", z:"16chars" }
    const lkDb = html.match(/window\._lk_db\s*=\s*\{[\s\S]*?\}/i);
    if (lkDb) {
        const x = lkDb[0].match(/\bx\s*:\s*["']([A-Za-z0-9]{16})["']/i)?.[1];
        const y = lkDb[0].match(/\by\s*:\s*["']([A-Za-z0-9]{16})["']/i)?.[1];
        const z = lkDb[0].match(/\bz\s*:\s*["']([A-Za-z0-9]{16})["']/i)?.[1];
        if (x && y && z) return x + y + z;
    }

    // Pattern 2: <script nonce="48chars">
    const scriptNonce = html.match(
        /<script\b[^>]*\bnonce\s*=\s*["']([A-Za-z0-9]{48})["'][^>]*>/i,
    )?.[1];
    if (scriptNonce) return scriptNonce;

    // Pattern 3: window._xy_ws = "48chars"
    const xyWs = html.match(
        /window\._xy_ws\s*=\s*["']([A-Za-z0-9]{48})["']/i,
    )?.[1];
    if (xyWs) return xyWs;

    // Pattern 4: data-dpi="48chars"
    const dpi = html.match(/\bdata-dpi\s*=\s*["']([A-Za-z0-9]{48})["']/i)?.[1];
    if (dpi) return dpi;

    // Pattern 5: <meta name="_gg_fb" content="48chars">
    const ggFb = html.match(
        /<meta\b[^>]*\bname\s*=\s*["']_gg_fb["'][^>]*\bcontent\s*=\s*["']([A-Za-z0-9]{48})["'][^>]*>/i,
    )?.[1];
    if (ggFb) return ggFb;

    // Pattern 6: _is_th:48chars
    const isTh = html.match(/_is_th\s*:\s*([A-Za-z0-9]{48})/i)?.[1];
    if (isTh) return isTh;

    return null;
}

// ── core extraction ──────────────────────────────────────────────────────────

/**
 * Given a fully-resolved RabbitStream embed URL, fetch the page, extract
 * data-id + nonce, call the getSources API, and return typed Source objects.
 */
async function extractFromRabbitStream(
    embedUrl: string,
    pageReferer: string,
): Promise<Source[]> {
    const embedHeaders = {
        "User-Agent":  UserAgent,
        "Referer":     pageReferer,
        "Accept":      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    };

    // ── step A: fetch embed page ─────────────────────────────────────────────
    let embedHtml: string;
    try {
        const res = await fetch(embedUrl, { headers: embedHeaders });
        if (!res.ok) {
            console.log(`[VidCloud] Embed fetch failed (${res.status}): ${embedUrl}`);
            return [];
        }
        embedHtml = await res.text();
    } catch (err) {
        console.log("[VidCloud] Network error fetching embed:", err);
        return [];
    }

    // ── step B: extract data-id and nonce ────────────────────────────────────
    const dataId = embedHtml.match(/\bdata-id\s*=\s*["']([^"']+)["']/i)?.[1];
    const nonce  = extractNonce(embedHtml);

    if (!dataId || !nonce) {
        console.log("[VidCloud] Could not extract data-id or nonce from embed page");
        return [];
    }

    console.log(`[VidCloud] data-id=${dataId}  nonce=${nonce.slice(0, 8)}…`);

    // ── step C: determine getSources endpoint ────────────────────────────────
    // RabbitStream has cycled through embed-4, embed-5, embed-6 over time.
    // We infer from the embed URL itself; fall back to embed-4.
    const embedVersion = embedUrl.match(/embed-(\d+)/i)?.[1] ?? "4";
    const apiUrl = `${RABBIT_ORIGIN}/ajax/embed-${embedVersion}/getSources?id=${dataId}&_k=${nonce}`;

    const apiHeaders = {
        "User-Agent":       UserAgent,
        "Referer":          embedUrl,
        "Origin":           RABBIT_ORIGIN,
        "X-Requested-With": "XMLHttpRequest",
        "Accept":           "application/json",
    };

    // ── step D: fetch sources JSON ───────────────────────────────────────────
    let json: any;
    try {
        const apiRes = await fetch(apiUrl, { headers: apiHeaders });
        if (!apiRes.ok) {
            console.log(`[VidCloud] getSources API failed (${apiRes.status})`);
            return [];
        }
        json = await apiRes.json();
    } catch (err) {
        console.log("[VidCloud] Network error on getSources:", err);
        return [];
    }

    const rawSources = json?.sources;

    if (!rawSources || rawSources.length === 0) {
        console.log("[VidCloud] Empty sources array from API");
        return [];
    }

    // Sources can come back as a plain array (good) or as an AES-encrypted
    // string (not supported without the rotating key — skip gracefully).
    if (typeof rawSources === "string") {
        console.log("[VidCloud] Encrypted sources detected — skipping");
        return [];
    }

    // ── step E: normalise into Source[] ─────────────────────────────────────
    const corsHeaders = {
        "Referer": `${RABBIT_ORIGIN}/`,
        "Origin":  RABBIT_ORIGIN,
    };

    const sources: Source[] = [];

    for (const src of rawSources as any[]) {
        if (!src?.file || typeof src.file !== "string") continue;

        const isHls = src.file.includes(".m3u8") || src.type === "hls";
        const quality = src.label
            ? parseInt(String(src.label).replace(/\D/g, ""), 10) || undefined
            : undefined;

        sources.push({
            url:     src.file,
            dub:     "original",
            type:    isHls ? "hls" : "mp4",
            quality,
            headers: corsHeaders,
        });
    }

    console.log(`[VidCloud] Resolved ${sources.length} source(s) from ${embedUrl}`);
    return sources;
}

// ── aggregator page scraper ──────────────────────────────────────────────────

/**
 * Fetch the 2embed.cc aggregator page for a TMDB ID and locate any iframe /
 * anchor / script reference that points at a RabbitStream embed URL.
 */
async function findRabbitStreamUrl(
    aggregatorUrl: string,
): Promise<string | null> {
    let html: string;
    try {
        const res = await fetch(aggregatorUrl, {
            headers: { "User-Agent": UserAgent },
        });
        if (!res.ok) {
            console.log(`[VidCloud] Aggregator fetch failed (${res.status}): ${aggregatorUrl}`);
            return null;
        }
        html = await res.text();
    } catch (err) {
        console.log("[VidCloud] Network error fetching aggregator:", err);
        return null;
    }

    const $ = cheerio.load(html);

    // 1. Direct iframe src pointing at rabbitstream / vidcloud
    let found: string | null = null;
    $("iframe, frame").each((_, el) => {
        const src = $(el).attr("src") ?? "";
        if (
            src.includes("rabbitstream.net") ||
            src.includes("vidcloud")          ||
            src.includes("embed-4")           ||
            src.includes("embed-5")
        ) {
            found = src.startsWith("//") ? "https:" + src : src;
            return false; // break
        }
    });
    if (found) return found;

    // 2. Regex over raw HTML for any rabbitstream URL
    const rawMatch = html.match(
        /["'`](https?:\/\/(?:rabbitstream\.net|vidcloud\d*\.(?:com|to))[^"'`\s]+)["'`]/,
    );
    if (rawMatch?.[1]) return rawMatch[1];

    // 3. data-src / data-embed attributes
    $("[data-src], [data-embed]").each((_, el) => {
        const src = $(el).attr("data-src") ?? $(el).attr("data-embed") ?? "";
        if (src.includes("rabbitstream") || src.includes("vidcloud")) {
            found = src;
            return false;
        }
    });

    return found;
}

// ── public entry point ───────────────────────────────────────────────────────

export async function getVidCloudSources(
    serve_cache = true,
    type: "movie" | "tv",
    tmdbMedia: MovieDetails | TvShowDetails,
    season = 0,
    episode = 0,
): Promise<Source[]> {
    const { id } = tmdbMedia;

    const cacheKey =
        type === "movie"
            ? `vidcloud:movie:sources:${id}`
            : `vidcloud:tv:sources:${id}:${season}:${episode}`;

    let sources: Source[] = [];

    try {
        // ── cache read ───────────────────────────────────────────────────────
        if (serve_cache) {
            const cached = await redis.get(cacheKey);
            if (cached) {
                console.log("[VidCloud] served cached sources");
                return JSON.parse(cached) as Source[];
            }
        }

        // ── build aggregator URL ─────────────────────────────────────────────
        const aggregatorUrl =
            type === "movie"
                ? AGGREGATOR_MOVIE(id)
                : AGGREGATOR_TV(id, season, episode);

        console.log(`[VidCloud] Fetching aggregator: ${aggregatorUrl}`);

        // ── scrape aggregator for RabbitStream embed URL ─────────────────────
        const rabbitUrl = await findRabbitStreamUrl(aggregatorUrl);
        if (!rabbitUrl) {
            console.log("[VidCloud] No RabbitStream URL found in aggregator page");
        } else {
            console.log(`[VidCloud] Found RabbitStream URL: ${rabbitUrl}`);
            sources = await extractFromRabbitStream(rabbitUrl, aggregatorUrl);
        }

        // ── cache write ──────────────────────────────────────────────────────
        const ttl = sources.length > 0
            ? VIDCLOUD_SOURCE_CACHE_TTL
            : VIDCLOUD_SOURCE_NOT_FOUND_CACHE_TTL;
        redis.set(cacheKey, JSON.stringify(sources), "EX", ttl);

    } catch (err) {
        console.log("[VidCloud] Unexpected error:", err);
    }

    return sources;
}

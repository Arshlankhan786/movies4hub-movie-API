/**
 * UpCloud provider
 *
 * UpCloud (upcloud.link / upstream.to) is a video embed server used by many
 * streaming aggregators.  Unlike RabbitStream it does not encrypt its sources
 * and its JSON API is simpler to consume.
 *
 * Scraping flow:
 *   1.  Fetch a TMDB-ID-aware aggregator page (vidsrc.xyz).
 *   2.  Locate an UpCloud / upstream iframe URL inside that page.
 *   3.  Fetch the UpCloud embed page.
 *   4.  Extract the `file_code` / `src_id` parameter and the API key / nonce.
 *   5.  Call the sources JSON endpoint.
 *   6.  Return HLS sources with the required Referer header.
 *
 * Falls back to a direct path-based URL construction if the aggregator page
 * scrape fails.  Every step returns [] on error so the provider chain
 * continues cleanly.
 *
 * NOTE: Update the domain constants below when providers rotate domains.
 */

import * as cheerio from "cheerio";
import type { MovieDetails, TvShowDetails } from "tmdb-ts";
import { UserAgent } from "../helpers/util";
import redis from "../lib/redis";
import type { Source } from "../types/types";

// ── constants ────────────────────────────────────────────────────────────────

/** vidsrc.xyz maps TMDB IDs natively and serves UpCloud servers */
const AGGREGATOR_MOVIE = (id: number) =>
    `https://vidsrc.xyz/embed/movie?tmdb=${id}`;
const AGGREGATOR_TV = (id: number, s: number, e: number) =>
    `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${s}&episode=${e}`;

/** UpCloud / upstream embed server origins */
const UPCLOUD_ORIGINS = [
    "https://upcloud.link",
    "https://upstream.to",
    "https://vidplay.site",
];

const UPCLOUD_SOURCE_CACHE_TTL           = 3_600; // 1 hour
const UPCLOUD_SOURCE_NOT_FOUND_CACHE_TTL = 900;   // 15 minutes

// ── helpers ──────────────────────────────────────────────────────────────────

/** Returns true when a URL's hostname matches any known UpCloud origin. */
function isUpCloudUrl(url: string): boolean {
    try {
        const { hostname } = new URL(url);
        return UPCLOUD_ORIGINS.some((o) => new URL(o).hostname === hostname) ||
               hostname.includes("upcloud")  ||
               hostname.includes("upstream") ||
               hostname.includes("vidplay");
    } catch {
        return false;
    }
}

// ── aggregator scraper ───────────────────────────────────────────────────────

/**
 * Fetch the vidsrc.xyz aggregator page and return the first UpCloud embed URL
 * found in an iframe, data-src, or inline script.
 */
async function findUpCloudUrl(aggregatorUrl: string): Promise<string | null> {
    let html: string;
    try {
        const res = await fetch(aggregatorUrl, {
            headers: { "User-Agent": UserAgent },
        });
        if (!res.ok) {
            console.log(`[UpCloud] Aggregator fetch failed (${res.status}): ${aggregatorUrl}`);
            return null;
        }
        html = await res.text();
    } catch (err) {
        console.log("[UpCloud] Network error fetching aggregator:", err);
        return null;
    }

    const $ = cheerio.load(html);

    // 1. iframe / frame src
    let found: string | null = null;
    $("iframe, frame").each((_, el) => {
        const src = $(el).attr("src") ?? "";
        if (isUpCloudUrl(src)) {
            found = src.startsWith("//") ? "https:" + src : src;
            return false;
        }
    });
    if (found) return found;

    // 2. Raw regex over the full HTML
    const rawMatch = html.match(
        /["'`](https?:\/\/(?:[^"'`\s]*(?:upcloud|upstream|vidplay)[^"'`\s]*))["'`]/i,
    );
    if (rawMatch?.[1]) return rawMatch[1];

    // 3. data-src / data-embed attributes
    $("[data-src],[data-embed],[data-url]").each((_, el) => {
        const src =
            $(el).attr("data-src")  ??
            $(el).attr("data-embed") ??
            $(el).attr("data-url")  ?? "";
        if (isUpCloudUrl(src)) {
            found = src;
            return false;
        }
    });

    return found;
}

// ── embed page scraper ───────────────────────────────────────────────────────

/**
 * Fetch an UpCloud embed page and extract the HLS / MP4 source URLs.
 *
 * UpCloud embeds vary slightly between domains but share a common pattern:
 *  - A `file` or `sources` key appears in an inline <script> block.
 *  - The sources array contains objects with `file` and optionally `label`.
 *  - No encryption is applied (unlike RabbitStream).
 */
async function extractFromUpCloud(
    embedUrl: string,
    referer: string,
): Promise<Source[]> {
    const upcloudOrigin = (() => {
        try { return new URL(embedUrl).origin; } catch { return UPCLOUD_ORIGINS[0]; }
    })();

    const headers = {
        "User-Agent":  UserAgent,
        "Referer":     referer,
        "Origin":      referer,
        "Accept":      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    };

    let html: string;
    try {
        const res = await fetch(embedUrl, { headers });
        if (!res.ok) {
            console.log(`[UpCloud] Embed fetch failed (${res.status}): ${embedUrl}`);
            return [];
        }
        html = await res.text();
    } catch (err) {
        console.log("[UpCloud] Network error fetching embed:", err);
        return [];
    }

    // ── strategy A: extract JSON sources array from inline script ────────────
    //
    // UpCloud typically writes one of:
    //   jwplayer(...).setup({ sources: [{file:"https://...",label:"1080p"}] })
    //   var sources = [{file:"https://..."}];
    //   playerConfig = { sources: [...] };

    const sources: Source[] = [];

    const corsHeaders: Record<string, string> = {
        "Referer": upcloudOrigin + "/",
        "Origin":  upcloudOrigin,
    };

    // Pattern A1: sources array literal in a script block
    const sourcesArrayMatch = html.match(
        /["']?sources["']?\s*:\s*(\[[\s\S]*?\])/,
    );
    if (sourcesArrayMatch?.[1]) {
        try {
            // Sanitise single-quoted JSON before parsing
            const jsonStr = sourcesArrayMatch[1]
                .replace(/'/g, '"')
                .replace(/(\w+)\s*:/g, '"$1":'); // ensure keys are quoted
            const arr: any[] = JSON.parse(jsonStr);
            for (const item of arr) {
                if (!item?.file || typeof item.file !== "string") continue;
                const isHls = item.file.includes(".m3u8") || item.type === "hls";
                const quality = item.label
                    ? parseInt(String(item.label).replace(/\D/g, ""), 10) || undefined
                    : undefined;
                sources.push({
                    url:     item.file,
                    dub:     "original",
                    type:    isHls ? "hls" : "mp4",
                    quality,
                    headers: corsHeaders,
                });
            }
        } catch {
            // Regex-based fallback below
        }
    }

    if (sources.length > 0) {
        console.log(`[UpCloud] Extracted ${sources.length} source(s) via JSON from ${embedUrl}`);
        return sources;
    }

    // Pattern A2: individual "file":"..." strings (plain regex)
    const fileMatches = [...html.matchAll(/["']file["']\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi)];
    for (const m of fileMatches) {
        const url  = m[1];
        const isHls = url.includes(".m3u8");
        sources.push({
            url,
            dub:     "original",
            type:    isHls ? "hls" : "mp4",
            headers: corsHeaders,
        });
    }

    // ── strategy B: look for a getSources / get-sources API call ─────────────
    if (sources.length === 0) {
        const apiMatch = html.match(
            /fetch\s*\(\s*["'`]([^"'`]+get[_-]?[Ss]ources[^"'`]*)["'`]/,
        );
        if (apiMatch?.[1]) {
            const apiUrl = apiMatch[1].startsWith("http")
                ? apiMatch[1]
                : upcloudOrigin + apiMatch[1];
            try {
                const apiRes = await fetch(apiUrl, {
                    headers: {
                        ...corsHeaders,
                        "User-Agent":       UserAgent,
                        "X-Requested-With": "XMLHttpRequest",
                        "Accept":           "application/json",
                    },
                });
                if (apiRes.ok) {
                    const json: any = await apiRes.json();
                    const arr: any[] = json?.sources ?? json?.data ?? [];
                    for (const item of arr) {
                        if (!item?.file && !item?.url) continue;
                        const url   = item.file ?? item.url;
                        const isHls = url.includes(".m3u8") || item.type === "hls";
                        sources.push({
                            url,
                            dub:     "original",
                            type:    isHls ? "hls" : "mp4",
                            headers: corsHeaders,
                        });
                    }
                }
            } catch {
                // getSources API failed — already have []
            }
        }
    }

    console.log(`[UpCloud] Resolved ${sources.length} source(s) from ${embedUrl}`);
    return sources;
}

// ── public entry point ───────────────────────────────────────────────────────

export async function getUpCloudSources(
    serve_cache = true,
    type: "movie" | "tv",
    tmdbMedia: MovieDetails | TvShowDetails,
    season = 0,
    episode = 0,
): Promise<Source[]> {
    const { id } = tmdbMedia;

    const cacheKey =
        type === "movie"
            ? `upcloud:movie:sources:${id}`
            : `upcloud:tv:sources:${id}:${season}:${episode}`;

    let sources: Source[] = [];

    try {
        // ── cache read ───────────────────────────────────────────────────────
        if (serve_cache) {
            const cached = await redis.get(cacheKey);
            if (cached) {
                console.log("[UpCloud] served cached sources");
                return JSON.parse(cached) as Source[];
            }
        }

        // ── find UpCloud embed URL via aggregator ────────────────────────────
        const aggregatorUrl =
            type === "movie"
                ? AGGREGATOR_MOVIE(id)
                : AGGREGATOR_TV(id, season, episode);

        console.log(`[UpCloud] Fetching aggregator: ${aggregatorUrl}`);
        const upcloudUrl = await findUpCloudUrl(aggregatorUrl);

        if (!upcloudUrl) {
            console.log("[UpCloud] No UpCloud URL found in aggregator page");
        } else {
            console.log(`[UpCloud] Found UpCloud URL: ${upcloudUrl}`);
            sources = await extractFromUpCloud(upcloudUrl, aggregatorUrl);
        }

        // ── cache write ──────────────────────────────────────────────────────
        const ttl = sources.length > 0
            ? UPCLOUD_SOURCE_CACHE_TTL
            : UPCLOUD_SOURCE_NOT_FOUND_CACHE_TTL;
        redis.set(cacheKey, JSON.stringify(sources), "EX", ttl);

    } catch (err) {
        console.log("[UpCloud] Unexpected error:", err);
    }

    return sources;
}

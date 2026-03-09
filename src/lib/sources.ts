/**
 * Provider registry
 *
 * Priority order (highest → lowest):
 *   1. moviebox   — direct HLS/MP4 via MovieBox backend API
 *   2. vidcloud   — HLS via RabbitStream/VidCloud embed
 *   3. upcloud    — HLS via UpCloud/upstream embed
 *   4. myflixerz  — last-resort HLS scraper
 *
 * IMPORTANT — proxy contract:
 *   index.ts calls rewriteSourceUrl() on every source AFTER calling the
 *   provider.  For type:"hls"/"mp4" it rewrites the URL through the
 *   Cloudflare worker proxy.  For type:"iframe" it passes through unchanged.
 *
 *   Therefore providers MUST NOT call proxifySources() — doing so would
 *   push URLs through the old internal proxy first, causing double-proxying.
 *
 *   The old scrapers (vixsrc, banglaplex, vidsrc, multiembed) are removed
 *   from the registry.  Their files are kept on disk for reference.
 */

import type { MovieDetails, TvShowDetails } from "tmdb-ts";
import { getMovieBoxSources }   from "../scrapers/moviebox";
import { getMyFlixerZSources }  from "../scrapers/myflixerz";
import { getUpCloudSources }    from "../scrapers/upcloud";
import { getVidCloudSources }   from "../scrapers/vidcloud";
import type { Source }          from "../types/types";

// ── provider interface ───────────────────────────────────────────────────────

type Provider = {
    getMovie: (
        serve_cache: boolean,
        tmdb: MovieDetails | TvShowDetails,
    ) => Promise<Source[]>;
    getTv: (
        serve_cache: boolean,
        tmdb: MovieDetails | TvShowDetails,
        season: number,
        episode: number,
    ) => Promise<Source[]>;
};

// ── provider registry ────────────────────────────────────────────────────────

export const providers: Record<string, Provider> = {

    // ── 1. Primary: MovieBox ─────────────────────────────────────────────────
    // Directly hits the MovieBox backend API (h5-api.aoneroom.com) after a
    // fuzzy-match search.  Returns HLS and MP4 with dub names.
    moviebox: {
        getMovie: (serve_cache, tmdb) =>
            getMovieBoxSources(serve_cache, "movie", tmdb),
        getTv: (serve_cache, tmdb, season, episode) =>
            getMovieBoxSources(serve_cache, "tv", tmdb, season, episode),
    },

    // ── 2. VidCloud / RabbitStream ───────────────────────────────────────────
    // Scrapes 2embed.cc for a TMDB-aware RabbitStream embed, then calls the
    // /ajax/embed-N/getSources JSON endpoint.  Returns HLS.
    vidcloud: {
        getMovie: (serve_cache, tmdb) =>
            getVidCloudSources(serve_cache, "movie", tmdb),
        getTv: (serve_cache, tmdb, season, episode) =>
            getVidCloudSources(serve_cache, "tv", tmdb, season, episode),
    },

    // ── 3. UpCloud / upstream ────────────────────────────────────────────────
    // Scrapes vidsrc.xyz for a TMDB-aware UpCloud embed, then extracts
    // HLS sources from the inline script / getSources API.
    upcloud: {
        getMovie: (serve_cache, tmdb) =>
            getUpCloudSources(serve_cache, "movie", tmdb),
        getTv: (serve_cache, tmdb, season, episode) =>
            getUpCloudSources(serve_cache, "tv", tmdb, season, episode),
    },

    // ── 4. Last fallback: MyFlixerZ ──────────────────────────────────────────
    // Fuzzy-match search + multi-server HLS extraction via videostr.net.
    // Slowest provider; kept as a safety net.
    myflixerz: {
        getMovie: (serve_cache, tmdb) =>
            getMyFlixerZSources(serve_cache, "movie", tmdb),
        getTv: (serve_cache, tmdb, season, episode) =>
            getMyFlixerZSources(serve_cache, "tv", tmdb, season, episode),
    },
};

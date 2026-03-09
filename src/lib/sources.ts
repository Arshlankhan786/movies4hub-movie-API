/**
 * Provider registry.
 *
 * Broken scraper-based providers (moviebox, myflixerz, vixsrc) have been
 * removed.  They can be re-enabled here once their upstream domains stabilise.
 *
 * Iframe providers (vidsrc, multiembed) construct embed URLs directly from the
 * TMDB ID — no scraping, no Cloudflare bypass needed, zero external HTTP calls.
 * They do NOT go through proxifySources() because iframe URLs must never be
 * rewritten by the stream proxy.
 */

import type { MovieDetails, TvShowDetails } from "tmdb-ts";
import { getMultiEmbedSources } from "../scrapers/multiembed";
import { getVidSrcSources } from "../scrapers/vidsrc";
import type { Source } from "../types/types";

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

export const providers: Record<string, Provider> = {
    // ── iframe providers ──────────────────────────────────────────────────────
    // These return type:"iframe" sources and are intentionally NOT wrapped in
    // proxifySources() — index.ts will pass them through unmodified.

    vidsrc: {
        getMovie: async (serve_cache, tmdb) =>
            getVidSrcSources(serve_cache, "movie", tmdb),
        getTv: async (serve_cache, tmdb, season, episode) =>
            getVidSrcSources(serve_cache, "tv", tmdb, season, episode),
    },

    multiembed: {
        getMovie: async (serve_cache, tmdb) =>
            getMultiEmbedSources(serve_cache, "movie", tmdb),
        getTv: async (serve_cache, tmdb, season, episode) =>
            getMultiEmbedSources(serve_cache, "tv", tmdb, season, episode),
    },
};

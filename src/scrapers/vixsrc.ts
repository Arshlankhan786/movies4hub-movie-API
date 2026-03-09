/**
 * VidSrc provider — iframe embed, no scraping required.
 *
 * Movie:  https://vidsrc.to/embed/movie/{tmdbId}
 * TV:     https://vidsrc.to/embed/tv/{tmdbId}/{season}/{episode}
 *
 * Returns a single iframe source. Because the URL is a plain embed page
 * (not an HLS manifest or MP4 file) it must NOT be sent through the
 * Cloudflare stream proxy — index.ts skips rewriting for type === "iframe".
 */

import type { MovieDetails, TvShowDetails } from "tmdb-ts";
import type { Source } from "../types/types";

const BASE = "https://vidsrc.to/embed";

export function getVidSrcSources(
    _serve_cache: boolean,
    type: "movie" | "tv",
    tmdbMedia: MovieDetails | TvShowDetails,
    season = 0,
    episode = 0,
): Source[] {
    const { id } = tmdbMedia;

    const url =
        type === "movie"
            ? `${BASE}/movie/${id}`
            : `${BASE}/tv/${id}/${season}/${episode}`;

    console.log(`[vidsrc] built ${type} embed → ${url}`);

    return [
        {
            url,
            dub: "original",
            type: "iframe",
            quality: 1080,
            headers: {},
        },
    ];
}

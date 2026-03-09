/**
 * MultiEmbed provider — iframe embed, no scraping required.
 *
 * Movie:  https://multiembed.mov/?video_id={tmdbId}&tmdb=1
 * TV:     https://multiembed.mov/?video_id={tmdbId}&tmdb=1&s={season}&e={episode}
 *
 * Returns a single iframe source. Because the URL is a plain embed page
 * (not an HLS manifest or MP4 file) it must NOT be sent through the
 * Cloudflare stream proxy — index.ts skips rewriting for type === "iframe".
 */

import type { MovieDetails, TvShowDetails } from "tmdb-ts";
import type { Source } from "../types/types";

const BASE = "https://multiembed.mov";

export function getMultiEmbedSources(
    _serve_cache: boolean,
    type: "movie" | "tv",
    tmdbMedia: MovieDetails | TvShowDetails,
    season = 0,
    episode = 0,
): Source[] {
    const { id } = tmdbMedia;

    const url =
        type === "movie"
            ? `${BASE}/?video_id=${id}&tmdb=1`
            : `${BASE}/?video_id=${id}&tmdb=1&s=${season}&e=${episode}`;

    console.log(`[multiembed] built ${type} embed → ${url}`);

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

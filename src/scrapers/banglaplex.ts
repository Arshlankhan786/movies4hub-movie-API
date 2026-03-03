import { MovieDetails, TvShowDetails } from "tmdb-ts";
import { Source } from "../types/types";

export function getBanglaplexSources(serve_cache = true, type: "movie" | "tv", tmdbMedia: MovieDetails | TvShowDetails, season = 0, episode = 0) {
    let sources: Source[] = [];

    // to be continued

    return sources;
}
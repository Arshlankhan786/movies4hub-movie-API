import { MovieDetails, TvShowDetails } from "tmdb-ts";
import { getBanglaplexSources } from "../scrapers/banglaplex";
import { getMovieBoxSources } from "../scrapers/moviebox";
import { getMyFlixerZSources } from "../scrapers/myflixerz";
import { getVixSrcSources } from "../scrapers/vixsrc";
import { Source } from "../types/types";
import { proxifySources } from "./proxy";

type Provider = {
    getMovie: (serve_cache: boolean, tmdb: MovieDetails | TvShowDetails) => Promise<Source[]>; // Replace 'any' with the return type of getMovieBoxSources
    getTv: (serve_cache: boolean, tmdb: MovieDetails | TvShowDetails, season: number, episode: number) => Promise<Source[]>;
};

export const providers: Record<string, Provider> = {
    "moviebox": {
        getMovie: async (serve_cache, tmdb) => proxifySources("moviebox", await getMovieBoxSources(serve_cache, "movie", tmdb)),
        getTv: async (serve_cache, tmdb, season, episode) => proxifySources("moviebox", await getMovieBoxSources(serve_cache, "tv", tmdb, season, episode)),
    },
    "banglaplex": {
        getMovie: async (serve_cache, tmdb) => proxifySources("banglaplex", await getBanglaplexSources(serve_cache, "movie", tmdb)),
        getTv: async (serve_cache, tmdb, season, episode) => proxifySources("banglaplex", await getBanglaplexSources(serve_cache, "tv", tmdb, season, episode)),
    },
    "vixsrc": {
        getMovie: async (serve_cache, tmdb) => proxifySources("vixsrc", await getVixSrcSources(serve_cache, "movie", tmdb)),
        getTv: async (serve_cache, tmdb, season, episode) => proxifySources("myflixerz", await getVixSrcSources(serve_cache, "tv", tmdb, season, episode)),
    },
    "myflixerz": {
        getMovie: async (serve_cache, tmdb) => proxifySources("myflixerz", await getMyFlixerZSources(serve_cache, "movie", tmdb)),
        getTv: async (serve_cache, tmdb, season, episode) => proxifySources("myflixerz", await getMyFlixerZSources(serve_cache, "tv", tmdb, season, episode)),
    }
}

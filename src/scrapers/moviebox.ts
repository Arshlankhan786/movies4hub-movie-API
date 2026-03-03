/* ------------
https://moviebox.ph/

Seasons are separate so we have to cache each season's map separately
------------ */

const backendBase = "https://h5-api.aoneroom.com"
const souceBase = "https://123movienow.cc"

import { MovieDetails, TvShowDetails } from "tmdb-ts";
import { isEmpty, UserAgent } from "../helpers/util";
import type { Source } from "../types/types";

import strCmp from "string-comparison";
import { logger } from "../helpers/logger";
import redis from "../lib/redis";


const MOVIEBOX_MAP_CACHE_TTL = 259_200 // 3 days in seconds
const MOVIEBOX_MAP_NOT_FOUND_CACHE_TTL = 3600 // 1 hour in seconds
const MOVIEBOX_SOURCE_CACHE_TTL = 7200 // 2 hours in seconds
const MOVIEBOX_SOURCE_NOT_FOUND_CACHE_TTL = 900 // 15 mins in seconds - to avoid overload

export async function getMovieBoxSources(serve_cache = true, type: "movie" | "tv", tmdbMedia: MovieDetails | TvShowDetails, season = 0, episode = 0) {
    let sources: Source[] = [];

    // console.log("serve_cache is:", serve_cache)

    try {
        if (type == "movie") {
            const tmdbMovie = tmdbMedia as MovieDetails;
            const { id } = tmdbMovie;
            // check if cached sources exists
            const rawSources = serve_cache ? await redis.get(`moviebox:${type}:sources:${id}`) : "";
            if (rawSources) {
                console.log("[Moviebox] served cached sources");
                sources = JSON.parse(rawSources) // finally always runs ;(
                return sources;
            }

            // get cached mapped movies
            const rawMovies = serve_cache === true ? await redis.get(`moviebox:${type}:mapped:${id}`) : "";
            let mappedMovies: any = rawMovies ? JSON.parse(rawMovies) : "";

            // single best match movie for each dub
            if (isEmpty(mappedMovies)) {
                mappedMovies = await fetchMovieBoxMovie(tmdbMovie);
                console.log(mappedMovies)

                if (!isEmpty(mappedMovies))
                    redis.set(`moviebox:${type}:mapped:${id}`, JSON.stringify(mappedMovies), "EX", MOVIEBOX_MAP_CACHE_TTL); // dont wait with await
                else
                    redis.set(`moviebox:${type}:mapped:${id}`, JSON.stringify(mappedMovies), "EX", MOVIEBOX_MAP_NOT_FOUND_CACHE_TTL); // dont wait with await
            }

            const dubNames = Object.keys(mappedMovies);
            console.log("[Moviebox]", `Mapped ${dubNames.length} dub(s)`);

            const promises = dubNames.map(async (dubKey) => {
                const { subjectId, detailPath } = mappedMovies[dubKey];

                const movieboxSources = await getSources(dubKey, subjectId, detailPath);
                console.log("[Moviebox]", `Got ${movieboxSources.length} source(s) for ${dubKey}`);

                return movieboxSources; // Return the data instead of pushing
            });

            const results = await Promise.all(promises);

            sources = results.flat();

            if (sources) // only cache sources if not empty
                redis.set(`moviebox:${type}:sources:${id}`, JSON.stringify(sources), "EX", MOVIEBOX_SOURCE_CACHE_TTL);
            else
                redis.set(`moviebox:${type}:sources:${id}`, JSON.stringify(sources), "EX", MOVIEBOX_SOURCE_NOT_FOUND_CACHE_TTL);

            /* {
               English: {
                   subjectId: "5217887006021370904",
                   detailPath: "the-wrecking-crew-q7LAVPCYrd6",
                   string_matched: 100,
               },
               Hindi: {
                   subjectId: "3897929805899221112",
                   detailPath: "the-wrecking-crew-hindi-mTAkw7IyWD4",
                   string_matched: 93.63636363636364,
               },
           } */
        } else {
            const tmdbShow = tmdbMedia as TvShowDetails;
            const { id } = tmdbShow;
            // check if cached sources exists
            const rawSources = serve_cache ? await redis.get(`moviebox:${type}:sources:${id}:${season}:${episode}`) : "";
            if (rawSources) {
                console.log("[Moviebox] served cached sources");
                sources = JSON.parse(rawSources) // finally always runs ;(
                return sources;
            }

            // get cached mapped movies
            const rawShow = serve_cache ? await redis.get(`moviebox:${type}:mapped:${id}:${season}`) : "";
            let mappedShows: any = rawShow ? JSON.parse(rawShow) : "";

            // single best match show for each dub
            if (isEmpty(mappedShows)) {
                mappedShows = await fetchMovieBoxTV(tmdbShow, season, episode);
                console.log("[Moviebox] Found Mapped Tv Shows in cache, using it");

                if (!isEmpty(mappedShows))
                    redis.set(`moviebox:${type}:mapped:${id}:${season}`, JSON.stringify(mappedShows), "EX", MOVIEBOX_MAP_CACHE_TTL);
                else
                    redis.set(`moviebox:${type}:mapped:${id}:${season}`, JSON.stringify(mappedShows), "EX", MOVIEBOX_MAP_NOT_FOUND_CACHE_TTL);
            }

            const dubNames = Object.keys(mappedShows);
            console.log("[Moviebox]", `Mapped ${dubNames.length} dub(s)`);

            const promises = dubNames.map(async (dubKey) => {
                const { subjectId, detailPath } = mappedShows[dubKey];

                const movieboxSources = await getSources(dubKey, subjectId, detailPath, season, episode);
                console.log("[Moviebox]", `Got ${movieboxSources.length} source(s) for ${dubKey}`);

                return movieboxSources; // Return the data instead of pushing
            });

            const results = await Promise.all(promises);

            sources = results.flat();

            if (!isEmpty(sources)) // only cache sources if not empty
                redis.set(`moviebox:${type}:sources:${id}:${season}:${episode}`, JSON.stringify(sources), "EX", MOVIEBOX_SOURCE_CACHE_TTL);
            else
                redis.set(`moviebox:${type}:sources:${id}:${season}:${episode}`, JSON.stringify(sources), "EX", MOVIEBOX_SOURCE_NOT_FOUND_CACHE_TTL);

        }

    } catch (err) {
        console.log("[MovieBox] Error Occured, Details: ", err);
    }
    finally {
        return sources;
    }

}


async function getSources(dubName: string, subjectId: string, detailPath: string, season = 0, episode = 0) {
    const origin = souceBase

    const headers = {
        "origin": origin,
        "referer": `${origin}/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail&detailSe=&detailEp=&lang=en`,
        "user-agent": UserAgent
    }

    const url = `${origin}/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${season}&ep=${episode}&detailPath=${detailPath}`

    const res = await fetch(url, {
        "headers": {
            "accept": "application/json",
            "accept-language": "en-US,en;q=0.9,hi;q=0.8,bn;q=0.7",
            "cache-control": "no-cache",
            "pragma": "no-cache",
            "priority": "u=1, i",
            "sec-ch-ua": "\"Google Chrome\";v=\"143\", \"Chromium\";v=\"143\", \"Not A(Brand\";v=\"24\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "x-client-info": "{\"timezone\":\"Asia/Delhi\"}",
            "x-source": "",
            ...headers
        },
        "body": null,
        "method": "GET"
    });

    if (!res.ok) return [];

    const { code, message, data: { streams } } = await res.json()
    if (code != 0) {
        logger.red("[MovieBox Error] failed to get sources -", message);
        return [];
    }

    let movieboxSources: Source[] = [];

    const corsHeaders = {
        "origin": origin,
        "referer": `${origin}/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail&detailSe=&detailEp=&lang=en`,
    }
    for (const stream of streams) {
        const { format, url, resolutions, size } = stream;
        movieboxSources.push({
            type: format == "MP4" ? "mp4" : "hls",
            dub: dubName,
            url,
            quality: Number(resolutions),
            sizeBytes: Number(size),
            headers: corsHeaders
        })
    }

    return movieboxSources;
}

const MATCHING_THRESHOLD = 80; // count as mapped if greater than or equal 80%

async function fetchMovieBoxMovie(tmdbMovie: MovieDetails) {
    const { title: keyword, release_date: tmdbReleaseDate } = tmdbMovie;

    // if cache doesnt exist

    console.log("[Moviebox] Searching movie for title:", keyword);

    const url = backendBase + "/wefeed-h5api-bff/subject/search";
    const payload = JSON.stringify({
        "keyword": keyword,
        "page": 1,
        "perPage": 28,
        "subjectType": 1 // 1 -> movies
    })
    const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": UserAgent,
    }

    const res = await fetch(url, { method: "POST", headers, body: payload })
    if (!res.ok) throw new Error(`Failed to fetch Status: ${res.status}`)

    const json: any = await res.json();

    // Bun.write("logs/aa", JSON.stringify(json.data.items));

    if (!json?.data?.items) throw new Error(`No Movies found with keyword: ${keyword}`)


    let lastMatched;
    // LOOP START
    for (const movieboxMovie of json?.data?.items) {
        const {
            subjectId, detailPath,
            title, releaseDate, corner,
            hasResource, imdbRatingCount } = movieboxMovie;

        if (!hasResource) {
            console.log(`[Moviebox] No Resource available for ${title}, skipping`);
            continue;
        }

        const tmdbMonth = tmdbReleaseDate.slice(0, 7);   // "2021-08"
        const localMonth = releaseDate.slice(0, 7);

        if (tmdbMonth !== localMonth) {
            console.log(
                `[Moviebox] Release month mismatch for ${title}, ${tmdbMonth} != ${localMonth} skipping`
            );
            continue;
        }

        const matchedPercent = strCmp.jaroWinkler.similarity(tmdbMovie.title, title) * 100;
        if (matchedPercent < MATCHING_THRESHOLD) {
            console.log(`[Moviebox] Matching ${title}: ${matchedPercent.toFixed(2)}% < ${MATCHING_THRESHOLD}, skipping`);
            continue;
        }

        if (!lastMatched || matchedPercent > lastMatched.string_matched || (matchedPercent == lastMatched.string_matched && imdbRatingCount > lastMatched.imdbRatingCount))
            lastMatched = { subjectId, detailPath, string_matched: matchedPercent, imdbRatingCount };

        if (matchedPercent == 100 && corner.length > 0)
            break;



        // const dubName = corner || "English";

        // // last dub
        // const lastDub = dubs[dubName];
        // if (lastDub && lastDub.string_matched == 100)
        //     continue;

        // if (!hasResource) {
        //     console.log(`[Moviebox] No Resource available for ${title}, skipping`);
        //     continue;
        // }

        // if (tmdbReleaseDate != releaseDate) {
        //     console.log(`[Moviebox] Release date doesn't match for ${title}, ${tmdbReleaseDate} != ${releaseDate} skipping`);
        //     continue;
        // }

        // const normalizedTitle = title.replace(dubName, "").replace("[]", ""); // stripping  dub indicator (e.g. "S1", [Hindi])from title 
        // const matchedPercent = strCmp.jaroWinkler.similarity(tmdbMovie.title, normalizedTitle) * 100;
        // if (matchedPercent < MATCHING_THRESHOLD) {
        //     console.log(`[Moviebox] Matching ${title}: ${matchedPercent.toFixed(2)}% < ${MATCHING_THRESHOLD}, skipping`);
        //     continue;
        // }

        // if (!lastDub || matchedPercent > lastDub.string_matched) {
        //     dubs[dubName] = { subjectId, detailPath, string_matched: matchedPercent };
        // }
    }
    // LOOP END

    console.log(lastMatched, "HEHE")

    if (!lastMatched) throw new Error(`No Movies found with keyword: ${keyword}`)

    const { detailPath, subjectId } = lastMatched;

    const res2 = await fetch(`${backendBase}/wefeed-h5api-bff/detail?detailPath=${detailPath}`, {
        "headers": {
            "accept": "application/json",
            "accept-language": "en-US,en;q=0.9,hi;q=0.8,bn;q=0.7",
            "priority": "u=1, i",
            "sec-ch-ua": "\"Google Chrome\";v=\"143\", \"Chromium\";v=\"143\", \"Not A(Brand\";v=\"24\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "cross-site",
            "x-client-info": "{\"timezone\":\"Asia/Delhi\"}",
            "Referer": `https://123movienow.cc/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail&detailSe=&detailEp=&lang=en`
        },
        "body": null,
        "method": "GET"
    });

    if (!res2.ok) throw new Error(`Failed to fetch Status: ${res.status}`);

    const json2 = await res2.json();
    const { code, message, data: { subject: { dubs } } } = json2;

    if (code != 0) {
        logger.red("[MovieBox Error] failed to get sources -", message);
        return [];
    }

    const finalDubs: any = {};

    console.log(json2);

    for (const dub of dubs) {
        const { subjectId, detailPath, lanName } = dub;

        if (lanName.includes("sub"))
            continue; // ignore subs

        const dubName = lanName.replace("dub", "").trim();
        finalDubs[dubName] = { subjectId, detailPath, lanName }
    }

    if (isEmpty(finalDubs)) {
        return {
            "Original": {
                subjectId,
                detailPath,
                lanName: "Original"
            }
        }
    }


    return finalDubs;
}

async function fetchMovieBoxTV(tmdbTv: TvShowDetails, season: number, episode: number) {
    const { name: keyword, last_air_date } = tmdbTv;

    // if cache doesnt exist

    console.log("[Moviebox] Searching tv for title:", keyword);

    const url = `${backendBase}/wefeed-h5api-bff/subject/search`;
    const payload = JSON.stringify({
        "keyword": keyword,
        "page": 1,
        "perPage": 28,
        "subjectType": 2 // 2 -> tv show
    })
    const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": UserAgent,
    }

    const res = await fetch(url, { method: "POST", headers, body: payload })
    if (!res.ok) throw new Error(`Failed to fetch Status: ${res.status}`)

    const json: any = await res.json();
    if (!json?.data?.items) throw new Error(`No Movies found with keyword: ${keyword}`)

    let lastMatched;

    // LOOP START
    for (const movieboxMovie of json?.data?.items) {
        const {
            subjectId, detailPath,
            title, releaseDate,
            corner, hasResource, imdbRatingCount } = movieboxMovie;


        if (!hasResource) {
            console.log(`[Moviebox] No Resource available for ${title}, skipping`);
            continue;
        }

        // skip date checking
        // if (last_air_date != releaseDate) { 
        //     console.log(`[Moviebox] Last air  date doesn't match for ${title}, ${last_air_date} != ${releaseDate} skipping`);
        //     continue;
        // }

        const tmdbSeasonStr = `S${season}`
        const seasonStr = (title.match(/S\d+/i) || ["S1"])[0].toUpperCase();

        if (tmdbSeasonStr != seasonStr) {
            console.log(`[Moviebox] Season doesnt match ${tmdbSeasonStr} != ${seasonStr}, skipping`);

        }

        const matchedPercent = strCmp.jaroWinkler.similarity(tmdbTv.name, title) * 100;

        if (matchedPercent < MATCHING_THRESHOLD) {
            console.log(`[Moviebox] Matching ${title}: ${matchedPercent.toFixed(2)}% < ${MATCHING_THRESHOLD}, skipping`);
            continue;
        }


        if (!lastMatched || matchedPercent > lastMatched.string_matched || (matchedPercent == lastMatched.string_matched && imdbRatingCount > lastMatched.imdbRatingCount))
            lastMatched = { subjectId, detailPath, string_matched: matchedPercent, imdbRatingCount };

        if (matchedPercent == 100 && corner.length > 0)
            break;


        // const dubName = corner || "English";

        // // last dub
        // const lastDub = dubs[dubName];
        // if (lastDub && lastDub.string_matched == 100)
        //     continue;

        // if (!hasResource) {
        //     console.log(`[Moviebox] No Resource available for ${title}, skipping`);
        //     continue;
        // }

        // // skip date checking
        // // if (last_air_date != releaseDate) { 
        // //     console.log(`[Moviebox] Last air  date doesn't match for ${title}, ${last_air_date} != ${releaseDate} skipping`);
        // //     continue;
        // // }

        // const tmdbSeasonStr = `S${season}`
        // const seasonStr = (title.match(/S\d+/i) || ["S1"])[0].toUpperCase();

        // if (tmdbSeasonStr != seasonStr) {
        //     console.log(`[Moviebox] Season doesnt match ${tmdbSeasonStr} != ${seasonStr}, skipping`);

        // }

        // const normalizedTitle = title.replace(seasonStr, "").replace(dubName, "").replace("[]", ""); // stripping season & dub indicator (e.g. "S1", [Hindi])from title 
        // const matchedPercent = strCmp.jaroWinkler.similarity(tmdbTv.name, normalizedTitle) * 100;

        // if (matchedPercent < MATCHING_THRESHOLD) {
        //     console.log(`[Moviebox] Matching ${title}: ${matchedPercent.toFixed(2)}% < ${MATCHING_THRESHOLD}, skipping`);
        //     continue;
        // }

        // if (!lastDub || matchedPercent > lastDub.string_matched) {
        //     dubs[dubName] = { subjectId, detailPath, string_matched: matchedPercent };
        // }
    }
    // LOOP END

    if (!lastMatched) throw new Error(`No Shows found with keyword: ${keyword}`)

    const { detailPath, subjectId } = lastMatched;

    const res2 = await fetch(`${backendBase}/wefeed-h5api-bff/detail?detailPath=${detailPath}`, {
        "headers": {
            "accept": "application/json",
            "accept-language": "en-US,en;q=0.9,hi;q=0.8,bn;q=0.7",
            "priority": "u=1, i",
            "sec-ch-ua": "\"Google Chrome\";v=\"143\", \"Chromium\";v=\"143\", \"Not A(Brand\";v=\"24\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "cross-site",
            "x-client-info": "{\"timezone\":\"Asia/Delhi\"}",
            "Referer": `https://123movienow.cc/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail&detailSe=&detailEp=&lang=en`
        },
        "body": null,
        "method": "GET"
    });

    if (!res2.ok) throw new Error(`Failed to fetch Status: ${res.status}`);

    const { code, message, data: { subject: { dubs } } } = await res2.json();
    if (code != 0) {
        logger.red("[MovieBox Error] failed to get sources -", message);
        return [];
    }

    const finalDubs: any = {};

    for (const dub of dubs) {
        const { subjectId, detailPath, lanName } = dub;

        if (lanName.includes("sub"))
            continue; // ignore subs

        const dubName = lanName.replace("dub", "").trim();
        finalDubs[dubName] = { subjectId, detailPath, lanName }
    }

    if (isEmpty(finalDubs)) {
        return {
            "Original": {
                subjectId,
                detailPath,
                lanName: "Original"
            }
        }
    }

    return finalDubs;
}
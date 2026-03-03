import * as cheerio from "cheerio";
import strComp from "string-comparison";
import { MovieDetails, TvShowDetails } from "tmdb-ts";
import { UserAgent } from "../helpers/util";
import redis from "../lib/redis";
import type { Source } from "../types/types";

const baseUrl = "https://myflixerz.to";
const MYFLIXERZ_MAP_CACHE_TTL = 259_200 // 3 days in seconds
const MYFLIXERZ_MAP_NOT_FOUND_CACHE_TTL = 3600 // 1 hour in seconds
const MYFLIXERZ_SOURCE_CACHE_TTL = 3600 // 1 hour in seconds
const MYFLIXERZ_SOURCE_NOT_FOUND_CACHE_TTL = 900 // 15 mins in seconds - to avoid overload

function buildSearchUrl(query: string) {
    return baseUrl + "/search/" + (query.replaceAll(" ", "-"));
}

async function getBestMatchMovie(title: string, year: string): Promise<string | null> {
    const possibleCandidates: any = {};
    const candidatesStrings: string[] = []

    const res = await fetch(buildSearchUrl(title), {
        method: "GET"
    })

    if (!res.ok) throw new Error("Failed to fetch search results - " + buildSearchUrl(title));

    const html = await res.text();
    const $ = cheerio.load(html);


    $(".film_list-wrap .flw-item").each((_, el) => {
        const url = baseUrl + $(el).find("a").attr("href")?.replace(baseUrl, "");
        const name = $(el).find("h2.film-name").text().trim();
        const type = $(el).find(".fd-infor .fdi-type").text().trim(); // "Movie" || "TV"
        const yr = $(el).find(".fd-infor .fdi-item").first().text().trim(); // this is "SS" if its TV but year if its a "Movie"

        // console.log(name,url,type,yr);

        if (yr == year && type == "Movie") {
            possibleCandidates[name] = url;
            candidatesStrings.push(name);
        }
    })

    if (candidatesStrings.length == 0) {
        console.log(`No possible candidates found for ${title} (${year}) - returned empty array`);
        return null;
    }

    const bestMatch = strComp.jaccardIndex.sortMatch(title, candidatesStrings).reverse()[0];

    if (bestMatch && bestMatch?.rating * 100 > 60) {
        const matchedtitle = bestMatch.member;
        const matchedUrl = possibleCandidates[matchedtitle];
        console.log("Matched:", matchedtitle, matchedUrl, bestMatch.rating * 100 + "%");
        return matchedUrl;

    } else {
        console.log(`Low ratings - returning`);
        return null;
    }
}


async function getBestMatchTv(title: string, season_count: number): Promise<string | null> {
    const possibleCandidates: any = {};
    const candidatesStrings: string[] = []

    const res = await fetch(buildSearchUrl(title), {
        method: "GET"
    })

    if (!res.ok) throw new Error("Failed to fetch search results - " + buildSearchUrl(title));

    const html = await res.text();
    const $ = cheerio.load(html);


    $(".film_list-wrap .flw-item").each((_, el) => {
        const url = baseUrl + $(el).find("a").attr("href")?.replace(baseUrl, "");
        const name = $(el).find("h2.film-name").text().trim();
        const type = $(el).find(".fd-infor .fdi-type").text().trim(); // "Movie" || "TV"
        const ss = $(el).find(".fd-infor .fdi-item").first().text().trim().replace("SS ", ""); // this is "SS" if its TV but year if its a "Movie"

        const s_count = String(season_count);

        if (ss <= s_count && type == "TV") {
            possibleCandidates[name] = url;
            candidatesStrings.push(name);
        }
    })

    if (candidatesStrings.length == 0) {
        console.log(`No possible candidates found for ${title} - returned empty array`);
        return null;
    }

    const bestMatch = strComp.jaccardIndex.sortMatch(title, candidatesStrings).reverse()[0];

    if (bestMatch && bestMatch?.rating * 100 > 60) {
        const matchedtitle = bestMatch.member;
        const matchedUrl = possibleCandidates[matchedtitle];
        console.log("Matched:", matchedtitle, matchedUrl, bestMatch.rating * 100 + "%");
        return matchedUrl;

    } else {
        console.log(`Low ratings - returning`);
        return null;
    }
}


function getIdsFromHtml(htmlText: string) {
    const serverIds = [];
    const dataIdRegex = /\bdata-id="(\d+)"/g;

    let match;
    while ((match = dataIdRegex.exec(htmlText)) !== null) {
        serverIds.push(match[1]);
    }

    return serverIds;
}
function getNonceFromHtml(htmlText: string) {
    if (typeof htmlText !== "string" || htmlText.length === 0) return null;

    // 1) window._lk_db = {x:"16", y:"16", z:"16"}  -> concat 48
    // (handles spaces/newlines, single/double quotes)
    const lkDbMatch = htmlText.match(
        /window\._lk_db\s*=\s*\{[\s\S]*?\}/i
    );

    if (lkDbMatch) {
        const lkDbText = lkDbMatch[0];

        const x = lkDbText.match(/\bx\s*:\s*["']([A-Za-z0-9]{16})["']/i)?.[1];
        const y = lkDbText.match(/\by\s*:\s*["']([A-Za-z0-9]{16})["']/i)?.[1];
        const z = lkDbText.match(/\bz\s*:\s*["']([A-Za-z0-9]{16})["']/i)?.[1];

        if (x && y && z) return x + y + z;
    }

    // 2) <script nonce="48">...</script>
    const scriptNonceMatch = htmlText.match(
        /<script\b[^>]*\bnonce\s*=\s*["']([A-Za-z0-9]{48})["'][^>]*>/i
    );
    if (scriptNonceMatch) return scriptNonceMatch[1];

    // 3) window._xy_ws = "48"
    const xyWsMatch = htmlText.match(
        /window\._xy_ws\s*=\s*["']([A-Za-z0-9]{48})["']/i
    );
    if (xyWsMatch) return xyWsMatch[1];

    // 4) <div data-dpi="48" ...>
    const dpiMatch = htmlText.match(
        /\bdata-dpi\s*=\s*["']([A-Za-z0-9]{48})["']/i
    );
    if (dpiMatch) return dpiMatch[1];

    // 5) <meta name="_gg_fb" content="48">
    const ggFbMatch = htmlText.match(
        /<meta\b[^>]*\bname\s*=\s*["']_gg_fb["'][^>]*\bcontent\s*=\s*["']([A-Za-z0-9]{48})["'][^>]*>/i
    );
    if (ggFbMatch) return ggFbMatch[1];

    // 6) <!-- _is_th:48 -->
    const isThMatch = htmlText.match(
        /_is_th\s*:\s*([A-Za-z0-9]{48})/i
    );
    if (isThMatch) return isThMatch[1];

    return null;
}


async function getSouceFromEmbed(link: string, headers: any) {
    const res = await fetch(link, {
        headers: {
            ...headers,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
        }
    });

    if (!res.ok) throw new Error("Failed to Fetch: " + link);

    const html = await res.text();
    const nonce = getNonceFromHtml(html);
    const match = html.match(/\bdata-id\s*=\s*["']([^"']+)["']/i);
    const source_id = match ? match[1] : null;

    if (!nonce || !source_id) throw new Error("Failed to extract nonce or id (or both) for final request: " + link);

    const res2 = await fetch(`https://videostr.net/embed-1/v3/e-1/getSources?id=${source_id}&_k=${nonce}`, {
        headers
    });

    if (!res2.ok) throw new Error("Failed to fetch final request for " + link);

    const json: any = await res2.json();
    // console.log(json)

    // finally uh
    const serverSources: Source[] = [];

    
    const corsHeaders = {
        "Origin": "https://videostr.net",
        "Referer": "https://videostr.net/",
        // "User-Agent": UserAgent
    }

    for (const src of json.sources) {
        if (!(await isOk(src.file, corsHeaders))) continue; // skip broken source

        if (src.type != "hls" && src.type != "mp4") continue;
        const type = src.type == "hls" ? "hls" : "mp4";

        serverSources.push({
            url: src.file,
            type,
            dub: "English",
            headers: corsHeaders
        });
    }

    return serverSources;
}

async function getMovieSources(url: string) {
    const movieSlug = url.split("/").reverse()[0];
    const movieId = url.split("-").reverse()[0];

    console.log("MOVIE SLUG:", movieSlug);

    // /ajax/episode/list/ for movies, /ajax/season/list/ for tv
    const res = await fetch(baseUrl + "/ajax/episode/list/" + movieId, {
        method: "GET",
        headers: {
            "referer": url,
            "User-Agent": UserAgent,
            "X-Requested-With": "XMLHttpRequest"
        }
    })

    if (!res.ok) throw new Error("Failed to Fetch: " + url);

    const htmlSeg = await res.text();
    const serverIds = getIdsFromHtml(htmlSeg);

    if (!serverIds) throw new Error("No server IDs found for " + url);

    let directLinks: Source[] = []
    for (const server_id of serverIds) {
        const ref = baseUrl + "/watch-movie" + movieSlug + "." + server_id;
        const headers = {
            "referer": ref,
            "user-agent": UserAgent,
            "X-Requested-With": "XMLHttpRequest"
        }
        // const res = await fetch(baseUrl+"/watch-movie"+movieSlug+"."+server_id)
        // https://myflixerz.to/watch-movie/the-wrecking-crew-142383.13002473
        const res = await fetch(baseUrl + "/ajax/episode/sources/" + server_id, {
            headers
        })

        if (!res.ok) throw new Error("Failed to Fetch: " + baseUrl + "/ajax/episode/sources/" + server_id);

        const json: any = await res.json();

        if (json?.link) {
            const serverSources = await getSouceFromEmbed(json.link, headers);
            directLinks.push(...serverSources);
        }

    }
    return directLinks;
}
async function getTvSources(url: string, season: number, episode: number) {
    const tvSlug = url.split("/").reverse()[0];
    const tvId = url.split("-").reverse()[0];

    console.log("TV SLUG:", tvSlug);

    // /ajax/episode/list/ for movies, /ajax/season/list/ for tv
    const res_0 = await fetch(baseUrl + "/ajax/season/list/" + tvId, {
        method: "GET",
        headers: {
            "referer": url,
            "User-Agent": UserAgent,
            "X-Requested-With": "XMLHttpRequest"
        }
    })

    if (!res_0.ok) throw new Error("Failed to Fetch: " + url);
    const htmlPart = await res_0.text();

    // Bun.write(`logs/${Date.now()}`, htmlPart);


    const ssids = getIdsFromHtml(htmlPart);

    if (season > ssids.length) throw new Error(`Desired season ${season}, but found only ${ssids.length} season(s)`);
    const ssId = ssids[season - 1];

    console.log("SS ID:", ssId);

    const res_1 = await fetch(baseUrl + "/ajax/season/episodes/" + ssId, {
        method: "GET",
        headers: {
            "referer": url,
            "User-Agent": UserAgent,
            "X-Requested-With": "XMLHttpRequest"
        }
    })

    if (!res_1.ok) throw new Error("Failed to Fetch: " + url);
    const htmlPart_1 = await res_1.text();


    const epsIds = getIdsFromHtml(htmlPart_1);

    if (episode > epsIds.length) throw new Error(`Desired episode ${episode}, but found only ${epsIds.length} episode(s)`);
    const epId = epsIds[episode - 1];

    console.log("EP ID:", epId);
    // https://myflixerz.to/ajax/season/episodes/63706

    const res = await fetch(baseUrl + "/ajax/episode/servers/" + epId, {
        method: "GET",
        headers: {
            "referer": url,
            "User-Agent": UserAgent,
            "X-Requested-With": "XMLHttpRequest"
        }
    })

    if (!res.ok) throw new Error("Failed to Fetch: " + url);

    const htmlSeg = await res.text();
    const serverIds = getIdsFromHtml(htmlSeg);

    if (!serverIds) throw new Error("No server IDs found for " + url);

    let directLinks: Source[] = []
    for (const server_id of serverIds) {
        console.log("getting source for", server_id);
        const ref = baseUrl + "/watch-tv" + tvSlug + "." + server_id;
        const headers = {
            "referer": ref,
            "user-agent": UserAgent,
            "X-Requested-With": "XMLHttpRequest"
        }
        // const res = await fetch(baseUrl+"/watch-tv"+tvSlug+"."+server_id)
        // https://myflixerz.to/watch-tv/the-wrecking-crew-142383.13002473
        const res = await fetch(baseUrl + "/ajax/episode/sources/" + server_id, {
            headers
        })

        if (!res.ok) throw new Error("Failed to Fetch: " + baseUrl + "/ajax/episode/sources/" + server_id);

        const json: any = await res.json();

        if (json?.link) {
            const serverSources = await getSouceFromEmbed(json.link, headers);

            // validate link -  check if its giving 200 OK


            directLinks.push(...serverSources);
        }

    }
    return directLinks;
}



export async function getMyFlixerZSources(serve_cache = true, type: "movie" | "tv", tmdbMedia: MovieDetails | TvShowDetails, season = 0, episode = 0) {
    let sources: Source[] = [];
    try {
        if (type == "movie") {
            const tmdbMovie = tmdbMedia as MovieDetails;
            const { id, title, release_date } = tmdbMovie;
            const year = release_date ? release_date.split("-")[0] : "";

            const rawSources = serve_cache ? await redis.get(`myflixerz:${type}:sources:${id}`) : "";
            if (rawSources) {
                console.log("[MyFlixerZ] served cached sources");
                sources = JSON.parse(rawSources);
                return sources;
            }

            const rawMapped = serve_cache ? await redis.get(`myflixerz:${type}:mapped:${id}`) : "";
            let mappedUrl: string | null = rawMapped ? JSON.parse(rawMapped) : null;

            if (!mappedUrl) {
                mappedUrl = await getBestMatchMovie(title, year);

                if (mappedUrl)
                    redis.set(`myflixerz:${type}:mapped:${id}`, JSON.stringify(mappedUrl), "EX", MYFLIXERZ_MAP_CACHE_TTL);
                else
                    redis.set(`myflixerz:${type}:mapped:${id}`, JSON.stringify(mappedUrl), "EX", MYFLIXERZ_MAP_NOT_FOUND_CACHE_TTL);
            }

            if (!mappedUrl) return [];

            sources = await getMovieSources(mappedUrl);

            if (sources.length > 0)
                redis.set(`myflixerz:${type}:sources:${id}`, JSON.stringify(sources), "EX", MYFLIXERZ_SOURCE_CACHE_TTL);
            else
                redis.set(`myflixerz:${type}:sources:${id}`, JSON.stringify(sources), "EX", MYFLIXERZ_SOURCE_NOT_FOUND_CACHE_TTL);
        } else {
            const tmdbShow = tmdbMedia as TvShowDetails;
            const { id, name, number_of_seasons } = tmdbShow;
            const seasonCount = number_of_seasons ?? 1;

            const rawSources = serve_cache ? await redis.get(`myflixerz:${type}:sources:${id}:${season}:${episode}`) : "";
            if (rawSources) {
                console.log("[MyFlixerZ] served cached sources");
                sources = JSON.parse(rawSources);
                return sources;
            }

            const rawMapped = serve_cache ? await redis.get(`myflixerz:${type}:mapped:${id}`) : "";
            let mappedUrl: string | null = rawMapped ? JSON.parse(rawMapped) : null;

            if (!mappedUrl) {
                mappedUrl = await getBestMatchTv(name, seasonCount);

                if (mappedUrl)
                    redis.set(`myflixerz:${type}:mapped:${id}`, JSON.stringify(mappedUrl), "EX", MYFLIXERZ_MAP_CACHE_TTL);
                else
                    redis.set(`myflixerz:${type}:mapped:${id}`, JSON.stringify(mappedUrl), "EX", MYFLIXERZ_MAP_NOT_FOUND_CACHE_TTL);
            }

            if (!mappedUrl) return [];

            sources = await getTvSources(mappedUrl, season, episode) || [];

            if (sources.length > 0)
                redis.set(`myflixerz:${type}:sources:${id}:${season}:${episode}`, JSON.stringify(sources), "EX", MYFLIXERZ_SOURCE_CACHE_TTL);
            else
                redis.set(`myflixerz:${type}:sources:${id}:${season}:${episode}`, JSON.stringify(sources), "EX", MYFLIXERZ_SOURCE_NOT_FOUND_CACHE_TTL);
        }
    } catch (err) {
        console.log("[MyFlixerZ] Error Occured: ", err);
    }
    finally {
        return sources;
    }

}

export async function getMyFlixerZMovieSources(title: string, year: string) {
    try {
        const bestMatchedMoviURL = await getBestMatchMovie(title, year);
        if (!bestMatchedMoviURL) return [];

        return await getMovieSources(bestMatchedMoviURL);
    } catch (err) {
        console.log("Error Occured: ", err);
        return [];
    }
}

export async function getMyFlixerZTVSources(title: string, season_count: number, season: number, episode: number) {
    try {
        const bestMatchedTvURL = await getBestMatchTv(title, season_count);
        if (!bestMatchedTvURL) return [];
        return await getTvSources(bestMatchedTvURL, season, episode) || [];
    } catch (err) {
        console.log("Error Occured: ", err);
        return [];
    }
}


async function isOk(url: string, headers: any) {
    try {
        const res = await fetch(url, { headers });
        return res.ok;
    } catch {
        return false;
    }
}

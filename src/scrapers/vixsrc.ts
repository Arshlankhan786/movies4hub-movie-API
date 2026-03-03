/* ------------
https://vixsrc.to/
------------ */

import * as cheerio from "cheerio";
import { MovieDetails, TvShowDetails } from "tmdb-ts";
import type { Source } from "../types/types";

import { UserAgent } from "../helpers/util";
import redis from "../lib/redis";

const origin = "https://vixsrc.to"

const VIXSRC_SOURCE_CACHE_TTL = 3600 // 1 hours in seconds
const VIXSRC_SOURCE_NOT_FOUND_CACHE_TTL = 900 // 15 mins in seconds - to avoid overload

export async function getVixSrcSources(serve_cache = true, type: "movie" | "tv", tmdbMedia: MovieDetails | TvShowDetails, season = 0, episode = 0) {
    let sources: Source[] = [];

    try {
        if (type == "movie") {
            const tmdbMovie = tmdbMedia as MovieDetails;
            const { id } = tmdbMovie;


            // check if cached sources exists
            const rawSources = serve_cache ? await redis.get(`vixsrc:${type}:sources:${id}`) : "";
            if (rawSources) {
                console.log("[VixSrc] served cached sources");
                sources = JSON.parse(rawSources) // finally always runs ;(
                return sources;
            }
            const url1 = `${origin}/movie/${id}`;

            const basicHeaders = {
                "referer": url1,
                "user-agent": UserAgent
            }

            const checkHeadRes = await fetch(url1, {
                method: "HEAD",
                headers: basicHeaders
            });

            if (!checkHeadRes.ok) {
                console.log("[vixsrc] check head for:" + url1, ",returned response code:", checkHeadRes.status,);
                return sources;
            }

            // fetch html to extract vixsrc id and tokens
            const res1 = await fetch(url1, {
                headers: {
                    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                    "user-agent": UserAgent
                }
            });

            if (!res1.ok) {
                console.log("[vixsrc] failed to fetch for html:" + url1, ",returned response code:", checkHeadRes.status,);
                return sources;
            }

            const html = await res1.text();
            const sourceUrl = await extractRawHtmlforUrl(html);

            if (sourceUrl) {
                sources.push({
                    dub: "English-Italian",
                    type: "hls",
                    url: sourceUrl,
                    headers: {
                        "referer": url1,
                        // "user-agent": UserAgent
                    }
                })
            }

            if (sources) // only cache sources if not empty
                redis.set(`vixsrc:${type}:sources:${id}`, JSON.stringify(sources), "EX", VIXSRC_SOURCE_CACHE_TTL);
            else
                redis.set(`vixsrc:${type}:sources:${id}`, JSON.stringify(sources), "EX", VIXSRC_SOURCE_NOT_FOUND_CACHE_TTL);


        } else {
            const tmdbShow = tmdbMedia as TvShowDetails;
            const { id } = tmdbShow;


            // check if cached sources exists
            const rawSources = serve_cache ? await redis.get(`vixsrc:${type}:sources:${id}:${season}:${episode}`) : "";
            if (rawSources) {
                console.log("[vixsrc] served cached sources");
                sources = JSON.parse(rawSources) // finally always runs ;(
                return sources;
            }

            const url1 = `${origin}/tv/${id}/${season}/${episode}`;

            const basicHeaders = {
                "referer": url1,
                "user-agent": UserAgent
            }

            const checkHeadRes = await fetch(url1, {
                method: "HEAD",
                headers: basicHeaders
            });

            if (!checkHeadRes.ok) {
                console.log("[vixsrc] check head for:" + url1, ",returned response code:", checkHeadRes.status,);
                return sources;
            }

            // fetch html to extract vixsrc id and tokens
            const res1 = await fetch(url1, {
                headers: {
                    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                    "user-agent": UserAgent
                }
            });

            if (!res1.ok) {
                console.log("[vixsrc] failed to fetch for html:" + url1, ",returned response code:", checkHeadRes.status,);
                return sources;
            }

            const html = await res1.text();
            const sourceUrl = await extractRawHtmlforUrl(html);

            if (sourceUrl) {
                sources.push({
                    dub: "English-Italian",
                    type: "hls",
                    url: sourceUrl,
                    headers: {
                        "referer": url1,
                        // "user-agent": UserAgent
                    }
                })
            }

            if (sources) // only cache sources if not empty
                redis.set(`vixsrc:${type}:sources:${id}:${season}:${episode}`, JSON.stringify(sources), "EX", VIXSRC_SOURCE_CACHE_TTL);
            else
                redis.set(`vixsrc:${type}:sources:${id}:${season}:${episode}`, JSON.stringify(sources), "EX", VIXSRC_SOURCE_NOT_FOUND_CACHE_TTL);

        }

    } catch (err) {
        console.log("[vixsrc] Error Occured, Details: ", err);
    }
    finally {
        return sources;
    }

}


async function extractRawHtmlforUrl(html: string) {
    const $ = cheerio.load(html, {xml:true});

    let rawScript = ""

    $('script').each((index, element) => {
        const text = $(element).text();

        if (text && text.includes('window.masterPlaylist')) {
            console.log("[vixsrc] Got raw script");
            rawScript = text;
            return false; // break the loop
        }
    });

    if (!rawScript) return;

    const urlRegex = /url:\s*'([^']+)'/;
    const tokenRegex = /'token':\s*'([^']+)'/;
    const expiresRegex = /'expires':\s*'([^']+)'/;

    const urlMatch = rawScript.match(urlRegex);
    const tokenMatch = rawScript.match(tokenRegex);
    const expireslMatch = rawScript.match(expiresRegex);

    const token = tokenMatch ? tokenMatch[1] : null;
    const url = urlMatch ? urlMatch[1] : null;
    const expires = expireslMatch ? expireslMatch[1] : null;

    console.log("[vixsrc] Extracted Master URL:", url);
    console.log("[vixsrc] Extracted Token:", token);
    console.log("[vixsrc] Extracted expires:", expires);

    if (!token || !url || !expires) {
        console.log("[vixsrc] failed to extract url & token");
        return;
    }

    return `${url}?token=${token}&expires=${expires}&h=1&lang=en`

}
import cors from "@elysiajs/cors";
import { Elysia, t } from "elysia";
import { TMDB } from "tmdb-ts";
import { isTMDBError } from "./helpers/errors";
import { logger } from "./helpers/logger";
import { dateToUnix, isTooLarge } from "./helpers/util";
import { providers } from "./lib/sources";
import { fetchSubtitles } from "./lib/subtitle";



if (!Bun.env.TMDB_ACCESS_TOKEN) throw new Error("TMDB_ACCESS_TOKEN not found on .env!");

export const serverOrigin = Bun.env.SERVER_ORIGIN || "";



const PORT = Number(process.env.PORT) || 3000;

app.listen({
  port: PORT,
  hostname: "0.0.0.0"
});
const envOrigins = Bun.env.ALLOWED_ORIGINS;

const ALLOWED_ORIGINS: string[] | "*" = envOrigins
    ? envOrigins.split(",").map((o: string) => o.trim().replace(/\/$/, ""))
    : "*";

const MOVIE_RELEASED_THRESHOLD = 2_592_000 * 1000 // 30 days in ms
const SERIES_AIR_THRESHOLD = 604_800 * 1000 // 7 days in ms


// for proxy safety
const MAX_M3U8_SIZE = 5 * 1024 * 1024;       // 5 MB
const MAX_TS_SIZE = 50 * 1024 * 1024;        // 50 MB
const MAX_FETCH_SIZE = 50 * 1024 * 1024;     // 50 MB
const MAX_MP4_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB


const tmdbClient = new TMDB(Bun.env.TMDB_ACCESS_TOKEN);

const app = new Elysia()
    .use(cors({
        origin: ALLOWED_ORIGINS
    }))
    .onBeforeHandle(({ request, set }) => {
        if (request.method === 'OPTIONS') return;

        // FAST PATH: If CORS is completely open, skip the hotlink check entirely
        if (ALLOWED_ORIGINS === "*") return;

        const incomingSource: string | null = request.headers.get('origin') || request.headers.get('referer');

        // Since we bypassed "*", TypeScript knows ALLOWED_ORIGINS is definitely an array here
        const isAllowed: boolean = incomingSource !== null &&
            ALLOWED_ORIGINS.some((domain: string) => incomingSource.startsWith(domain));

        if (!isAllowed) {
            set.status = 403;
            return "";
        }
    })
    .decorate("tmdb", tmdbClient)
    .get("/", () => {
        return {
            // name: "Peach API V2",
            // endpoints: [
            //     "--------------API--------------",
            //     "/:provider/movie/:id",
            //     "/:provider/tv/:id/:season/:epsiode",
            //     "-------------PROXY--------------",
            //     "/m3u8-proxy?url={url}&headers={encodedHeaders}",
            //     "/ts-segment?url={url}&headers={encodedHeaders}",
            //     "/fetch?url={url}&headers={encodedHeaders}",
            //     "/mp4-proxy?url={url}&headers=",
            // ],
            // providers: [
            //     "moviebox",
            //     "myflixerz",
            //     "vixsrc",
            // ]
        }
    })

    .get("/m3u8-proxy", async ({ request, query: { url, headers } }) => {
        let corsHeaders: Record<string, string> = {};

        if (headers) {
            try {
                corsHeaders = JSON.parse(decodeURIComponent(headers));
            } catch (err) {
                return new Response("Invalid headers format", { status: 400 });
            }
        }

        try {
            const res = await fetch(url, {
                headers: corsHeaders,
                signal: request.signal // Abort if client disconnects
            });

            if (!res.ok) {
                console.log("Fetch failed with status:", res.status, "Url:", url)
                return new Response(res.body, { status: res.status });
            }

            // Size limit check
            if (isTooLarge(res.headers.get("content-length"), MAX_M3U8_SIZE)) {
                return new Response("File too large", { status: 413 });
            }

            const text = await res.text();
            const encodedHeaders = encodeURIComponent(headers || "");

            const proxifiedM3u8 = text.split("\n").map(line => {
                const tl = line.trim();
                if (!tl) return line;

                if (tl.startsWith("#EXT")) {
                    return tl.replace(/URI="([^"]+)"/g, (_, uri) => {
                        const absoluteUrl = new URL(uri, url).href;
                        let proxiedUrl;
                        const encodedUrl = encodeURIComponent(absoluteUrl);

                        if (absoluteUrl.includes('.m3u') || absoluteUrl.includes('playlist')) {
                            proxiedUrl = `${serverOrigin}/m3u8-proxy?url=${encodedUrl}${headers ? `&headers=${encodedHeaders}` : ""}`;
                        } else {
                            proxiedUrl = `${serverOrigin}/fetch?url=${encodedUrl}${headers ? `&headers=${encodedHeaders}` : ""}`;
                        }

                        return `URI="${proxiedUrl}"`;
                    })
                }

                const absoluteUrl = new URL(tl, url).href;
                const encodedUrl = encodeURIComponent(absoluteUrl);

                if (absoluteUrl.includes('.m3u') || absoluteUrl.includes('playlist')) {
                    return `${serverOrigin}/m3u8-proxy?url=${encodedUrl}${headers ? `&headers=${encodedHeaders}` : ""}`;
                } else {
                    return `${serverOrigin}/ts-segment?url=${encodedUrl}${headers ? `&headers=${encodedHeaders}` : ""}`;
                }
            }).join("\n");

            return new Response(proxifiedM3u8, {
                headers: {
                    "Content-Type": res.headers.get("Content-Type") || "application/vnd.apple.mpegurl",
                }
            });

        } catch (err: any) {
            if (err.name === 'AbortError') return new Response("Client disconnected", { status: 499 });
            logger.red(err);
            return new Response("Internal Server Error", { status: 500 });
        }
    }, {
        query: t.Object({
            url: t.String(),
            headers: t.Optional(t.String())
        })
    })

    .get("/ts-segment", async ({ request, query: { url, headers } }) => {
        let corsHeaders: Record<string, string> = {};

        if (headers) {
            try {
                corsHeaders = JSON.parse(decodeURIComponent(headers));
            } catch (err) {
                return new Response("Invalid headers format", { status: 400 });
            }
        }

        // Force keep-alive for the upstream connection
        corsHeaders["Connection"] = "keep-alive";

        try {
            const res = await fetch(url, {
                headers: corsHeaders,
                signal: request.signal // Abort if client disconnects
            });

            if (!res.ok) {
                console.error("TS segment Fetch failed:", res.status, url);
                return new Response(res.body, { status: res.status });
            }

            // Size limit check
            if (isTooLarge(res.headers.get("content-length"), MAX_TS_SIZE)) {
                return new Response("Segment too large", { status: 413 });
            }

            return new Response(res.body, {
                headers: {
                    "Content-Type": res.headers.get("Content-Type") || "video/MP2T",
                    "Cache-Control": "public, max-age=86400"
                }
            });

        } catch (err: any) {
            if (err.name === 'AbortError') return new Response("Client disconnected", { status: 499 });
            logger.red(err);
            return new Response("Internal Server Error", { status: 500 });
        }
    }, {
        query: t.Object({
            url: t.String(),
            headers: t.Optional(t.String())
        })
    })

    .get("/mp4-proxy", async ({ request, query: { url, headers } }) => {
        let corsHeaders: Record<string, string> = {};

        if (headers) {
            try {
                corsHeaders = JSON.parse(decodeURIComponent(headers));
            } catch (err) {
                return new Response("Invalid headers format", { status: 400 });
            }
        }

        const clientRange = request.headers.get("range");

        if (clientRange) {
            corsHeaders["Range"] = clientRange;
        }

        // if (download) {
        //     corsHeaders["Content-Disposition"] = "attachment";
        // }

        try {
            const res = await fetch(url, {
                headers: corsHeaders,
                signal: request.signal // Abort if client disconnects
            });

            if (!res.ok) {
                console.error("[MP4] Fetch failed:", res.status, url);
                return new Response(await res.text(), { status: res.status });
            }

            // Size limit check
            if (isTooLarge(res.headers.get("content-length"), MAX_MP4_SIZE)) {
                return new Response("Video too large", { status: 413 });
            }

            return new Response(res.body, {
                status: res.status,
                headers: {
                    "content-type": res.headers.get('content-type') || "video/mp4",
                    "content-range": res.headers.get("content-range") || "",
                    "content-length": res.headers.get('content-length') || "",
                    "accept-ranges": "bytes",
                }
            })

        } catch (err: any) {
            if (err.name === 'AbortError') return new Response("Client disconnected", { status: 499 });
            console.error("[MP4] Proxy Error:", err);
            return new Response("Internal Server Error", { status: 500 });
        }
    }, {
        query: t.Object({
            url: t.String(),
            headers: t.Optional(t.String()),
            // download: t.Optional(t.String())
        })
    })

    .get("/fetch", async ({ request, query: { url, headers } }) => {
        let customHeaders: Record<string, string> = {};
        if (headers) {
            try {
                customHeaders = JSON.parse(decodeURIComponent(headers));
            } catch (e) {
                console.error("Fetch header parse failed");
            }
        }

        try {
            const res = await fetch(url, {
                headers: customHeaders,
                signal: request.signal // Abort if client disconnects
            });

            // Size limit check
            if (isTooLarge(res.headers.get("content-length"), MAX_FETCH_SIZE)) {
                return new Response("Payload too large", { status: 413 });
            }

            return new Response(res.body, {
                status: res.status,
                headers: {
                    "content-type": res.headers.get("content-type") || "application/octet-stream",
                }
            });
        } catch (err: any) {
            if (err.name === 'AbortError') return new Response("Client disconnected", { status: 499 });
            return new Response("Fetch Error", { status: 500 });
        }
    }, {
        query: t.Object({
            url: t.String(),
            headers: t.Optional(t.String())
        })
    })

    .get("/subs/movie/:tmdbId", async ({ params: { tmdbId } }) => {
        return await fetchSubtitles(
            `https://sub.wyzie.ru/search?id=${tmdbId}`,
            `subs:movie:${tmdbId}`
        );
    })

    .get("/subs/tv/:tmdbId/:season/:episode", async ({ params: { tmdbId, season, episode } }) => {
        return await fetchSubtitles(
            `https://sub.wyzie.ru/search?id=${tmdbId}&season=${season}&episode=${episode}`,
            `subs:tv:${tmdbId}:${season}:${episode}`
        );
    })

    .get("/:provider/movie/:tmdbId",
        async ({ tmdb, status, params: { provider, tmdbId }, query }) => {
            if (!providers[provider])
                return status(404, "Provider not Found");

            const then = performance.now();
            const serve_cache = query.serve_cache !== false; // always serve cache by default

            if (!serve_cache)
                logger.blue("Serving without cache")

            try {
                const tmdbMovie = await tmdb.movies.details(tmdbId, ["release_dates"]);
                const { release_date, poster_path } = tmdbMovie;

                const unix = dateToUnix(release_date);

                // count as released if releasing in 1 month or released
                if (Date.now() < unix - MOVIE_RELEASED_THRESHOLD)
                    return status(404, "Movie not released yet!");

                const sources = await providers[provider].getMovie(serve_cache, tmdbMovie);

                return {
                    type: "movie",
                    tmdbId,
                    providerName: provider,
                    tookMs: performance.now() - then,
                    sources,
                }

            } catch (err) {
                if (isTMDBError(err)) {
                    logger.red(`[TMDB Error]: ${err.status_message} (Code: ${err.status_code})`);

                    if (err.status_code === 34)
                        return status(404, "Movie not found");
                    else
                        return status(500, "Internal Server Error");

                } else {
                    logger.red(`[Error]: Error during tmdb fetch : `, err);
                    return status(500, "Internal Server Error");
                }
            }
        },

        // type validation - returns 422 on fail
        {
            params: t.Object({
                tmdbId: t.Number(),
                provider: t.String()
            }),
            query: t.Object({
                serve_cache: t.Optional(t.BooleanString())
            }),
            response: {
                404: t.String(),
                500: t.String(),
                200: t.Object({
                    type: t.Literal("movie"),
                    tmdbId: t.Number(),
                    providerName: t.String(),
                    tookMs: t.Number(),
                    sources: t.Array(
                        t.Object({
                            url: t.String(),
                            dub: t.String(),
                            type: t.Union([
                                t.Literal("mp4"),
                                t.Literal("hls")
                            ]),
                            quality: t.Optional(t.Number()),
                            sizeBytes: t.Optional(t.Number()),
                            headers: t.Any()
                        })
                    )
                })
            }
        }
    )
    .get("/:provider/tv/:tmdbId/:season/:episode",
        async ({ tmdb, status, params: { provider, tmdbId, season, episode }, query }) => {
            if (!providers[provider])
                return status(404, "Provider not Found");

            const then = performance.now();
            const serve_cache = query.serve_cache !== false; // always serve cache by default

            if (!serve_cache)
                logger.blue("Serving without cache")

            try {
                const tmdbShow = await tmdb.tvShows.details(tmdbId);
                const { first_air_date, poster_path } = tmdbShow;

                const unix = dateToUnix(first_air_date);

                // count as aired if airing in 3 days or aired
                if (Date.now() < unix - SERIES_AIR_THRESHOLD)
                    return status(404, "Series not started airing yet!");
                /*
                    TODO: Implement proper checks for Season & episode release. 
                */

                const sources = await providers[provider].getTv(serve_cache, tmdbShow, season, episode);

                return {
                    type: "tv",
                    tmdbId,
                    season,
                    episode,
                    providerName: provider,
                    tookMs: performance.now() - then,
                    sources,
                }

            } catch (err) {
                if (isTMDBError(err)) {
                    logger.red(`[TMDB Error]: ${err.status_message} (Code: ${err.status_code})`);

                    if (err.status_code === 34)
                        return status(404, "Series not found");
                    else
                        return status(500, "Internal Server Error");

                } else {
                    logger.red(`[Error]: Error during tmdb fetch : `, err);
                    return status(500, "Internal Server Error");
                }
            }
        },

        // type validation - returns 422 on fail
        {
            params: t.Object({
                tmdbId: t.Number(),
                provider: t.String(),
                season: t.Number(),
                episode: t.Number(),
            }),
            query: t.Object({
                serve_cache: t.Optional(t.BooleanString())
            }),
            response: {
                404: t.String(),
                500: t.String(),
                200: t.Object({
                    type: t.Literal("tv"),
                    tmdbId: t.Number(),
                    season: t.Number(),
                    episode: t.Number(),
                    providerName: t.String(),
                    tookMs: t.Number(),
                    sources: t.Array(
                        t.Object({
                            url: t.String(),
                            dub: t.String(),
                            type: t.Union([
                                t.Literal("mp4"),
                                t.Literal("hls")
                            ]),
                            quality: t.Optional(t.Number()),
                            sizeBytes: t.Optional(t.Number()),
                            headers: t.Any()
                        })
                    )
                })
            }
        }
    )

    .listen(PORT);


logger.green(`Elysia running on ${app.server?.protocol}://${app.server?.hostname}:${PORT}`)

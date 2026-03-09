import cors from "@elysiajs/cors";
import { Elysia, t } from "elysia";
import { TMDB } from "tmdb-ts";
import { isTMDBError } from "./helpers/errors";
import { logger } from "./helpers/logger";
import { dateToUnix } from "./helpers/util";
import { providers } from "./lib/sources";
import { fetchSubtitles } from "./lib/subtitle";
import type { Source } from "./types/types";

if (!Bun.env.TMDB_ACCESS_TOKEN) throw new Error("TMDB_ACCESS_TOKEN not found on .env!");

export const serverOrigin = Bun.env.SERVER_ORIGIN || "";

const PORT = Number(process.env.PORT) || 3000;

const envOrigins = Bun.env.ALLOWED_ORIGINS;

const ALLOWED_ORIGINS: string[] | "*" = envOrigins
    ? envOrigins.split(",").map((o: string) => o.trim().replace(/\/$/, ""))
    : "*";

const MOVIE_RELEASED_THRESHOLD = 2_592_000 * 1000; // 30 days in ms
const SERIES_AIR_THRESHOLD     =   604_800 * 1000; // 7 days in ms

const WORKER_PROXY = "https://movies4hub-proxy.online902317.workers.dev";

const tmdbClient = new TMDB(Bun.env.TMDB_ACCESS_TOKEN);

/**
 * Rewrites a source URL through the Cloudflare stream proxy.
 *
 * iframe sources carry a plain embed-page URL — sending them through the
 * proxy would break the embed entirely.  We return them unchanged so the
 * frontend can drop them straight into an <iframe src="…">.
 *
 * hls / mp4 sources are rewritten as before.
 */
function rewriteSourceUrl(source: Source): Source {
    if (source.type === "iframe") {
        // Iframe URLs are embed pages, not raw streams — pass through as-is.
        return source;
    }

    const cleanUrl      = decodeURIComponent(source.url);
    const encodedUrl    = encodeURIComponent(cleanUrl);
    const encodedHeaders =
        source.headers && Object.keys(source.headers).length > 0
            ? `&headers=${encodeURIComponent(JSON.stringify(source.headers))}`
            : "";

    return {
        ...source,
        url: `${WORKER_PROXY}?url=${encodedUrl}${encodedHeaders}`,
    };
}

// ---------------------------------------------------------------------------

const app = new Elysia()
    .use(cors({ origin: ALLOWED_ORIGINS }))
    .onBeforeHandle(({ request, set }) => {
        if (request.method === "OPTIONS") return;

        // FAST PATH: completely open CORS — skip hotlink check
        if (ALLOWED_ORIGINS === "*") return;

        const incomingSource: string | null =
            request.headers.get("origin") || request.headers.get("referer");

        // Allow direct browser navigation (no origin header)
        if (!incomingSource) return;

        const isAllowed =
            Array.isArray(ALLOWED_ORIGINS) &&
            ALLOWED_ORIGINS.some((domain) => incomingSource.startsWith(domain));

        if (!isAllowed) {
            set.status = 403;
            return "Forbidden";
        }
    })
    .decorate("tmdb", tmdbClient)

    // ── health ────────────────────────────────────────────────────────────────
    .get("/", () => ({}))

    // ── subtitles ─────────────────────────────────────────────────────────────
    .get("/subs/movie/:tmdbId", async ({ params: { tmdbId } }) =>
        fetchSubtitles(
            `https://sub.wyzie.ru/search?id=${tmdbId}`,
            `subs:movie:${tmdbId}`,
        ),
    )

    .get("/subs/tv/:tmdbId/:season/:episode", async ({ params: { tmdbId, season, episode } }) =>
        fetchSubtitles(
            `https://sub.wyzie.ru/search?id=${tmdbId}&season=${season}&episode=${episode}`,
            `subs:tv:${tmdbId}:${season}:${episode}`,
        ),
    )

    // ── movie sources ─────────────────────────────────────────────────────────
    .get(
        "/:provider/movie/:tmdbId",
        async ({ tmdb, status, params: { provider, tmdbId }, query }) => {
            if (!providers[provider])
                return status(404, "Provider not Found");

            const then        = performance.now();
            const serve_cache = query.serve_cache !== false;

            if (!serve_cache) logger.blue("Serving without cache");

            try {
                const tmdbMovie      = await tmdb.movies.details(tmdbId, ["release_dates"]);
                const { release_date } = tmdbMovie;
                const unix           = dateToUnix(release_date);

                if (Date.now() < unix - MOVIE_RELEASED_THRESHOLD)
                    return status(404, "Movie not released yet!");

                const rawSources = await providers[provider].getMovie(serve_cache, tmdbMovie);
                const sources    = rawSources.map(rewriteSourceUrl);

                return {
                    type:         "movie" as const,
                    tmdbId,
                    providerName: provider,
                    tookMs:       performance.now() - then,
                    sources,
                };

            } catch (err) {
                if (isTMDBError(err)) {
                    logger.red(`[TMDB Error]: ${err.status_message} (Code: ${err.status_code})`);
                    return err.status_code === 34
                        ? status(404, "Movie not found")
                        : status(500, "Internal Server Error");
                }
                logger.red("[Error]: Error during tmdb fetch:", err);
                return status(500, "Internal Server Error");
            }
        },
        {
            params: t.Object({
                tmdbId:   t.Number(),
                provider: t.String(),
            }),
            query: t.Object({
                serve_cache: t.Optional(t.BooleanString()),
            }),
            response: {
                404: t.String(),
                500: t.String(),
                200: t.Object({
                    type:         t.Literal("movie"),
                    tmdbId:       t.Number(),
                    providerName: t.String(),
                    tookMs:       t.Number(),
                    sources: t.Array(
                        t.Object({
                            url:       t.String(),
                            dub:       t.String(),
                            // "iframe" is now a valid stream type alongside hls / mp4
                            type:      t.Union([t.Literal("mp4"), t.Literal("hls"), t.Literal("iframe")]),
                            quality:   t.Optional(t.Number()),
                            sizeBytes: t.Optional(t.Number()),
                            headers:   t.Optional(t.Any()),
                        }),
                    ),
                }),
            },
        },
    )

    // ── tv sources ────────────────────────────────────────────────────────────
    .get(
        "/:provider/tv/:tmdbId/:season/:episode",
        async ({ tmdb, status, params: { provider, tmdbId, season, episode }, query }) => {
            if (!providers[provider])
                return status(404, "Provider not Found");

            const then        = performance.now();
            const serve_cache = query.serve_cache !== false;

            if (!serve_cache) logger.blue("Serving without cache");

            try {
                const tmdbShow         = await tmdb.tvShows.details(tmdbId);
                const { first_air_date } = tmdbShow;
                const unix             = dateToUnix(first_air_date);

                if (Date.now() < unix - SERIES_AIR_THRESHOLD)
                    return status(404, "Series not started airing yet!");

                const rawSources = await providers[provider].getTv(serve_cache, tmdbShow, season, episode);
                const sources    = rawSources.map(rewriteSourceUrl);

                return {
                    type:         "tv" as const,
                    tmdbId,
                    season,
                    episode,
                    providerName: provider,
                    tookMs:       performance.now() - then,
                    sources,
                };

            } catch (err) {
                if (isTMDBError(err)) {
                    logger.red(`[TMDB Error]: ${err.status_message} (Code: ${err.status_code})`);
                    return err.status_code === 34
                        ? status(404, "Series not found")
                        : status(500, "Internal Server Error");
                }
                logger.red("[Error]: Error during tmdb fetch:", err);
                return status(500, "Internal Server Error");
            }
        },
        {
            params: t.Object({
                tmdbId:   t.Number(),
                provider: t.String(),
                season:   t.Number(),
                episode:  t.Number(),
            }),
            query: t.Object({
                serve_cache: t.Optional(t.BooleanString()),
            }),
            response: {
                404: t.String(),
                500: t.String(),
                200: t.Object({
                    type:         t.Literal("tv"),
                    tmdbId:       t.Number(),
                    season:       t.Number(),
                    episode:      t.Number(),
                    providerName: t.String(),
                    tookMs:       t.Number(),
                    sources: t.Array(
                        t.Object({
                            url:       t.String(),
                            dub:       t.String(),
                            // "iframe" is now a valid stream type alongside hls / mp4
                            type:      t.Union([t.Literal("mp4"), t.Literal("hls"), t.Literal("iframe")]),
                            quality:   t.Optional(t.Number()),
                            sizeBytes: t.Optional(t.Number()),
                            headers:   t.Optional(t.Any()),
                        }),
                    ),
                }),
            },
        },
    );

// ---------------------------------------------------------------------------

app.listen({ port: PORT, hostname: "0.0.0.0" });

logger.green(`Elysia running on http://0.0.0.0:${PORT}`);

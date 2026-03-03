import { SUB_CACHE_HIT, SUB_CACHE_MISS } from "../helpers/const";
import { UserAgent } from "../helpers/util";
import redis from "./redis";

export async function fetchSubtitles(url: string, cacheKey: string) {
    // 1. Check Cache
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
        // 2. Fetch from Wyzie
        const res = await fetch(url, {
            headers: { "User-Agent": UserAgent }
        });

        if (!res.ok) throw new Error("Subtitle fetch failed");

        const data = await res.json();
        const hasSubs = Array.isArray(data) && data.length > 0;

        // 3. Set Cache (7 days if found, 3 hours if empty)
        await redis.set(cacheKey, JSON.stringify(data), "EX", hasSubs ? SUB_CACHE_HIT : SUB_CACHE_MISS);

        return data;
    } catch (e) {
        // Cache empty result on error to prevent spamming
        await redis.set(cacheKey, JSON.stringify([]), "EX", SUB_CACHE_MISS);
        return [];
    }
}

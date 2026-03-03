export const UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

export function dateToUnix(tmdb_release_date: string) { // YYYY-MM-DD
    return new Date(tmdb_release_date).getTime();
}

export const isEmpty = (v:unknown) =>
    v == null ||
    (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

export const isTooLarge = (contentLength: string | null, limit: number) => {
    return contentLength && parseInt(contentLength, 10) > limit;
};
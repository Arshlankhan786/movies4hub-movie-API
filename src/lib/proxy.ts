import { serverOrigin } from "..";
import type { Source } from "../types/types";


type ProxyConfig = {
    name: string;
    buildUrl: (type: "hls" | "mp4", targetUrl: string, headers?: Record<string, string>) => string;
};

const DEFAULT_PROXY: ProxyConfig = {
    name: "default",
    buildUrl: (type, targetUrl, headers) => {
        const encodedUrl = encodeURIComponent(targetUrl);
        const encodedHeaders = headers ? encodeURIComponent(JSON.stringify(headers)) : "";
        const isHls = type === "hls" || targetUrl.includes(".m3u8");

        if (isHls) {
            return `${serverOrigin}/m3u8-proxy?url=${encodedUrl}&headers=${encodedHeaders}`;
        } else {
            return `${serverOrigin}/mp4-proxy?url=${encodedUrl}&headers=${encodedHeaders}`;
        }
    }
};

export function proxifySources(provider: string, sources: Source[]): Source[] {
    return sources.map((source) => ({
        ...source,
        url: DEFAULT_PROXY.buildUrl(source.type, source.url, source.headers),
    }));
}



// const MYFLIXER_PROXY: ProxyConfig = {
//     name: "default",
//     buildUrl: (targetUrl, headers) => {
//         const encodedUrl = encodeURIComponent(targetUrl);
//         const encodedHeaders = headers ? encodeURIComponent(JSON.stringify(headers)) : "";
//         const isHls = targetUrl.includes(".m3u8");
//         const endpoint = isHls ? "/proxy" : "/mp4-proxy";
//         const headersParam = encodedHeaders ? `&headers=${encodedHeaders}` : "";

//         return `${MYFLIXER_PROXY_BASE}${endpoint}?url=${encodedUrl}${headersParam}`;
//     }
// };

// export const PROVIDER_PROXIES: Record<string, ProxyConfig[]> = {
//     moviebox: [DEFAULT_PROXY],
//     myflixerz: [DEFAULT_PROXY],
//     vixsrc: [DEFAULT_PROXY]
// };

// export function proxifySources(provider: string, sources: Source[]): Source[] {
//     const proxy = PROVIDER_PROXIES[provider]?.[0];
//     if (!proxy) return sources;

//     return sources.map((source) => ({
//         ...source,
//         url: proxy.buildUrl(source.type, source.url, source.headers),
//     }));
// }

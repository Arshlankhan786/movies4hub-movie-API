export type Source = {
    url: string;
    dub: string;
    /** hls / mp4 → proxied stream   iframe → embed URL, never rewritten */
    type: "hls" | "mp4" | "iframe";
    quality?: number;
    sizeBytes?: number;
    headers?: Record<string, string>;
};
type Etc = {
    name: string;
    dub: "English" | "French" | "Spanish" | "Hindi" | "Dual Audio" | "Multi Audio" | "Unknown";
    sources: Source[]
}

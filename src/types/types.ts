export type Source = {
    url: string,
    dub: string,
    type: "hls" | "mp4",
    quality?: number
    sizeBytes?: number
    headers: any
}

type Etc = {
    name: string;
    dub: "English" | "French" | "Spanish" | "Hindi" | "Dual Audio" | "Multi Audio" | "Unknown";
    sources: Source[]
}

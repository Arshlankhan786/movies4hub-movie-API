// types/tmdb.ts
export interface TMDBError {
    status_code: number;
    status_message: string;
    success: boolean;
}
export function isTMDBError(error: unknown): error is TMDBError {
    return (
        typeof error === 'object' &&
        error !== null &&
        'status_code' in error &&
        'status_message' in error
    );
}
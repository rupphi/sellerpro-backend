export class MarketplaceHttpError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
}

// Only wrap explicitly known read operations, never price uploads (even on timeout).
export async function retryPriceRead<T>(operation: () => Promise<T>,
    wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    for (let attempt = 0; ; attempt++) {
        try { return await operation(); }
        catch (error) {
            const transient = error instanceof Error && (
                error.name === "TimeoutError" ||
                (error instanceof TypeError && error.message === "fetch failed") ||
                (error instanceof MarketplaceHttpError && [500, 502, 503, 504].includes(error.status))
            );
            if (!transient) throw error;
            if (attempt === 2) throw new Error("Chưa đọc được giá Ozon sau 3 lần thử. Vui lòng thử lại sau.");
            // Each attempt still passes through the shared account rate limiter.
            await wait(1000 * 2 ** attempt);
        }
    }
}

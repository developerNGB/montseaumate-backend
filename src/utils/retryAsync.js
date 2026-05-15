/**
 * Retry an async fn up to `attempts` times with optional delay between tries.
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, delayMs?: number, onRetry?: (err: Error, attempt: number) => void }} opts
 * @returns {Promise<T>}
 */
export async function retryAsync(fn, opts = {}) {
    const attempts = Math.max(1, opts.attempts ?? 3);
    const delayMs = opts.delayMs ?? 800;
    let lastErr;

    for (let i = 1; i <= attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err));
            if (i < attempts) {
                opts.onRetry?.(lastErr, i);
                await new Promise((r) => setTimeout(r, delayMs * i));
            }
        }
    }
    throw lastErr;
}

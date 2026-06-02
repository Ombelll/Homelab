import { config } from "./config.js";

/**
 * fetch() with a hard timeout. Node's global fetch never times out on its
 * own, so every agent request goes through here to guarantee it either
 * completes or rejects within config.requestTimeoutMs. The timeout error is
 * rewritten to a readable message (the raw DOMException just says "aborted").
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`request timed out after ${config.requestTimeoutMs}ms: ${url}`);
    }
    throw err;
  }
}

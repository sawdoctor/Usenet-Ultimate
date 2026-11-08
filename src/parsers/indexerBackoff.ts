const DEFAULT_BACKOFF_MS = 10 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const UNIT_MS: Record<string, number> = { second: 1000, minute: 60 * 1000, hour: 60 * 60 * 1000 };
const LIMIT_TEXT = /request limit|api limit|limit reached|too many requests/i;
const RETRY_IN = /retry in (\d+)\s*(second|minute|hour)/i;

const blockedUntil = new Map<string, number>();

/** How long an indexer asked to be left alone, or undefined when the response is not a rate-limit refusal. */
export function rateLimitBackoffMs(status: number | undefined, body: unknown, retryAfterHeader: unknown): number | undefined {
  const text = typeof body === 'string' ? body : '';
  if (status !== 429 && !(text.includes('<error') && LIMIT_TEXT.test(text))) return undefined;
  const retryIn = RETRY_IN.exec(text);
  const retryAfterSeconds = Number(retryAfterHeader);
  const ms = retryIn
    ? Number(retryIn[1]) * UNIT_MS[retryIn[2].toLowerCase()]
    : retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : DEFAULT_BACKOFF_MS;
  return Math.min(ms, MAX_BACKOFF_MS);
}

export function noteIndexerResponse(indexerName: string, status: number | undefined, body: unknown, retryAfterHeader: unknown, now = Date.now()): void {
  const backoffMs = rateLimitBackoffMs(status, body, retryAfterHeader);
  if (backoffMs !== undefined) blockedUntil.set(indexerName, now + backoffMs);
}

/** When the indexer accepts searches again, or undefined when it can be searched now. */
export function rateLimitedUntil(indexerName: string, now = Date.now()): number | undefined {
  const until = blockedUntil.get(indexerName);
  if (until === undefined || until > now) return until;
  blockedUntil.delete(indexerName);
  return undefined;
}

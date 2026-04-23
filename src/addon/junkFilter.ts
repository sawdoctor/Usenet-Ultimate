/**
 * Baseline Junk Filter
 *
 * Strips obvious non-releases that leak in from older indexer databases:
 * bare archive parts (.rar, .r01–.r99, .001–.999), NZB containers, and
 * parity files (.par2). These are never valid releases — they're stray
 * file entries that predate proper title-level indexing.
 *
 * Shared by the backend filter pass and the Index Manager transparency
 * card so the two can never drift out of sync.
 */

export const JUNK_LABELS = ['par2', 'nzb', 'rar', 'r01–r99', '001–999'] as const;

export const JUNK_EMOJI = '🧹';

/**
 * Matches titles that end in a bare archive-part extension.
 * Anchored so legitimate titles containing the word "rar" or "nzb" mid-string
 * (e.g. "The.Rarest.Gem") are not caught.
 */
const JUNK_PATTERN = /(?:^|[^a-z0-9])(par2|nzb|rar|r\d{1,3}|\d{3})\s*$/i;

export function isBareArchivePart(title: string): boolean {
  if (!title) return false;
  return JUNK_PATTERN.test(title);
}

export function matchedJunkKind(title: string): string | null {
  const m = title?.match(JUNK_PATTERN);
  if (!m) return null;
  const tok = m[1].toLowerCase();
  if (tok === 'par2') return 'par2';
  if (tok === 'nzb') return 'nzb';
  if (tok === 'rar') return 'rar';
  if (/^r\d+$/.test(tok)) return 'rar';
  if (/^\d+$/.test(tok)) return 'vol';
  return tok;
}

/** Truncate a title for safe logging (avoid leaking long tokens). */
export function safeLogTitle(title: string, max = 100): string {
  if (!title) return '';
  return title.length > max ? title.slice(0, max) + '…' : title;
}

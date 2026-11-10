export interface PullRequestUrlRef {
  owner: string;
  repo: string;
  number: number;
}

// The scheme and `www.` are optional, so a URL copied without them still
// parses. A sub-page (`/files`, `/commits`), a query or a fragment is allowed
// after the number, because a URL copied from the browser often has one.
const PULL_REQUEST_URL =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i;

/**
 * Parse a GitHub pull request URL such as
 * `https://github.com/acme/app/pull/7/files`. Returns `null` for any other
 * text. The owner and repo keep the case of the input.
 */
export function parsePullRequestUrl(text: string): PullRequestUrlRef | null {
  const match = PULL_REQUEST_URL.exec(text.trim());
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { owner: match[1], repo: match[2], number };
}

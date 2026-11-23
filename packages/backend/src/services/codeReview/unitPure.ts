import { codeReviewDedupeKey, type RawCodeReviewFinding } from '@talyn/shared';
import type { ReviewPromptContext } from './lenses.js';

/** The files one chunk is responsible for. */
export function filesForChunk(
  files: ReviewPromptContext['files'],
  chunkIndex: number,
  chunkTotal: number
): ReviewPromptContext['files'] {
  if (chunkTotal <= 1) return files;
  // Round-robin by position rather than by directory, which is the honest v1:
  // directory affinity is the better split and needs measuring before it earns
  // the complexity. Deterministic either way, so a retry reads the same files.
  return files.filter((_, i) => i % chunkTotal === chunkIndex);
}

/**
 * The judge names its keeps by dedupe key, so its output has to be keyed exactly
 * the way the findings were keyed when they were written — same function, same
 * anchor-verification answer, or nothing matches and every candidate is dropped.
 */
/**
 * Which candidate a judge's keep is about, or null when none can be found.
 *
 * The ID first. The judge is handed each candidate's dedupe key as its id and
 * told to send it back, so that is the answer whenever it is present and real.
 *
 * It used to be the ONLY the computed key: file, title and anchor, hashed again
 * from what the judge sent. The judge is never shown the candidate's anchor, so
 * it quotes the code itself, and one changed word in a title or a quote that now
 * verifies gives a different key. Nothing matched, and everything unmatched was
 * marked rejected. On 2026-10-07 a judge kept five of sixteen findings, a
 * blocker among them, and the review recorded "Kept 0, dropped 16".
 *
 * The computed key stays as the fallback for a keep with no usable id, tried
 * with both answers to "was the anchor verified", because that answer is the
 * part most likely to differ from the day the finding was stored.
 */
export function matchJudgeKeep(
  finding: RawCodeReviewFinding,
  candidateKeys: ReadonlySet<string>,
  verified: boolean
): string | null {
  if (finding.id && candidateKeys.has(finding.id)) return finding.id;
  for (const answer of [verified, !verified]) {
    const key = keyFor(finding, answer);
    if (candidateKeys.has(key)) return key;
  }
  return null;
}

export function keyFor(finding: RawCodeReviewFinding, verified: boolean): string {
  return codeReviewDedupeKey({
    filePath: finding.file,
    title: finding.title,
    anchor: finding.anchor,
    anchorVerified: verified,
  });
}

/**
 * Whether a finding's anchor is really in the change it claims to be about.
 *
 * Checked against the patches we already have rather than by fetching file
 * contents, which keeps it free. Two things it catches, and one it does not:
 *
 * - A HALLUCINATED PATH — a file the pull request does not touch at all — reads as
 *   unverified, which is the most common review-agent failure.
 * - A PARAPHRASED ANCHOR, which would otherwise mint a fresh dedupe key on every
 *   cycle and duplicate the finding for ever.
 * - It does NOT verify a finding about unchanged context code, which is real and
 *   simply falls back to the weaker file+title key. Acceptable: that key is stable
 *   too, just coarser.
 */
export function anchorVerifier(
  files: { filename: string; patch?: string }[]
): (finding: RawCodeReviewFinding) => boolean {
  const patches = new Map(files.map((f) => [f.filename, patchBodyText(f.patch ?? '')]));
  return (finding) => {
    const anchor = finding.anchor?.trim();
    if (!anchor) return false;
    const haystack = patches.get(finding.file);
    if (haystack === undefined) return false;
    const needle = anchor.replace(/\s+/g, ' ').trim();
    return needle.length > 0 && haystack.includes(needle);
  };
}

/**
 * A patch as the CODE it represents, not as a diff.
 *
 * This is the whole of the verifier's correctness, and getting it wrong made the
 * check useless in a way that looked like it was working. A unified diff prefixes
 * every line with `+`, `-` or a space, so collapsing the raw patch left those
 * markers sitting between the lines: a needle reading `a b` had to match a
 * haystack reading `+ a + b`. A single-line anchor matched by luck, because the
 * marker fell outside it. Anything spanning two lines — which is most of what an
 * agent quotes, given a 200-character budget — could never match at all.
 *
 * So EVERY finding came back unverified, the app said "location approximate" on
 * all of them, and the signal that was supposed to catch a hallucinated path
 * instead caught everything. Worse, `anchorVerified` gates auto-fix, so that
 * feature could never have fired.
 *
 * Removed lines are dropped rather than included. A finding is about the code as
 * it now stands, and keeping the `-` side would verify an anchor against text the
 * pull request has just deleted.
 */
function patchBodyText(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => !line.startsWith('@@') && !line.startsWith('---') && !line.startsWith('+++'))
    .filter((line) => !line.startsWith('-'))
    .map((line) => (line.startsWith('+') || line.startsWith(' ') ? line.slice(1) : line))
    .join('\n')
    .replace(/\s+/g, ' ');
}


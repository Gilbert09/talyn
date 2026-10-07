import {
  CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES,
  CodeReviewRequestError,
  parseSkillKey,
  type CodeReviewCustomReviewer,
  type CodeReviewCycleReviewer,
} from '@talyn/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { repositories as repositoriesTable, skills as skillsTable } from '../../db/schema.js';
import { parseRepoUrl } from '../repoIdentity.js';
import { getRepoSkillContent, listRepoSkills } from '../skills.js';
import type { ReviewerSkill } from './lenses.js';

/**
 * The team's own reviewers: checking them at save time, loading them at
 * dispatch time.
 *
 * A reviewer is a skill key and a name on the workspace's settings. The skill's
 * text is never stored with it. It is read here, each time a unit is
 * dispatched, through the same skills service every other skill run uses.
 */

/**
 * Check a reviewer list against this workspace, for the settings route.
 *
 * The shape is already valid (`validateCustomReviewers`). This is the part that
 * needs the database: a repo skill must name a repository of THIS workspace, and
 * a Talyn skill must be one this workspace owns. A Talyn skill's name is
 * replaced with the stored one, so a client cannot label a reviewer with text
 * of its own.
 *
 * A repo skill's file is not read here. That is a GitHub call per reviewer on
 * every save, and the answer can change the minute after. A skill that is gone
 * at dispatch fails its own unit and says so.
 */
export async function checkCustomReviewers(
  workspaceId: string,
  reviewers: CodeReviewCustomReviewer[]
): Promise<CodeReviewCustomReviewer[]> {
  if (!reviewers.length) return reviewers;
  const db = getDbClient();

  const parsed = reviewers.map((reviewer) => ({ reviewer, key: parseSkillKey(reviewer.skillKey) }));
  const needsRepos = parsed.some((p) => p.key?.source === 'repo');
  const platformIds = parsed.flatMap((p) => (p.key?.source === 'platform' ? [p.key.id] : []));

  const [repoRows, skillRows] = await Promise.all([
    needsRepos
      ? db
          .select({ url: repositoriesTable.url })
          .from(repositoriesTable)
          .where(eq(repositoriesTable.workspaceId, workspaceId))
      : Promise.resolve([]),
    platformIds.length
      ? db
          .select({
            id: skillsTable.id,
            name: skillsTable.name,
            // The size alone. `skills.content` is the table's big column.
            contentSize: sql<number>`octet_length(${skillsTable.content})`,
          })
          .from(skillsTable)
          .where(and(eq(skillsTable.workspaceId, workspaceId), inArray(skillsTable.id, platformIds)))
      : Promise.resolve([]),
  ]);

  const repos = new Set(
    repoRows.flatMap((row) => {
      const identity = parseRepoUrl(row.url);
      return identity ? [`${identity.owner}/${identity.repo}`.toLowerCase()] : [];
    })
  );
  const skillsById = new Map(skillRows.map((row) => [row.id, row]));

  return parsed.map(({ reviewer, key }) => {
    if (key?.source === 'repo') {
      const full = `${key.owner}/${key.repo}`;
      if (!repos.has(full.toLowerCase())) {
        throw new CodeReviewRequestError(
          `"${key.name}" is a skill in ${full}, which is not a repository of this workspace.`
        );
      }
      return reviewer;
    }
    if (key?.source === 'platform') {
      const skill = skillsById.get(key.id);
      if (!skill) {
        throw new CodeReviewRequestError(
          `The skill "${reviewer.name}" is not saved to this workspace.`
        );
      }
      if (Number(skill.contentSize) > CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES) {
        throw new CodeReviewRequestError(tooLargeMessage(skill.name));
      }
      return { skillKey: reviewer.skillKey, name: skill.name };
    }
    // `validateCustomReviewers` has already refused a local or malformed key.
    throw new CodeReviewRequestError(`"${reviewer.skillKey}" is not a skill Talyn can run as a reviewer.`);
  });
}

export function tooLargeMessage(name: string): string {
  return `The review skill "${name}" is too large to run as a reviewer.`;
}

export type LoadedReviewerSkill =
  | { ok: true; skill: ReviewerSkill }
  | { ok: false; code: 'skill_unavailable' | 'skill_too_large'; message: string };

/**
 * Read one reviewer's skill, for a unit that is about to be dispatched.
 *
 * # Never from the pull request
 *
 * A repo skill is read from the repository's DEFAULT branch. `getRepoSkillContent`
 * passes no ref, and nothing here takes the pull request's head. That is a
 * security rule and not a detail: a pull request that could edit
 * `.claude/skills/review/SKILL.md` on its own branch would be writing the
 * instructions of its own review. The sandbox does check out the pull request,
 * so the prompt never tells the reviewer to read the skill from the checkout.
 *
 * # Never an empty answer
 *
 * Every way of not getting the text is `ok: false`. The caller settles the unit
 * as FAILED. A reviewer whose instructions could not be read has reviewed
 * nothing, and that must not read as "found nothing".
 */
export async function loadReviewerSkill(
  workspaceId: string,
  repositoryId: string,
  reviewer: CodeReviewCycleReviewer
): Promise<LoadedReviewerSkill> {
  const unavailable = (why: string): LoadedReviewerSkill => ({
    ok: false,
    code: 'skill_unavailable',
    message: `The review skill "${reviewer.name}" could not be loaded: ${why}.`,
  });
  const key = parseSkillKey(reviewer.skillKey);

  try {
    if (key?.source === 'platform') {
      const rows = await getDbClient()
        .select({ name: skillsTable.name, content: skillsTable.content })
        .from(skillsTable)
        .where(and(eq(skillsTable.id, key.id), eq(skillsTable.workspaceId, workspaceId)))
        .limit(1);
      const row = rows[0];
      if (!row) return unavailable('it is no longer saved to this workspace');
      return sized({ name: row.name, content: row.content });
    }

    if (key?.source === 'repo') {
      const found = await getRepoSkillContent(workspaceId, repositoryId, key.name);
      if (!found) {
        // Null is also what a failed discovery returns, and "GitHub did not
        // answer" is a different thing to tell somebody than "the skill is gone".
        const listed = await listRepoSkills(workspaceId, repositoryId);
        if (listed.status === 'error') {
          return unavailable(`GitHub did not return the repository's skills (${listed.error ?? 'unknown error'})`);
        }
        return unavailable(`${key.owner}/${key.repo} has no skill with that name on its default branch`);
      }
      // Null content is a file over SKILL_MAX_BYTES, which the skills service
      // lists and does not read.
      if (found.content === null) {
        return { ok: false, code: 'skill_too_large', message: tooLargeMessage(reviewer.name) };
      }
      return sized({ name: found.name, content: found.content });
    }
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : String(err));
  }

  return unavailable('its key is not one Talyn can read');
}

function sized(skill: ReviewerSkill): LoadedReviewerSkill {
  if (!skill.content.trim()) {
    return {
      ok: false,
      code: 'skill_unavailable',
      message: `The review skill "${skill.name}" could not be loaded: the file is empty.`,
    };
  }
  if (Buffer.byteLength(skill.content, 'utf8') > CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES) {
    return { ok: false, code: 'skill_too_large', message: tooLargeMessage(skill.name) };
  }
  return { ok: true, skill };
}

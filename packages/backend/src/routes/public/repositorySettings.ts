import type { PutRepositoryInstructionsInput, RepositoryInstructionAgents } from '@talyn/shared';
import {
  PutRepositoryInstructionsBody,
  RepositoryInstructions,
  RepositorySettings,
  SetupRecipe,
  SetupStepParams,
  UpdateRepositorySettingsBody,
} from '../../schemas/public/repositorySettings.js';
import { IdParams, Repository } from '../../schemas/public/resources.js';
import { mergePreview, previewResponse, validatePreviewChoice } from '../../services/preview/repoPreview.js';
import { invalid, notFound } from '../../services/public/errors.js';
import { toPublicRepository } from '../../services/public/projections.js';
import {
  toPublicRepositoryInstructions,
  toPublicRepositorySettings,
  toPublicSetupRecipe,
} from '../../services/public/workProjections.js';
import { authorizedRepository } from '../../services/public/workQueries.js';
import {
  getRepositoryInstructions,
  putRepositoryInstructions,
  removeRepositoryInstructions,
} from '../../services/workbenches/repositoryInstructions.js';
import {
  getSizeRepository,
  mergeSandboxSize,
  sandboxSizeResponse,
  validateSandboxSizeChoice,
} from '../../services/workbenches/sandboxSize.js';
import { getSetupRecipe, learningDisabled, revertSetupStep, setSetupLearning } from '../../services/workbenches/setupLayers.js';
import { definePublicRoute, type PublicRoute } from './define.js';

/**
 * The stored settings, read once. No detection runs here: detection reads
 * GitHub, and a settings read must not spend the caller's GitHub rate limit.
 */
async function repositorySettings(id: string) {
  const row = await getSizeRepository(id);
  if (!row) throw notFound('repository');
  return toPublicRepositorySettings(id, sandboxSizeResponse(row), previewResponse(row), await learningDisabled(id));
}

/** A service validator's `Error` as a 400 on the field it is about. */
function validated<T>(param: string, check: () => T): T {
  try {
    return check();
  } catch (err) {
    throw invalid(err instanceof Error ? err.message : 'Not valid.', param);
  }
}

/**
 * Per-repository settings for sessions. The same settings as the repository
 * page in the app. Session settings need sessions to be on for the account,
 * like the app's routes.
 */
export const repositorySettingsRoutes: PublicRoute[] = [
  definePublicRoute({
    method: 'get',
    path: '/repositories/{id}',
    operationId: 'getRepository',
    summary: 'Get a repository',
    tag: 'Repositories',
    scope: 'repositories:read',
    params: IdParams,
    responses: { 200: { description: 'The repository.', schema: Repository } },
    async handler({ params, token }) {
      return { status: 200, body: toPublicRepository(await authorizedRepository(token, params.id)) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/repositories/{id}/settings',
    operationId: 'getRepositorySettings',
    summary: 'Get repository settings',
    description:
      'The sandbox size, the preview and setup learning for new sessions on the repository. ' +
      'The detected values are what Talyn last read from the repository; this request does not read GitHub.',
    tag: 'Repositories',
    scope: 'repositories:read',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The settings.', schema: RepositorySettings } },
    async handler({ params, token }) {
      const repo = await authorizedRepository(token, params.id);
      return { status: 200, body: await repositorySettings(repo.id) };
    },
  }),

  definePublicRoute({
    method: 'patch',
    path: '/repositories/{id}/settings',
    operationId: 'updateRepositorySettings',
    summary: 'Update repository settings',
    description:
      'Send only the fields to change. `sandbox_size: "auto"` goes back to the detected size. ' +
      'Inside `preview`, each field you send replaces your choice for that field.',
    tag: 'Repositories',
    scope: 'repositories:write',
    sessions: true,
    params: IdParams,
    body: UpdateRepositorySettingsBody,
    responses: { 200: { description: 'The settings.', schema: RepositorySettings } },
    async handler({ params, body, token }) {
      const repo = await authorizedRepository(token, params.id);
      // Check everything before writing anything, so a refusal changes nothing.
      const size = body.sandbox_size !== undefined
        ? validated('sandbox_size', () => validateSandboxSizeChoice({ sandboxSize: body.sandbox_size }))
        : undefined;
      const preview = body.preview !== undefined ? validated('preview', () => validatePreviewChoice(body.preview)) : undefined;
      if (size !== undefined) await mergeSandboxSize(repo.id, { sandboxSize: size });
      if (preview !== undefined) await mergePreview(repo.id, preview);
      if (body.setup_learning !== undefined) await setSetupLearning(repo.id, !body.setup_learning);
      return { status: 200, body: await repositorySettings(repo.id) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/repositories/{id}/instructions',
    operationId: 'getRepositoryInstructions',
    summary: 'Get repository instructions',
    description:
      'The instructions written in Talyn for the repository. Every turn of every session on the repository gets them. ' +
      'No instructions answers 404 `repository_instructions_not_found`.',
    tag: 'Repositories',
    scope: 'repositories:read',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The instructions.', schema: RepositoryInstructions } },
    async handler({ params, token }) {
      const repo = await authorizedRepository(token, params.id);
      const found = await getRepositoryInstructions(repo.id);
      if (!found) throw notFound('repository_instructions');
      return { status: 200, body: toPublicRepositoryInstructions(found) };
    },
  }),

  definePublicRoute({
    method: 'put',
    path: '/repositories/{id}/instructions',
    operationId: 'putRepositoryInstructions',
    summary: 'Write repository instructions',
    description: 'Replaces the instructions. The next turn of each session gets the new text. At most 64 KiB.',
    tag: 'Repositories',
    scope: 'repositories:write',
    sessions: true,
    params: IdParams,
    body: PutRepositoryInstructionsBody,
    responses: { 200: { description: 'The instructions.', schema: RepositoryInstructions } },
    async handler({ params, body, token }) {
      const repo = await authorizedRepository(token, params.id);
      const input: PutRepositoryInstructionsInput = { body: body.body, agents: body.agents as RepositoryInstructionAgents };
      return { status: 200, body: toPublicRepositoryInstructions(await putRepositoryInstructions(repo.id, input)) };
    },
  }),

  definePublicRoute({
    method: 'delete',
    path: '/repositories/{id}/instructions',
    operationId: 'deleteRepositoryInstructions',
    summary: 'Delete repository instructions',
    description: 'The next turn of each session takes the instructions out of its sandbox. Deleting twice changes nothing.',
    tag: 'Repositories',
    scope: 'repositories:write',
    sessions: true,
    params: IdParams,
    responses: { 204: { description: 'Deleted.' } },
    async handler({ params, token }) {
      const repo = await authorizedRepository(token, params.id);
      await removeRepositoryInstructions(repo.id);
      return { status: 204 };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/repositories/{id}/setup_recipe',
    operationId: 'getSetupRecipe',
    summary: 'Get the setup recipe',
    description: 'The setup steps Talyn learned from sessions on the repository. New sandboxes run them.',
    tag: 'Repositories',
    scope: 'repositories:read',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The recipe.', schema: SetupRecipe } },
    async handler({ params, token }) {
      const repo = await authorizedRepository(token, params.id);
      return { status: 200, body: toPublicSetupRecipe(await getSetupRecipe(repo.id)) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/repositories/{id}/setup_recipe/steps/{step_id}/revert',
    operationId: 'revertSetupStep',
    summary: 'Revert a setup step',
    description: 'New sandboxes stop running the step. It stays in the list as reverted, so Talyn does not learn it again.',
    tag: 'Repositories',
    scope: 'repositories:write',
    sessions: true,
    params: SetupStepParams,
    responses: { 200: { description: 'The recipe.', schema: SetupRecipe } },
    async handler({ params, token }) {
      const repo = await authorizedRepository(token, params.id);
      if (!(await revertSetupStep(repo.id, params.step_id))) throw notFound('setup_step');
      return { status: 200, body: toPublicSetupRecipe(await getSetupRecipe(repo.id)) };
    },
  }),
];

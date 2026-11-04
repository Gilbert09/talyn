import type {
  PutRepositoryInstructionsInput,
  PutRepositorySetupInput,
  PutWorkspaceSandboxSetupInput,
  RepositoryInstructionAgents,
  SetupListStep,
  SetupListStepInput,
} from '@talyn/shared';
import {
  PutRepositoryInstructionsBody,
  PutRepositorySetupBody,
  PutWorkspaceSandboxSetupBody,
  RepositoryInstructions,
  RepositorySettings,
  RepositorySetup,
  SetupRecipe,
  SetupStepParams,
  UpdateRepositorySettingsBody,
  WorkspaceSandboxSetup,
} from '../../schemas/public/repositorySettings.js';
import { IdParams, Repository } from '../../schemas/public/resources.js';
import { mergePreview, previewResponse, validatePreviewChoice } from '../../services/preview/repoPreview.js';
import { authorizeWorkspace } from '../../services/public/authorize.js';
import { invalid, notFound, PublicApiError } from '../../services/public/errors.js';
import { toPublicRepository } from '../../services/public/projections.js';
import {
  toPublicRepositoryInstructions,
  toPublicRepositorySettings,
  toPublicRepositorySetup,
  toPublicSetupRecipe,
  toPublicWorkspaceSandboxSetup,
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
import {
  acceptSetupStep,
  dismissSetupStep,
  getRepositorySetup,
  getSetupRecipe,
  getWorkspaceSandboxSetup,
  learningDisabled,
  putRepositorySetup,
  putWorkspaceSandboxSetup,
  retrySetupStep,
  revertSetupStep,
  setSetupLearning,
  SetupListError,
} from '../../services/workbenches/setupLayers.js';
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

/** A refusal of the Setup list as a public error, with the same code the app gets. */
async function setupList<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SetupListError) throw new PublicApiError(err.status, err.code, err.message);
    throw err;
  }
}

type StepInputBody = { id?: string; name: string; command?: string; run_on: SetupListStepInput['runOn']; timeout_sec?: number | null };

const stepInputs = (steps: StepInputBody[] | undefined): SetupListStepInput[] | undefined =>
  steps?.map((s) => ({
    ...(s.id !== undefined ? { id: s.id } : {}),
    name: s.name,
    ...(s.command !== undefined ? { command: s.command } : {}),
    runOn: s.run_on,
    ...(s.timeout_sec !== undefined ? { timeoutSec: s.timeout_sec } : {}),
  }));

async function repositorySetup(id: string) {
  const setup = await getRepositorySetup(id);
  if (!setup) throw notFound('repository');
  return toPublicRepositorySetup(setup);
}

async function workspaceSandboxSetup(id: string) {
  const setup = await getWorkspaceSandboxSetup(id);
  if (!setup) throw notFound('workspace');
  return toPublicWorkspaceSandboxSetup(setup);
}

const STEP_ACTIONS: Array<{
  action: 'accept' | 'dismiss' | 'retry';
  operationId: string;
  summary: string;
  description: string;
  run: (repositoryId: string, stepId: string) => Promise<SetupListStep | null>;
}> = [
  {
    action: 'accept',
    operationId: 'acceptSetupListStep',
    summary: 'Accept a setup step',
    description:
      'Accept a suggested or dismissed learned step. It runs on new sandboxes, and an image step goes into the image. ' +
      'Talyn never removes a step that a person accepted.',
    run: (repositoryId, stepId) => acceptSetupStep(repositoryId, stepId),
  },
  {
    action: 'dismiss',
    operationId: 'dismissSetupListStep',
    summary: 'Dismiss a setup step',
    description:
      'Dismiss a learned step. It stops running and stays in the list as dismissed, so Talyn does not suggest it again. ' +
      'Your own step cannot be dismissed (409 `not_learned`): remove it from the list instead.',
    run: (repositoryId, stepId) => dismissSetupStep(repositoryId, stepId),
  },
  {
    action: 'retry',
    operationId: 'retrySetupListStep',
    summary: 'Retry a setup step',
    description: 'Run a disabled step again, or put a step that failed in the image build back into the image. The failure count goes back to 0.',
    run: (repositoryId, stepId) => retrySetupStep({ repositoryId }, stepId),
  },
];

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
    path: '/repositories/{id}/setup',
    operationId: 'getRepositorySetup',
    summary: 'Get the Setup list',
    description:
      "The repository's own setup, then one ordered list of setup steps. Image steps go into the repository's image. " +
      'Box steps run on each new sandbox. Learned steps are suggested until a person or the frequency rule accepts them.',
    tag: 'Repositories',
    scope: 'repositories:read',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The Setup list.', schema: RepositorySetup } },
    async handler({ params, token }) {
      const repo = await authorizedRepository(token, params.id);
      return { status: 200, body: await repositorySetup(repo.id) };
    },
  }),

  definePublicRoute({
    method: 'put',
    path: '/repositories/{id}/setup',
    operationId: 'putRepositorySetup',
    summary: 'Write the Setup list',
    description:
      'Send only the fields to change. `steps` is the whole list in its new order. ' +
      'A step that reads a secret runs only on the box. A command that holds a literal token is refused (`setup_step_refused`). ' +
      'The command of a learned step cannot change (`learned_command`). A refusal changes nothing.',
    tag: 'Repositories',
    scope: 'repositories:write',
    sessions: true,
    params: IdParams,
    body: PutRepositorySetupBody,
    responses: { 200: { description: 'The Setup list.', schema: RepositorySetup } },
    async handler({ params, body, token }) {
      const repo = await authorizedRepository(token, params.id);
      const input: PutRepositorySetupInput = {
        ...(body.steps !== undefined ? { steps: stepInputs(body.steps) } : {}),
        ...(body.run_on_box !== undefined ? { runOnBox: body.run_on_box } : {}),
        ...(body.hosts !== undefined ? { hosts: body.hosts } : {}),
        ...(body.learning !== undefined ? { learningDisabled: !body.learning } : {}),
      };
      const setup = await setupList(() => putRepositorySetup(repo.id, input));
      if (!setup) throw notFound('repository');
      return { status: 200, body: toPublicRepositorySetup(setup) };
    },
  }),

  ...STEP_ACTIONS.map(({ action, operationId, summary, description, run }) =>
    definePublicRoute({
      method: 'post',
      path: `/repositories/{id}/setup/steps/{step_id}/${action}`,
      operationId,
      summary,
      description,
      tag: 'Repositories',
      scope: 'repositories:write',
      sessions: true,
      params: SetupStepParams,
      responses: { 200: { description: 'The Setup list.', schema: RepositorySetup } },
      async handler({ params, token }) {
        const repo = await authorizedRepository(token, params.id);
        if (!(await setupList(() => run(repo.id, params.step_id)))) throw notFound('setup_step');
        return { status: 200, body: await repositorySetup(repo.id) };
      },
    }),
  ),

  definePublicRoute({
    method: 'get',
    path: '/workspaces/{id}/sandbox_setup',
    operationId: 'getWorkspaceSandboxSetup',
    summary: 'Get the sandbox setup',
    description:
      "The workspace's dotfiles and setup steps. They go into the image of every repository of the workspace, before the repository's own steps.",
    tag: 'Workspaces',
    scope: 'repositories:read',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The sandbox setup.', schema: WorkspaceSandboxSetup } },
    async handler({ params, token }) {
      await authorizeWorkspace(token, params.id);
      return { status: 200, body: await workspaceSandboxSetup(params.id) };
    },
  }),

  definePublicRoute({
    method: 'put',
    path: '/workspaces/{id}/sandbox_setup',
    operationId: 'putWorkspaceSandboxSetup',
    summary: 'Write the sandbox setup',
    description:
      'Each field you send replaces it. It changes the sandboxes of every repository of the workspace, so it needs `repositories:write`. ' +
      'The dotfiles install command cannot read a secret: the image build has no secrets.',
    tag: 'Workspaces',
    scope: 'repositories:write',
    sessions: true,
    params: IdParams,
    body: PutWorkspaceSandboxSetupBody,
    responses: { 200: { description: 'The sandbox setup.', schema: WorkspaceSandboxSetup } },
    async handler({ params, body, token }) {
      await authorizeWorkspace(token, params.id);
      const input: PutWorkspaceSandboxSetupInput = {
        ...(body.dotfiles !== undefined
          ? { dotfiles: body.dotfiles === null ? null : { slug: body.dotfiles.slug, ref: body.dotfiles.ref ?? '', install: body.dotfiles.install ?? null } }
          : {}),
        ...(body.hosts !== undefined ? { hosts: body.hosts } : {}),
        ...(body.steps !== undefined ? { steps: stepInputs(body.steps) } : {}),
      };
      const setup = await setupList(() => putWorkspaceSandboxSetup(params.id, input));
      if (!setup) throw notFound('workspace');
      return { status: 200, body: toPublicWorkspaceSandboxSetup(setup) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/workspaces/{id}/sandbox_setup/steps/{step_id}/retry',
    operationId: 'retryWorkspaceSetupStep',
    summary: 'Retry a sandbox setup step',
    description: 'Run a disabled workspace step again, or put a step that failed in the image build back into the image.',
    tag: 'Workspaces',
    scope: 'repositories:write',
    sessions: true,
    params: SetupStepParams,
    responses: { 200: { description: 'The sandbox setup.', schema: WorkspaceSandboxSetup } },
    async handler({ params, token }) {
      await authorizeWorkspace(token, params.id);
      if (!(await retrySetupStep({ workspaceId: params.id }, params.step_id))) throw notFound('setup_step');
      return { status: 200, body: await workspaceSandboxSetup(params.id) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/repositories/{id}/setup_recipe',
    operationId: 'getSetupRecipe',
    summary: 'Get the setup recipe',
    description:
      'Deprecated: use `GET /repositories/{id}/setup`. This route goes after one release. ' +
      'The setup steps Talyn learned from sessions on the repository, in the old shape.',
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
    description:
      'Deprecated: use `POST /repositories/{id}/setup/steps/{step_id}/dismiss`. This route goes after one release. ' +
      'It dismisses the step. The step stays in the list as reverted, so Talyn does not learn it again.',
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

import type { ListSkillsResponse, PlatformSkill, UpdatePlatformSkillRequest } from '@talyn/shared';
import { callApi } from '../api.js';
import {
  defineTool,
  linesOrNone,
  requireId,
  resolveWorkspace,
  str,
  textSchema,
  workspaceSchema,
} from './helpers.js';

function contentArg(args: Record<string, unknown>): string {
  requireId(args, 'content');
  return args.content as string;
}

const contentSchema = { name: textSchema, description: textSchema, content: textSchema };
const skillLine = (skill: PlatformSkill) => `${skill.id}  ${skill.name}  ${skill.description}`;

export const SKILLS = [
  defineTool(
    'list_skills',
    'List platform skills and optional repository skills, with their ids and sources.',
    { ...workspaceSchema, repository_id: textSchema },
    [],
    { readOnlyHint: true, openWorldHint: true },
    async (ownerId, args) => {
      const params = new URLSearchParams({ workspaceId: await resolveWorkspace(ownerId, args) });
      if (str(args.repository_id)) params.set('repositoryId', str(args.repository_id)!);
      const data = await callApi<ListSkillsResponse>(ownerId, 'GET', `/skills?${params}`);
      return [
        linesOrNone(
          [...data.platform, ...data.repo],
          (skill) =>
            `${skill.id ?? skill.key}  ${skill.name}  [${skill.source}]  ${skill.description}  key: ${skill.key}`
        ),
        ...(data.repoError ? [`repository skills: ${data.repoError}`] : []),
      ].join('\n');
    }
  ),
  defineTool(
    'get_skill',
    'Get a platform skill by skill_id, or a repository skill by repository_id and name.',
    { ...workspaceSchema, skill_id: textSchema, repository_id: textSchema, name: textSchema },
    [],
    { readOnlyHint: true, openWorldHint: true },
    async (ownerId, args) => {
      if (str(args.skill_id)) {
        const skill = await callApi<PlatformSkill>(
          ownerId,
          'GET',
          `/skills/${requireId(args, 'skill_id')}`
        );
        return `${skillLine(skill)}\n${skill.content}`;
      }
      const params = new URLSearchParams({
        workspaceId: await resolveWorkspace(ownerId, args),
        repositoryId: requireId(args, 'repository_id'),
        name: requireId(args, 'name'),
      });
      const skill = await callApi<{ content: string; repoPath: string }>(
        ownerId,
        'GET',
        `/skills/repo/content?${params}`
      );
      return `${skill.repoPath}\n${skill.content}`;
    }
  ),
  defineTool(
    'create_skill',
    'Create a platform skill from its name, description, and content.',
    { ...workspaceSchema, ...contentSchema },
    ['name', 'content'],
    {},
    async (ownerId, args) =>
      skillLine(
        await callApi<PlatformSkill>(ownerId, 'POST', '/skills', {
          workspaceId: await resolveWorkspace(ownerId, args),
          name: requireId(args, 'name'),
          description: str(args.description) ?? '',
          content: contentArg(args),
        })
      )
  ),
  defineTool(
    'update_skill',
    'Update the supplied fields of a platform skill.',
    { skill_id: textSchema, ...contentSchema },
    ['skill_id'],
    { idempotentHint: true },
    async (ownerId, args) => {
      const body: UpdatePlatformSkillRequest = {};
      for (const key of ['name', 'description', 'content'] as const) {
        if (args[key] !== undefined) {
          if (typeof args[key] !== 'string') throw new Error(`${key} must be text`);
          body[key] = args[key];
        }
      }
      return skillLine(
        await callApi<PlatformSkill>(
          ownerId,
          'PATCH',
          `/skills/${requireId(args, 'skill_id')}`,
          body
        )
      );
    }
  ),
  defineTool(
    'delete_skill',
    'Delete a platform skill.',
    { skill_id: textSchema },
    ['skill_id'],
    { destructiveHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'skill_id');
      await callApi(ownerId, 'DELETE', `/skills/${id}`);
      return `${id} deleted.`;
    }
  ),
];

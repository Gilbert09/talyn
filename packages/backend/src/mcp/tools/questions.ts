import { ASK_USER_TOOL, askUserToolResult, normaliseQuestions, QUESTION_LIMITS } from '@talyn/shared';
import { askPerson } from '../../services/workbenches/questions.js';
import type { McpToolDefinition } from './index.js';

/**
 * The agent's question to the person. Only for a session's own token
 * (`SESSION_ONLY_TOOLS`): the question goes in the calling session's
 * transcript, and the turn ends waiting for the answer.
 */
export const QUESTIONS: McpToolDefinition[] = [
  {
    name: ASK_USER_TOOL,
    description:
      'Ask the person one or more questions, then end your turn. Use it instead of AskUserQuestion, which does not work here. ' +
      'Talyn shows the questions with their options in the session, notifies the person, and, when this session belongs ' +
      "to a thread, wakes the thread, which can answer for the person. The answer arrives as your next message. " +
      'Ask only when you cannot continue without a decision. For a small choice, pick the reasonable option and say so.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: QUESTION_LIMITS.questions,
          description: `1 to ${QUESTION_LIMITS.questions} questions.`,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The complete question, ending with a question mark.' },
              header: { type: 'string', description: `A short tag of ${QUESTION_LIMITS.headerChars} characters or fewer, such as "Database".` },
              options: {
                type: 'array',
                maxItems: QUESTION_LIMITS.options,
                description: `0 or 2 to ${QUESTION_LIMITS.options} choices. The person can always answer in their own words. Leave out "Other".`,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'The choice, in a few words.' },
                    description: { type: 'string', description: 'What the choice means, or its trade-off.' },
                  },
                  required: ['label'],
                },
              },
              multi_select: { type: 'boolean', description: 'The person may pick more than one option. Default false.' },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
    annotations: { title: 'Ask the person', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    feature: 'workbenches',
    handler: async (_ownerId, args, ctx) => {
      if (!ctx?.session) throw new Error('Only an agent in a Talyn session can ask the person.');
      const parsed = normaliseQuestions(args.questions);
      if (!parsed.ok) throw new Error(parsed.error);
      const { workbench } = await askPerson(ctx.session.workbenchId, parsed.questions);
      return askUserToolResult({ inThread: Boolean(workbench.threadId) });
    },
  },
];

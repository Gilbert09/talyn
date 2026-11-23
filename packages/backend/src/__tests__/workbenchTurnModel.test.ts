import { describe, expect, it } from 'vitest';
import { turnModelFor } from '../services/workbenches/turns.js';

describe('turnModelFor', () => {
  const claudeSession = { agent: 'claude', model: 'claude-opus-5-5' };
  const codexSession = { agent: 'codex', model: 'gpt-5.6-sol' };

  it.each([
    ['the message model first', { model: 'gpt-6-luna' }, { agent: 'codex', model: 'gpt-6.1-terra' }, codexSession, 'gpt-6-luna'],
    ['the chat model next', {}, { agent: 'codex', model: 'gpt-6.1-terra' }, codexSession, 'gpt-6.1-terra'],
    ['the session model for a chat on its agent', {}, { agent: 'claude', model: null }, claudeSession, 'claude-opus-5-5'],
    ['no session model for a chat on another agent', {}, { agent: 'codex', model: null }, claudeSession, undefined],
    ['a retired message model, replaced', { model: 'gpt-5.6-terra' }, { agent: 'codex', model: null }, codexSession, 'gpt-6.1-terra'],
    ['a retired chat model, replaced', {}, { agent: 'codex', model: 'gpt-5.6-sol' }, codexSession, 'gpt-6.1-sol'],
    ['a retired session model, replaced', {}, { agent: 'codex', model: null }, codexSession, 'gpt-6.1-sol'],
    ['an unknown model, unchanged', {}, { agent: 'codex', model: 'gpt-custom' }, codexSession, 'gpt-custom'],
  ])('picks %s', (_name, message, chat, wb, expected) => {
    expect(turnModelFor(message, chat, wb)).toBe(expected);
  });
});

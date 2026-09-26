import { LLMock } from '@copilotkit/aimock/jest';
import { describe, expect, it } from 'vitest';
import { completeProviderTurn } from '../../src/providers/openai-compatible';
import { createModel, createProvider, createSearchTool } from '../helpers/factories';

/**
 * Contract tests against a real local OpenAI-compatible server (aimock). These
 * validate wire-level behaviour without hand-written MSW handlers.
 */
describe('aimock local LLM server', () => {
  it('returns plain text responses', async () => {
    const mock = new LLMock({ port: 0, logLevel: 'silent' });
    mock.onMessage('aimock hello', { content: 'Hello from aimock.' });
    await mock.start();
    try {
      const turn = await completeProviderTurn({
        provider: createProvider({ baseUrl: `${mock.url}/v1` }),
        model: createModel(),
        messages: [{ role: 'user', content: 'aimock hello' }],
        generationParams: { temperature: null },
        signal: new AbortController().signal
      });

      expect(turn.content).toBe('Hello from aimock.');
      expect(mock.getRequests().length).toBe(1);
    } finally {
      await mock.stop();
    }
  });

  it('returns structured tool calls', async () => {
    const mock = new LLMock({ port: 0, logLevel: 'silent' });
    mock.onToolCall('web_search', {
      toolCalls: [
        {
          id: 'aimock_tool_call',
          name: 'web_search',
          arguments: JSON.stringify({ query: 'aimock weather' })
        }
      ]
    });
    await mock.start();
    try {
      const turn = await completeProviderTurn({
        provider: createProvider({ baseUrl: `${mock.url}/v1` }),
        model: createModel(),
        messages: [{ role: 'user', content: 'use a tool' }],
        generationParams: { temperature: null },
        signal: new AbortController().signal,
        tools: [createSearchTool()],
        toolChoice: 'auto'
      });

      expect(turn.toolCalls).toEqual([
        { id: 'aimock_tool_call', name: 'web_search', arguments: JSON.stringify({ query: 'aimock weather' }) }
      ]);
      expect(mock.getLastRequest()?.path).toBe('/v1/chat/completions');
      expect(mock.getLastRequest()?.body?.model).toBe('test-model');
    } finally {
      await mock.stop();
    }
  });
});

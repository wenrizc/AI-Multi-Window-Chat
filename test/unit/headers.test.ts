import { describe, expect, it } from 'vitest';
import { createHeaders } from '../../src/providers/openai-compatible';
import { createProvider } from '../helpers/factories';

describe('createHeaders', () => {
  it('sends a Bearer token for the default auth mode', () => {
    const headers = createHeaders(createProvider({ apiKey: 'secret' }));

    expect(headers.Authorization).toBe('Bearer secret');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('omits the Authorization header when the auth mode is none', () => {
    const headers = createHeaders(createProvider({ apiKey: 'secret', authMode: 'none' }));

    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('does not send an empty Bearer token', () => {
    const headers = createHeaders(createProvider({ apiKey: '   ' }));

    expect(headers.Authorization).toBeUndefined();
  });

  it('lets custom headers override the automatic Authorization header', () => {
    const headers = createHeaders(createProvider({
      apiKey: 'secret',
      headers: { Authorization: 'ApiKey custom-value' }
    }));

    expect(headers.Authorization).toBe('ApiKey custom-value');
  });

  it('keeps custom headers under the custom auth mode', () => {
    const headers = createHeaders(createProvider({
      apiKey: 'secret',
      authMode: 'custom',
      headers: { 'X-Api-Key': 'k', Authorization: 'Token t' }
    }));

    expect(headers.Authorization).toBe('Token t');
    expect(headers['X-Api-Key']).toBe('k');
  });

  it('drops invalid and blank header names', () => {
    const headers = createHeaders(createProvider({
      headers: {
        'Bad Name': 'nope',
        '': 'empty',
        'X-Good': 'yes'
      }
    }));

    expect(headers['Bad Name']).toBeUndefined();
    expect(headers['X-Good']).toBe('yes');
    expect(Object.values(headers)).not.toContain('nope');
    expect(Object.values(headers)).not.toContain('empty');
  });
});

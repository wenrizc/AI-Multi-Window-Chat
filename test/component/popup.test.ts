import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import popupHtml from '../../popup.html?raw';
import { STORAGE_KEY } from '../../src/shared/constants';
import type { RootStore } from '../../src/shared/types';
import { getChromeState } from '../helpers/chrome-mock';
import {
  createChatSession,
  createPersistedMessage,
  createPrompt,
  createProvider,
  createRootStore
} from '../helpers/factories';
import { bootModule, mountExtensionHtml, resetDocument, waitFor } from '../helpers/dom';

const state = getChromeState();

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setValue(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function bootPopup(overrides: Partial<RootStore> = {}): Promise<void> {
  resetDocument();
  mountExtensionHtml(popupHtml);
  state.seedStorage({ [STORAGE_KEY]: createRootStore(overrides) });
  await bootModule('../../src/popup/index.ts');
  await waitFor(
    () =>
      document.querySelector('#profileList .profile-item') ||
      document.getElementById('onboardingModal')?.classList.contains('show')
  );
}

function storedStore(): RootStore {
  return state.storage[STORAGE_KEY] as RootStore;
}

beforeAll(async () => {
  try {
    await page.viewport(1200, 1400);
  } catch {
    // Viewport control is optional; tests still run in the default viewport.
  }
});

beforeEach(() => {
  state.resetListeners();
});

describe('popup providers', () => {
  it('renders providers and marks the default one', async () => {
    await bootPopup({
      providers: [
        createProvider({ id: 'p1', name: 'Alpha' }),
        createProvider({ id: 'p2', name: 'Beta' })
      ],
      featureSettings: { ...createRootStore().featureSettings, defaultProviderId: 'p2' }
    });
    await waitFor(() => document.querySelectorAll('#profileList .profile-item').length === 2);

    const items = [...document.querySelectorAll<HTMLElement>('#profileList .profile-item')];
    expect(items.map((item) => item.querySelector('.profile-name')?.textContent)).toEqual(['Alpha', 'Beta']);
    const beta = items.find((item) => item.dataset.id === 'p2');
    expect(beta?.classList.contains('current')).toBe(true);
    expect(beta?.classList.contains('active')).toBe(true);
    expect(el<HTMLSelectElement>('activeProfileSelect').value).toBe('p2');
    expect(el('footer').textContent).toContain('2.0.0');
  });

  it('creates a new provider through the New button', async () => {
    await bootPopup({
      providers: [createProvider({ id: 'p1', name: 'Alpha' })],
      featureSettings: { ...createRootStore().featureSettings, defaultProviderId: 'p1' }
    });
    await waitFor(() => document.querySelectorAll('#profileList .profile-item').length === 1);

    await userEvent.click(el<HTMLButtonElement>('addProfileBtn'));
    await waitFor(() => storedStore().providers.length === 2);

    expect(document.querySelectorAll('#profileList .profile-item').length).toBe(2);
    expect(storedStore().providers[0].name).toBe('Profile 2');
  });

  it('saves provider edits to storage', async () => {
    await bootPopup({
      providers: [createProvider({ id: 'p1', name: 'Alpha' })],
      featureSettings: { ...createRootStore().featureSettings, defaultProviderId: 'p1' }
    });
    await waitFor(() => document.querySelectorAll('#profileList .profile-item').length === 1);

    setValue(el<HTMLInputElement>('profileName'), 'Renamed');
    setValue(el<HTMLInputElement>('apiUrl'), 'https://example.test/v1');
    setValue(el<HTMLInputElement>('apiKey'), 'secret-key');
    setValue(el<HTMLInputElement>('modelName'), 'gpt-x');
    setValue(el<HTMLSelectElement>('transportSelect'), 'responses');
    setValue(el<HTMLSelectElement>('reasoningFormatSelect'), 'reasoning_content');
    el<HTMLInputElement>('supportsStreamingCheckbox').checked = false;
    setValue(el<HTMLInputElement>('temperatureInput'), '0.5');

    await userEvent.click(el<HTMLButtonElement>('saveBtn'));
    await waitFor(() => storedStore().providers[0]?.name === 'Renamed');

    const provider = storedStore().providers[0];
    expect(provider.baseUrl).toBe('https://example.test/v1');
    expect(provider.apiKey).toBe('secret-key');
    expect(provider.transport).toBe('responses');
    expect(provider.defaultModel).toBe('gpt-x');
    expect(provider.modelCatalog[0].reasoningFormat).toBe('reasoning_content');
    expect(provider.modelCatalog[0].supportsStreaming).toBe(false);
    expect(provider.defaultGenerationParams.temperature).toBe(0.5);
  });
});

describe('popup onboarding', () => {
  it('shows onboarding with the OpenAI preset and lets the user switch presets', async () => {
    await bootPopup();
    await waitFor(() => document.getElementById('onboardingModal')?.classList.contains('show'));

    expect(el<HTMLInputElement>('onboardingModelName').value).toBe('gpt-5');
    expect(el<HTMLInputElement>('profileName').value).toBe('OpenAI');

    await userEvent.click(document.querySelector('[data-onboarding-preset="deepseek"]') as HTMLElement);
    expect(el<HTMLInputElement>('onboardingModelName').value).toBe('deepseek-chat');
    expect(el<HTMLInputElement>('profileName').value).toBe('DeepSeek');
    expect(el<HTMLInputElement>('apiUrl').value).toBe('https://api.deepseek.com');

    await userEvent.click(el<HTMLButtonElement>('onboardingSkipBtn'));
    expect(document.getElementById('onboardingModal')?.classList.contains('show')).toBe(false);
  });
});

describe('popup connection testing', () => {
  it('shows a success status when the provider test succeeds', async () => {
    await bootPopup({
      providers: [createProvider({ id: 'p1', name: 'Alpha' })],
      featureSettings: { ...createRootStore().featureSettings, defaultProviderId: 'p1' }
    });
    await waitFor(() => document.querySelectorAll('#profileList .profile-item').length === 1);

    state.setRuntimeMessageHandler((message) => {
      expect((message as { type: string }).type).toBe('TEST_PROVIDER');
      return { success: true };
    });

    await userEvent.click(el<HTMLButtonElement>('testBtn'));
    await waitFor(() => el('status').textContent === 'Connection OK');
    expect(el('status').classList.contains('success')).toBe(true);
  });

  it('shows an error status when the provider test fails', async () => {
    await bootPopup({
      providers: [createProvider({ id: 'p1', name: 'Alpha' })],
      featureSettings: { ...createRootStore().featureSettings, defaultProviderId: 'p1' }
    });
    await waitFor(() => document.querySelectorAll('#profileList .profile-item').length === 1);

    state.setRuntimeMessageHandler(() => ({ success: false, error: 'boom' }));

    await userEvent.click(el<HTMLButtonElement>('testBtn'));
    await waitFor(() => el('status').textContent === 'Connection failed: boom');
    expect(el('status').classList.contains('error')).toBe(true);
  });
});

describe('popup history', () => {
  it('renders history and filters it with the search box', async () => {
    await bootPopup({
      providers: [createProvider({ id: 'p1', name: 'Alpha' })],
      featureSettings: { ...createRootStore().featureSettings, defaultProviderId: 'p1' },
      chatHistory: [
        createChatSession({
          chatId: 'c1',
          title: 'Alpha chat',
          messages: [createPersistedMessage({ id: 'm1', role: 'user', content: 'hello world' })]
        }),
        createChatSession({
          chatId: 'c2',
          title: 'Beta chat',
          messages: [createPersistedMessage({ id: 'm2', role: 'user', content: 'other topic' })]
        })
      ]
    });
    await waitFor(() => document.querySelectorAll('#profileList .profile-item').length === 1);

    await userEvent.click(document.querySelector('.tab[data-tab="history"]') as HTMLElement);
    expect(document.querySelectorAll('#historyList .history-item').length).toBe(2);

    setValue(el<HTMLInputElement>('historySearchInput'), 'alpha');
    expect(document.querySelectorAll('#historyList .history-item').length).toBe(1);
    expect(document.querySelector('#historyList .history-item-title')?.textContent).toBe('Alpha chat');

    setValue(el<HTMLInputElement>('historySearchInput'), 'zzz');
    expect(document.querySelectorAll('#historyList .history-item').length).toBe(0);
    expect(document.querySelector('#historyList .history-empty')).toBeTruthy();
  });
});

describe('popup prompts', () => {
  it('saves a prompt through the prompts tab', async () => {
    await bootPopup({
      providers: [createProvider({ id: 'p1', name: 'Alpha' })],
      featureSettings: { ...createRootStore().featureSettings, defaultProviderId: 'p1' },
      prompts: [createPrompt({ id: 'prompt-1', name: 'Original', content: 'old' })]
    });
    await waitFor(() => document.querySelectorAll('#profileList .profile-item').length === 1);

    await userEvent.click(document.querySelector('.tab[data-tab="prompts"]') as HTMLElement);
    setValue(el<HTMLInputElement>('promptName'), 'Renamed prompt');
    setValue(el<HTMLTextAreaElement>('promptContent'), 'new content');

    await userEvent.click(el<HTMLButtonElement>('savePromptBtn'));
    await waitFor(() => storedStore().prompts[0]?.name === 'Renamed prompt');

    expect(storedStore().prompts[0].content).toBe('new content');
  });
});

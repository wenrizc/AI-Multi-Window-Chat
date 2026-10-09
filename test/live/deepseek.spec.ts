import { randomUUID } from 'node:crypto';
import { test, expect, modelId, providerId } from './fixtures';
import type { ChatSession } from '../../src/shared/types';

for (const streaming of [true, false]) {
  test(`${streaming ? 'streaming' : 'non-streaming'} chat, follow-up and history restoration`, async ({ page, context, worker, hostUrl }) => {
    // Retain only protocol metadata, never authorization headers or the key.
    const requests: { model: string; stream: boolean; messageCount: number }[] = [];
    const statuses: number[] = [];
    context.on('request', request => {
      if (request.url() !== 'https://api.deepseek.com/chat/completions') return;
      const body = request.postDataJSON();
      requests.push({ model: body.model, stream: body.stream, messageCount: body.messages.length });
    });
    context.on('response', response => {
      if (response.url() === 'https://api.deepseek.com/chat/completions') statuses.push(response.status());
    });
    await page.goto(hostUrl);
    // Verify content-script injection before using the actual keyboard shortcut.
    const selectHostText = async () => {
      await page.locator('p').evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      });
      await expect(page.locator('.ai-selection-toolbar')).toBeVisible();
      await page.evaluate(() => window.getSelection()!.removeAllRanges());
    };
    await selectHostText();
    await expect(page.locator('.ai-selection-toolbar')).toBeAttached();
    await page.keyboard.press('Alt+n');
    const chat = page.frameLocator('.ai-chat-iframe').last();
    await expect(chat.locator('#messageInput')).toBeVisible();
    await expect(chat.locator('#profileSelect')).toHaveValue(providerId);

    const chatId = `deepseek-${randomUUID()}`;
    const marker = `TOKEN_${randomUUID().replace(/-/g, '')}`;
    const prompt = `Remember this token for our conversation: ${marker}. Reply with only this token.`;
    await page.locator('.ai-chat-iframe').last().evaluate((element, payload) => {
      const iframe = element as HTMLIFrameElement;
      iframe.contentWindow!.postMessage({ type: 'INIT_CHAT', ...payload }, new URL(iframe.src).origin);
    }, { chatId, streamingOverride: streaming, initialMessage: prompt });
    await expect(chat.locator('#messageInput')).toHaveValue(prompt);
    await expect(chat.locator('#streamingToggle')).toBeChecked({ checked: streaming });

    const readSession = () => worker.evaluate(async id => {
      const result = await chrome.storage.local.get(`chat_${id}`);
      return (result[`chat_${id}`] as ChatSession | undefined) ?? null;
    }, chatId);

    for (const [turn, message] of [prompt, 'What token did I ask you to remember? Reply with only that token.'].entries()) {
      await chat.locator('#messageInput').fill(message);
      await chat.locator('#sendBtn').click();
      // Persisted assistant messages prove completion, including the full SSE stream.
      await Promise.race([
        expect.poll(async () => (await readSession())?.messages.length ?? 0).toBe((turn + 1) * 2),
        chat.locator('#composerStatus[data-variant="error"]').waitFor({ state: 'visible', timeout: 60_000 }).then(async () => {
          throw new Error(`Extension request failed (HTTP ${statuses[statuses.length - 1] ?? 'no response'}): ${await chat.locator('#composerStatusText').innerText()}`);
        })
      ]);
      const session = (await readSession())!;
      const assistant = session.messages[turn * 2 + 1];
      expect(assistant.role).toBe('assistant');
      expect(assistant.modelId).toBe(modelId);
      expect(assistant.providerId).toBe(providerId);
      expect(assistant.content).toContain(marker);
      expect(assistant.tokenUsage?.totalTokens).toBeGreaterThan(0);
      await expect(chat.locator('.message-assistant .message-content').nth(turn)).toContainText(marker);
      await expect(chat.locator('#sendBtn')).not.toHaveClass(/is-loading/);
    }

    const saved = (await readSession())!;
    expect(requests).toHaveLength(2);
    expect(requests.map(request => request.model)).toEqual([modelId, modelId]);
    expect(requests.map(request => request.stream)).toEqual([streaming, streaming]);
    expect(requests[1].messageCount).toBeGreaterThan(requests[0].messageCount);
    expect(statuses).toEqual([200, 200]);
    expect(saved.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(saved.streamingOverride).toBe(streaming === true ? null : false);
    const indexed = await worker.evaluate(async id => {
      const result = await chrome.storage.local.get('chat_index_v5');
      return (result.chat_index_v5 as { chatId: string; messageCount: number }[]).find(item => item.chatId === id)?.messageCount;
    }, chatId);
    expect(indexed).toBe(4);

    await page.reload();
    await selectHostText();
    await expect(page.locator('.ai-selection-toolbar')).toBeAttached();
    await worker.evaluate(async ({ url, session }) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(tab => tab.url === url);
      if (tab?.id === undefined) throw new Error('Test host tab was not found');
      await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_CHAT_WINDOW', chat: session });
    }, { url: hostUrl, session: saved });
    const restored = page.frameLocator('.ai-chat-iframe').last();
    await expect(restored.locator('.message-assistant .message-content')).toHaveCount(2);
    await expect(restored.locator('.message-assistant .message-content').last()).toContainText(marker);
    await expect(restored.locator('#streamingToggle')).toBeChecked({ checked: streaming });
  });
}

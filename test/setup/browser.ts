import { beforeEach } from 'vitest';
import i18nSource from '../../i18n.js?raw';
import messagesRaw from '../../_locales/en/messages.json?raw';
import { installChrome, type MessagesMap } from '../helpers/chrome-mock';

const messages = JSON.parse(messagesRaw) as MessagesMap;

const state = installChrome({ messages });

// Execute the real `i18n.js` IIFE so the extension pages under test see the
// exact same `t` / `updatePageTranslations` globals they use in production.
new Function(i18nSource)();

beforeEach(() => {
  state.reset();
});

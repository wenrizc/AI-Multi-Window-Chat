import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createChromeMock, type MessagesMap } from '../helpers/chrome-mock';

const root = process.cwd();

type TranslationApi = {
  t: (key: string, values?: string | number | Array<string | number>) => string;
  initPageTranslations: (options?: { localesPath?: string[] }) => Promise<void>;
};

function runtime(options: {
  language?: string;
  search?: string;
  extension?: boolean;
  catalogs?: Record<string, MessagesMap | null>;
} = {}) {
  const en = readJson('_locales/en/messages.json');
  const zh = readJson('_locales/zh_CN/messages.json');
  const catalogs = options.catalogs ?? { en, zh_CN: zh };
  const language = options.language ?? 'en';
  const location = new URL(`https://example.test/website/index.html${options.search ?? ''}`);
  const document = {
    documentElement: { lang: language, getAttribute: () => null },
    querySelectorAll: () => [], title: ''
  };
  const extensionMessages = language === 'zh-CN' ? zh : en;
  const chrome = options.extension ? createChromeMock({ messages: extensionMessages }).chrome : undefined;
  const requests: string[] = [];
  const window = { location, navigator: { language } } as unknown as TranslationApi;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'i18n.js'), 'utf8'), {
    window, document, chrome, URL, URLSearchParams, console,
    fetch: async (url: string) => {
      requests.push(url);
      const locale = url.match(/\/([^/]+)\/messages.json$/)?.[1] ?? '';
      const messages = catalogs[locale];
      return { ok: !!messages, json: async () => messages };
    }
  });
  return { api: window, document, requests };
}

function readJson(relativePath: string): MessagesMap {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function collectI18nKeysFromHtml(filePath: string): string[] {
  const html = fs.readFileSync(filePath, 'utf8');
  const regex = /data-i18n(?:-html|-placeholder|-title|-aria-label|-document-title)?="([^"]+)"/g;
  const keys = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    keys.add(match[1]);
  }
  return [...keys];
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : [file];
  });
}

const productionFiles = [
  ...sourceFiles(path.join(root, 'src')).filter(file => file.endsWith('.ts')),
  path.join(root, 'i18n.js'), path.join(root, 'manifest.json'),
  path.join(root, 'popup.html'), path.join(root, 'chat-window.html'),
  ...sourceFiles(path.join(root, 'website')).filter(file => /\.(html|js)$/.test(file))
];
const requiredKeys = new Set(productionFiles.flatMap(file => {
  const text = fs.readFileSync(file, 'utf8');
  return [
    ...Array.from(text.matchAll(/['"]([a-zA-Z]+__[\w]+)['"]/g), match => match[1]),
    ...collectI18nKeysFromHtml(file),
    ...Array.from(text.matchAll(/__MSG_(\w+?)__/g), match => match[1])
  ];
}));

describe('locale parity', () => {
  const en = readJson('_locales/en/messages.json');
  const zh = readJson('_locales/zh_CN/messages.json');

  it('keeps the entire key set and placeholder contracts aligned', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const [key, entry] of Object.entries(en)) {
      expect(entry.message.trim(), key).not.toBe('');
      expect(zh[key].message.trim(), key).not.toBe('');
      const tokens = (message: string) => [...message.matchAll(/\$\w+\$|\$\d+/g)]
        .map(match => match[0].toLowerCase()).sort();
      expect(tokens(zh[key].message), key).toEqual(tokens(entry.message));
      expect(zh[key].placeholders, key).toEqual(entry.placeholders);
      for (const token of tokens(entry.message).filter(value => value.endsWith('$'))) {
        const name = token.slice(1, -1);
        expect(Object.keys(entry.placeholders ?? {}).map(value => value.toLowerCase()), key).toContain(name);
      }
    }
  });

  it('defines every required key in both locales', () => {
    for (const key of requiredKeys) {
      expect(en[key], `Missing en key: ${key}`).toBeTruthy();
      expect(zh[key], `Missing zh key: ${key}`).toBeTruthy();
    }
  });

  it('keeps $1 placeholders where the UI substitutes values', () => {
    for (const key of ['chat__statusSearchingFor', 'chat__statusTavilyReturned', 'chat__errorServiceStatus']) {
      expect(en[key].message, `Missing en placeholder in ${key}`).toMatch(/\$1/);
      expect(zh[key].message, `Missing zh placeholder in ${key}`).toMatch(/\$1/);
    }
  });

  it('removes retired keys', () => {
    const retired = [
      'prompt__empty',
      'chat__statusIdle',
      'chat__statusModelNoStreaming',
      'chat__thinking',
      'chat__reasoningSummary',
      'popup__defaultStreamingEnabled',
      'popup__searchEnabledByDefault'
    ];
    for (const key of retired) {
      expect(key in en, `Retired en key should be removed: ${key}`).toBe(false);
      expect(key in zh, `Retired zh key should be removed: ${key}`).toBe(false);
    }
  });
});

describe('website markers', () => {
  it('resolves every data-i18n key used in website pages', () => {
    const en = readJson('_locales/en/messages.json');
    const zh = readJson('_locales/zh_CN/messages.json');
    const files = [
      path.join(root, 'website/index.html'),
      path.join(root, 'website/privacy-policy.html')
    ];
    for (const filePath of files) {
      for (const key of collectI18nKeysFromHtml(filePath)) {
        expect(en[key], `Missing en website key: ${key}`).toBeTruthy();
        expect(zh[key], `Missing zh website key: ${key}`).toBeTruthy();
      }
    }
  });

  it('keeps website-dist in sync with the source assets', () => {
    const pairs = [
      ['i18n.js', 'website-dist/i18n.js'],
      ['_locales/en/messages.json', 'website-dist/_locales/en/messages.json'],
      ['_locales/zh_CN/messages.json', 'website-dist/_locales/zh_CN/messages.json'],
      ['website/index.html', 'website-dist/index.html'],
      ['website/site-i18n-init.js', 'website-dist/site-i18n-init.js'],
      ['website/privacy-policy.html', 'website-dist/privacy-policy.html']
    ];
    for (const [sourceRel, distRel] of pairs) {
      expect(
        fs.readFileSync(path.join(root, distRel), 'utf8'),
        `${distRel} should match ${sourceRel}. Run npm run build:website.`
      ).toBe(fs.readFileSync(path.join(root, sourceRel), 'utf8'));
    }
  });
});

describe('i18n runtime', () => {
  for (const extension of [false, true]) {
    it(`uses the catalog placeholder contract and literal values (${extension ? 'extension' : 'website'})`, async () => {
      const { api } = runtime({ extension });
      await api.initPageTranslations();
      expect(api.t('config__statusImported', [2, 9])).toBe('Added 2, updated 9 items');
      expect(api.t('content__aiChatTitle', 7)).toBe('AI Chat 7');
      expect(api.t('content__aiChatTitle', '$& $1 $2 $$')).toBe('AI Chat $& $1 $2 $$');
      expect(api.t('config__statusImported', ['literal $2', '$& $$'])).toBe('Added literal $2, updated $& $$ items');
      expect(api.t('popup__footerVersion', '2.0.0')).toBe('AI Multi-Window Extension v2.0.0');
      expect(api.t('common__missing')).toBe('common__missing');
    });
  }

  it.each([
    ['zh-CN', 'zh-CN'], ['zh-SG', 'zh-CN'], ['zh-Hans', 'zh-CN'],
    ['zh_CN', 'zh-CN'], ['zh', 'zh-CN'], ['zh-TW', 'en'], ['zh-HK', 'en'],
    ['zh-Hant', 'en'], ['fr-FR', 'en'], ['en-US', 'en']
  ])('resolves website language %s to %s', async (language, expected) => {
    const { api, document } = runtime({ language });
    await api.initPageTranslations();
    expect(document.documentElement.lang).toBe(expected);
    expect(api.t('chat__btnSend')).toBe(expected === 'en' ? 'Send' : '发送');
  });

  it.each(['fr-FR', 'zh-TW', 'zh-CN'])('marks the actual extension catalog language for %s', async language => {
    const { api, document } = runtime({ language, extension: true });
    await api.initPageTranslations();
    expect(document.documentElement.lang).toBe(language === 'zh-CN' ? 'zh-CN' : 'en');
  });

  it('falls back per key without losing the active catalog', async () => {
    const en = readJson('_locales/en/messages.json');
    const zh = { ...readJson('_locales/zh_CN/messages.json') };
    delete zh.website__homeSubtitle;
    const { api, document } = runtime({ language: 'zh-CN', catalogs: { en, zh_CN: zh } });
    await api.initPageTranslations();
    expect(api.t('website__homeSubtitle')).toBe(en.website__homeSubtitle.message);
    expect(api.t('chat__btnSend')).toBe('发送');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('falls back to English if the preferred catalog cannot load', async () => {
    const { api, document, requests } = runtime({ language: 'zh-CN', catalogs: { en: readJson('_locales/en/messages.json') } });
    await api.initPageTranslations({ localesPath: ['./missing', './_locales'] });
    expect(api.t('chat__btnSend')).toBe('Send');
    expect(document.documentElement.lang).toBe('en');
    expect(requests).toContain('./_locales/zh_CN/messages.json');
  });

  it('uses the preferred catalog when English is unavailable', async () => {
    const { api, document } = runtime({ language: 'zh-CN', catalogs: { zh_CN: readJson('_locales/zh_CN/messages.json') } });
    await api.initPageTranslations();
    expect(api.t('chat__btnSend')).toBe('发送');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('reports a total loading failure', async () => {
    const { api } = runtime({ catalogs: {} });
    await expect(api.initPageTranslations()).rejects.toThrow('Unable to load locale messages');
  });

  it('gives an explicit URL language precedence over the browser', async () => {
    const { api, document } = runtime({ language: 'zh-CN', search: '?lang=en' });
    await api.initPageTranslations();
    expect(document.documentElement.lang).toBe('en');
    expect(api.t('chat__btnSend')).toBe('Send');
  });
});

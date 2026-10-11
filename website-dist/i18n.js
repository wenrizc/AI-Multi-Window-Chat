(function (global) {
  let websiteMessages = null;
  let fallbackMessages = null;
  let websiteLocaleDir = 'en';

  function hasChromeI18n() {
    return typeof chrome !== 'undefined' && !!chrome.i18n?.getMessage;
  }

  function toArray(value) {
    if (Array.isArray(value)) {
      return value;
    }
    if (value === undefined || value === null) {
      return [];
    }
    return [value];
  }

  function detectPreferredLocale() {
    const langParam = new URLSearchParams(global.location?.search || '').get('lang');
    if (langParam) {
      return langParam;
    }

    if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
      return chrome.i18n.getUILanguage() || 'en';
    }

    return global.navigator?.language || global.navigator?.userLanguage || 'en';
  }

  function resolveLocaleDir(locale) {
    // Match the extension's supported locale: Traditional Chinese falls back
    // to English, rather than silently presenting Simplified Chinese.
    const language = String(locale || 'en').replace(/_/g, '-');
    return /^zh(?:-(?:cn|sg|hans)(?:-|$)|$)/i.test(language) ? 'zh_CN' : 'en';
  }

  function resolveDocumentLang(localeDir) {
    return localeDir === 'zh_CN' ? 'zh-CN' : 'en';
  }

  function formatMessage(entry, values) {
    const placeholders = Object.fromEntries(Object.entries(entry.placeholders || {})
      .map(([name, definition]) => [name.toLowerCase(), definition.content]));
    const positional = (template) => template.replace(/\$\$|\$(\d+)/g,
      (token, index) => token === '$$' ? '$' : String(values[Number(index) - 1] ?? ''));
    // Replace the original template once; inserted values are never reparsed.
    return entry.message.replace(/\$\$|\$([a-z_][\w]*)\$|\$(\d+)/gi, (token, name, index) => {
      if (token === '$$') return '$';
      if (name) return positional(placeholders[name.toLowerCase()] || '');
      return String(values[Number(index) - 1] ?? '');
    });
  }

  function t(key, substitutions = []) {
    const positional = toArray(substitutions).map(String);

    try {
      if (hasChromeI18n()) {
        const message = chrome.i18n.getMessage(key, positional);
        return message || key;
      }
      const entry = websiteMessages?.[key]?.message ? websiteMessages[key] : fallbackMessages?.[key];
      return entry?.message ? formatMessage(entry, positional) : key;
    } catch (error) {
      console.warn(`Translation not found for key: ${key}`, error);
      return key;
    }
  }

  function applyTranslation(element, key, mode) {
    const translation = t(key);

    if (mode === 'html') {
      element.innerHTML = translation;
      return;
    }

    element.textContent = translation;
  }

  function updatePageTranslations() {
    const language = t('common__locale');
    if (language === 'en' || language === 'zh-CN') {
      document.documentElement.lang = language;
    }
    document.querySelectorAll('[data-i18n]').forEach((element) => {
      const key = element.getAttribute('data-i18n');
      if (key) {
        applyTranslation(element, key, 'text');
      }
    });

    document.querySelectorAll('[data-i18n-html]').forEach((element) => {
      const key = element.getAttribute('data-i18n-html');
      if (key) {
        applyTranslation(element, key, 'html');
      }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
      const key = element.getAttribute('data-i18n-placeholder');
      if (key) {
        element.placeholder = t(key);
      }
    });

    document.querySelectorAll('[data-i18n-title]').forEach((element) => {
      const key = element.getAttribute('data-i18n-title');
      if (key) {
        element.title = t(key);
      }
    });

    document.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
      const key = element.getAttribute('data-i18n-aria-label');
      if (key) {
        element.setAttribute('aria-label', t(key));
      }
    });

    const titleKey = document.documentElement.getAttribute('data-i18n-document-title');
    if (titleKey) {
      document.title = t(titleKey);
    }
  }

  async function loadWebsiteMessages(localesPath) {
    const localeDir = resolveLocaleDir(detectPreferredLocale());
    const basePaths = Array.isArray(localesPath) ? localesPath : [localesPath];
    async function loadLocale(targetLocaleDir) {
      for (const basePath of basePaths) {
        const normalizedBasePath = String(basePath || './_locales').replace(/\/+$/, '');
        const url = `${normalizedBasePath}/${targetLocaleDir}/messages.json`;

        try {
          const response = await fetch(url);
          if (!response.ok) {
            continue;
          }
          const messages = await response.json();
          if (!messages || typeof messages !== 'object' || Array.isArray(messages)) continue;
          return messages;
        } catch (error) {
          console.warn(`Failed to load locale messages from ${url}`, error);
        }
      }
      return null;
    }
    fallbackMessages = await loadLocale('en');
    websiteMessages = localeDir === 'en' ? fallbackMessages : await loadLocale(localeDir);
    websiteLocaleDir = websiteMessages ? localeDir : 'en';
    websiteMessages ||= fallbackMessages;
    if (!websiteMessages) throw new Error('Unable to load locale messages for website.');
  }

  async function initPageTranslations(options = {}) {
    if (hasChromeI18n()) {
      updatePageTranslations();
      return;
    }

    await loadWebsiteMessages(options.localesPath || './_locales');
    document.documentElement.lang = resolveDocumentLang(websiteLocaleDir);
    updatePageTranslations();
    // Carry explicit language overrides across internal website navigation.
    const lang = new URLSearchParams(global.location?.search || '').get('lang');
    if (lang) {
      document.querySelectorAll('a[href]').forEach((link) => {
        const target = new URL(link.getAttribute('href'), global.location.href);
        if (target.origin === global.location.origin && /\.html$/.test(target.pathname)) {
          target.searchParams.set('lang', lang);
          link.href = target.href;
        }
      });
    }
  }

  global.t = t;
  global.updatePageTranslations = updatePageTranslations;
  global.initPageTranslations = initPageTranslations;
})(window);

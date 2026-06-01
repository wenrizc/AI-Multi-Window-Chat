(function (global) {
  let websiteMessages = null;
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
    return String(locale || 'en').toLowerCase().startsWith('zh') ? 'zh_CN' : 'en';
  }

  function resolveDocumentLang(localeDir) {
    return localeDir === 'zh_CN' ? 'zh-CN' : 'en';
  }

  function readMessageTemplate(key) {
    if (hasChromeI18n()) {
      return chrome.i18n.getMessage(key) || key;
    }
    return websiteMessages?.[key]?.message || key;
  }

  function replaceNamedPlaceholders(template, substitutions) {
    let result = template;
    for (const [name, rawValue] of Object.entries(substitutions)) {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`\\$${escapedName}\\$`, 'g'), String(rawValue));
    }
    return result;
  }

  function replacePositionalPlaceholders(template, substitutions) {
    return substitutions.reduce((result, value, index) => {
      return result.replace(new RegExp(`\\$${index + 1}`, 'g'), String(value));
    }, template);
  }

  function t(key, substitutions = []) {
    if (substitutions && typeof substitutions === 'object' && !Array.isArray(substitutions)) {
      try {
        if (hasChromeI18n()) {
          const message = chrome.i18n.getMessage(key, Object.values(substitutions));
          return message || key;
        }
        const template = readMessageTemplate(key);
        return replaceNamedPlaceholders(template, substitutions);
      } catch (error) {
        console.warn(`Translation not found for key: ${key}`, error);
        return key;
      }
    }

    const positional = toArray(substitutions);

    try {
      if (hasChromeI18n()) {
        const message = chrome.i18n.getMessage(key, positional);
        return message || key;
      }
      const template = readMessageTemplate(key);
      return replacePositionalPlaceholders(template, positional);
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

    if (element.tagName === 'INPUT' && element.hasAttribute('placeholder')) {
      element.placeholder = translation;
      return;
    }

    element.textContent = translation;
  }

  function updatePageTranslations() {
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
    const localeDirs = localeDir === 'en' ? ['en'] : [localeDir, 'en'];

    for (const targetLocaleDir of localeDirs) {
      for (const basePath of basePaths) {
        const normalizedBasePath = String(basePath || './_locales').replace(/\/+$/, '');
        const url = `${normalizedBasePath}/${targetLocaleDir}/messages.json`;

        try {
          const response = await fetch(url);
          if (!response.ok) {
            continue;
          }
          websiteMessages = await response.json();
          websiteLocaleDir = targetLocaleDir;
          return;
        } catch (error) {
          console.warn(`Failed to load locale messages from ${url}`, error);
        }
      }
    }

    throw new Error('Unable to load locale messages for website.');
  }

  async function initPageTranslations(options = {}) {
    if (hasChromeI18n()) {
      document.documentElement.lang = chrome.i18n.getUILanguage() || 'en';
      updatePageTranslations();
      return;
    }

    await loadWebsiteMessages(options.localesPath || './_locales');
    document.documentElement.lang = resolveDocumentLang(websiteLocaleDir);
    updatePageTranslations();
  }

  global.t = t;
  global.updatePageTranslations = updatePageTranslations;
  global.initPageTranslations = initPageTranslations;
})(window);

(function () {
  const scriptCandidates = window.location.pathname.includes('/website/')
    ? ['../i18n.js', './i18n.js']
    : ['./i18n.js', '../i18n.js'];

  const localeCandidates = window.location.pathname.includes('/website/')
    ? ['../_locales', './_locales']
    : ['./_locales', '../_locales'];

  function loadScript(index) {
    if (index >= scriptCandidates.length) {
      console.error('Unable to load shared i18n.js for website.');
      return;
    }

    const script = document.createElement('script');
    script.src = scriptCandidates[index];
    script.onload = () => {
      window.initPageTranslations({ localesPath: localeCandidates }).catch((error) => {
        console.error('Website i18n initialization failed.', error);
      });
    };
    script.onerror = () => {
      script.remove();
      loadScript(index + 1);
    };
    document.head.appendChild(script);
  }

  loadScript(0);
})();

/**
 * Browser-mode helpers for booting the extension pages against their real HTML.
 */

/**
 * Mount the body markup (and `<style>` blocks) of an extension HTML file into
 * the current document. Script tags are intentionally dropped: tests import the
 * TypeScript entry points directly.
 */
export function mountExtensionHtml(html: string): void {
  const parsed = new DOMParser().parseFromString(html, 'text/html');

  for (const style of Array.from(parsed.head.querySelectorAll('style'))) {
    document.head.appendChild(document.importNode(style, true));
  }

  document.body.innerHTML = parsed.body.innerHTML;
  for (const script of Array.from(document.body.querySelectorAll('script'))) {
    script.remove();
  }
}

/** Remove markup and styles added by `mountExtensionHtml`. */
export function resetDocument(): void {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('lang');
}

let importCounter = 0;

/**
 * Import a module with a cache-busting query so its top-level side effects
 * (the apps self-instantiate on import) run again with the current DOM.
 */
export async function bootModule(modulePath: string): Promise<unknown> {
  importCounter += 1;
  return import(/* @vite-ignore */ `${modulePath}?test=${importCounter}`);
}

export async function waitFor<T>(predicate: () => T | null | undefined | false, timeout = 4000, interval = 20): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) {
      return value as T;
    }
    if (Date.now() - start > timeout) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

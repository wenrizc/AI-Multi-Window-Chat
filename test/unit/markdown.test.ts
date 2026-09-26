import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { renderMarkdown, safeLinkHref } from '../../src/chat/markdown';
import { escapeHtml } from '../../src/shared/utils';

describe('safeLinkHref', () => {
  it('allows http(s) and mailto links', () => {
    expect(safeLinkHref('https://example.com/a')).toBe('https://example.com/a');
    expect(safeLinkHref('http://example.com')).toBe('http://example.com');
    expect(safeLinkHref('mailto:a@b.c')).toBe('mailto:a@b.c');
  });

  it('allows relative and fragment links', () => {
    expect(safeLinkHref('#section')).toBe('#section');
    expect(safeLinkHref('/path')).toBe('/path');
    expect(safeLinkHref('./path')).toBe('./path');
    expect(safeLinkHref('../path')).toBe('../path');
  });

  it('rejects executable and data schemes', () => {
    expect(safeLinkHref('javascript:alert(1)')).toBeNull();
    expect(safeLinkHref('JavaScript:alert(1)')).toBeNull();
    expect(safeLinkHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeLinkHref('vbscript:msgbox(1)')).toBeNull();
    expect(safeLinkHref('file:///etc/passwd')).toBeNull();
  });

  it('rejects empty values', () => {
    expect(safeLinkHref('')).toBeNull();
    expect(safeLinkHref('   ')).toBeNull();
    expect(safeLinkHref(null)).toBeNull();
    expect(safeLinkHref(undefined)).toBeNull();
  });

  it('never returns a non-whitelisted scheme (property)', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const result = safeLinkHref(value);
        if (result === null) {
          return true;
        }
        return (
          /^(https?:|mailto:)/i.test(result) ||
          result.startsWith('#') ||
          result.startsWith('/') ||
          result.startsWith('./') ||
          result.startsWith('../')
        );
      }),
      { numRuns: 300 }
    );
  });
});

describe('renderMarkdown', () => {
  it('renders common markdown structures', async () => {
    const html = await renderMarkdown('# Title\n\n**bold** and `code`\n\n- one\n- two');
    expect(html).toContain('<h1');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
  });

  it('renders katex math', async () => {
    const html = await renderMarkdown('$x^2 + y^2$');
    expect(html).toContain('katex');
  });

  it('escapes raw HTML blocks and inline tags', async () => {
    const block = await renderMarkdown('<script>alert(1)</script>');
    expect(block).not.toContain('<script');
    expect(block).toContain('&lt;script&gt;');

    const inline = await renderMarkdown('hello <img src=x onerror="alert(1)"> world');
    expect(inline).not.toMatch(/<img[\s>]/i);
    expect(inline).toContain('&lt;img');
  });

  it('strips javascript links but keeps their label', async () => {
    const html = await renderMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
    expect(html).toContain('click me');
  });

  it('renders safe links with rel/target hardening', async () => {
    const html = await renderMarkdown('[docs](https://example.com/docs)');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  it('drops unsafe image sources', async () => {
    const html = await renderMarkdown('![alt text](javascript:alert(1))');
    expect(html).not.toContain('<img');
    expect(html).toContain('alt text');
  });

  it('renders safe images', async () => {
    const html = await renderMarkdown('![alt](https://example.com/x.png)');
    expect(html).toContain('<img');
    expect(html).toContain('src="https://example.com/x.png"');
  });

  it('never emits executable markup for hostile payloads', async () => {
    const payloads = [
      '<a href="javascript:alert(1)">x</a>',
      '<svg onload="alert(1)"></svg>',
      '[x](data:text/html,<script>alert(1)</script>)',
      '![x](vbscript:msgbox(1))',
      '<iframe src="https://evil.test"></iframe>',
      '<math><mtext></mtext></math>'
    ];
    for (const payload of payloads) {
      const html = await renderMarkdown(payload);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<iframe/i);
      expect(html).not.toMatch(/<a[^>]+href="(?:javascript|data|vbscript):/i);
      expect(html).not.toMatch(/<(?:img|svg|math)[^>]+on\w+\s*=/i);
    }
  });
});

describe('escapeHtml (property)', () => {
  it('never leaves raw angle quotes or double quotes', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const escaped = escapeHtml(value);
        return !/[<>"]/.test(escaped);
      }),
      { numRuns: 300 }
    );
  });
});

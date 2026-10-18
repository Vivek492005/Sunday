/**
 * Tests for the Sunday Agent safe markdown renderer.
 * Proves: XSS escaping, javascript: URL rejection, and code-block extraction.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, parseBlocks, parseInline, isSafeUrl } from './markdown';

describe('XSS escaping', () => {
  it('escapes raw HTML tags', () => {
    const html = renderToStaticMarkup(<Markdown source={'<script>alert("xss")</script>'} />);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes event-handler attributes', () => {
    const html = renderToStaticMarkup(<Markdown source={'<img src=x onerror=alert(1)>'} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes HTML inside code blocks', () => {
    const html = renderToStaticMarkup(
      <Markdown source={'```html\n<div onclick="evil()">hi</div>\n```'} />,
    );
    expect(html).not.toContain('<div onclick');
    expect(html).toContain('&lt;div');
  });

  it('escapes angle brackets in plain text', () => {
    const html = renderToStaticMarkup(<Markdown source={'a < b > c & d'} />);
    expect(html).toContain('a &lt; b &gt; c &amp; d');
  });
});

describe('link URL allow-list', () => {
  it('accepts https links', () => {
    expect(isSafeUrl('https://example.com/x')).toBe(true);
  });

  it('accepts http and mailto links', () => {
    expect(isSafeUrl('http://example.com')).toBe(true);
    expect(isSafeUrl('mailto:a@b.com')).toBe(true);
  });

  it('rejects javascript: URLs and renders them as plain text', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    const html = renderToStaticMarkup(
      <Markdown source={'[click me](javascript:alert(1))'} />,
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a');
    expect(html).toContain('click me');
  });

  it('rejects data: URLs', () => {
    expect(isSafeUrl('data:text/html,<script>')).toBe(false);
  });
});

describe('code-block extraction', () => {
  it('extracts a fenced block with its language label', () => {
    const blocks = parseBlocks('before\n```ts\nconst a = 1;\n```\nafter');
    const code = blocks.find((b) => b.kind === 'code');
    expect(code).toBeDefined();
    expect(code).toMatchObject({ kind: 'code', lang: 'ts', code: 'const a = 1;' });
  });

  it('handles a fence without a language label', () => {
    const blocks = parseBlocks('```\nplain\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'code', lang: '', code: 'plain' });
  });

  it('treats an unclosed fence as a code block to the end', () => {
    const blocks = parseBlocks('text\n```py\nx = 1\ny = 2');
    const code = blocks.find((b) => b.kind === 'code');
    expect(code).toMatchObject({ kind: 'code', lang: 'py', code: 'x = 1\ny = 2' });
  });

  it('extracts multiple code blocks', () => {
    const blocks = parseBlocks('```a\n1\n```\nmid\n```b\n2\n```');
    const codes = blocks.filter((b) => b.kind === 'code');
    expect(codes).toHaveLength(2);
  });
});

describe('inline formatting', () => {
  it('renders bold, italic and inline code', () => {
    const html = renderToStaticMarkup(<Markdown source={'**bold** *italic* `code`'} />);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code class="sunday-md-inline-code">code</code>');
  });

  it('does not format an unclosed bold marker', () => {
    const tokens = parseInline('**oops');
    expect(tokens.every((t) => t.kind === 'text')).toBe(true);
  });
});

describe('block structure', () => {
  it('renders ## and ### headings', () => {
    const html = renderToStaticMarkup(<Markdown source={'## Title\n### Sub'} />);
    expect(html).toContain('<h2 class="sunday-md-h2">Title</h2>');
    expect(html).toContain('<h3 class="sunday-md-h3">Sub</h3>');
  });

  it('renders lists and quotes', () => {
    const html = renderToStaticMarkup(
      <Markdown source={'> quoted\n\n- one\n- two'} />,
    );
    expect(html).toContain('<blockquote');
    expect(html).toContain('<ul');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
  });

  it('splits paragraphs on blank lines', () => {
    const blocks = parseBlocks('one\n\ntwo');
    const paras = blocks.filter((b) => b.kind === 'para');
    expect(paras).toHaveLength(2);
  });

  it('renders a safe https link as an anchor', () => {
    const html = renderToStaticMarkup(
      <Markdown source={'[docs](https://example.com)'} />,
    );
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

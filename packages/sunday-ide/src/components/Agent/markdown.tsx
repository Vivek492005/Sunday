/**
 * Sunday Agent — tiny SAFE markdown renderer. Zero new dependencies.
 *
 * Supports: paragraphs, **bold**, *italic*, `inline code`, fenced code
 * blocks (with language label + Copy button), ## / ### headings, `-` lists,
 * `>` quotes, [links](url).
 *
 * XSS safety: the renderer NEVER uses dangerouslySetInnerHTML — every text
 * node goes through React's escaping — and URLs are allow-listed to
 * http/https/mailto (`javascript:` etc. degrade to plain text).
 */
import React, { useState } from 'react';

/* ------------------------------------------------------------------ types */

export type MdBlock =
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'code'; lang: string; code: string };

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; url: string };

/* ------------------------------------------------------------ block parse */

const FENCE_RE = /^```(\S*)\s*$/;
const HEADING_RE = /^(#{2,3})\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const LIST_RE = /^[-*]\s+(.*)$/;

export function parseBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let list: string[] = [];
  let fence: { lang: string; code: string[] } | null = null;

  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: 'para', text: para.join(' ') });
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      blocks.push({ kind: 'quote', text: quote.join(' ') });
      quote = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push({ kind: 'list', items: list });
      list = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
    flushList();
  };

  for (const raw of lines) {
    const line = raw;
    if (fence) {
      if (FENCE_RE.test(line.trim())) {
        blocks.push({ kind: 'code', lang: fence.lang, code: fence.code.join('\n') });
        fence = null;
      } else {
        fence.code.push(line);
      }
      continue;
    }

    const fenceMatch = FENCE_RE.exec(line.trim());
    if (fenceMatch) {
      flushAll();
      fence = { lang: fenceMatch[1] ?? '', code: [] };
      continue;
    }
    if (line.trim() === '') {
      flushAll();
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      flushAll();
      blocks.push({
        kind: 'heading',
        level: headingMatch[1].length === 3 ? 3 : 2,
        text: headingMatch[2].trim(),
      });
      continue;
    }
    const quoteMatch = QUOTE_RE.exec(line);
    if (quoteMatch) {
      flushPara();
      flushList();
      quote.push(quoteMatch[1].trim());
      continue;
    }
    const listMatch = LIST_RE.exec(line);
    if (listMatch) {
      flushPara();
      flushQuote();
      list.push(listMatch[1].trim());
      continue;
    }
    flushQuote();
    flushList();
    para.push(line.trim());
  }

  if (fence) {
    // Unclosed fence: still treat the remainder as a code block.
    blocks.push({ kind: 'code', lang: fence.lang, code: fence.code.join('\n') });
  } else {
    flushAll();
  }
  return blocks;
}

/* ----------------------------------------------------------- inline parse */

const INLINE_RE = /(`[^`\n]+`)|(\[([^\]]+)\]\(([^()\s]*(?:\([^)]*\)[^()\s]*)*)\))|(\*\*([^*]+?)\*\*)|(\*([^*]+?)\*)/g;
const SAFE_URL_RE = /^(https?:\/\/|mailto:)/i;

export function isSafeUrl(url: string): boolean {
  return SAFE_URL_RE.test(url.trim());
}

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) tokens.push({ kind: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) {
      tokens.push({ kind: 'code', text: m[1].slice(1, -1) });
    } else if (m[2] !== undefined) {
      const label = m[3];
      const url = m[4];
      if (isSafeUrl(url)) tokens.push({ kind: 'link', text: label, url });
      else tokens.push({ kind: 'text', text: label }); // unsafe scheme: show label only
    } else if (m[5] !== undefined) {
      tokens.push({ kind: 'bold', text: m[6] });
    } else if (m[7] !== undefined) {
      tokens.push({ kind: 'italic', text: m[8] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ kind: 'text', text: text.slice(last) });
  return tokens;
}

/* ---------------------------------------------------------------- render */

function renderInline(tokens: InlineToken[], keyPrefix: string): React.ReactNode[] {
  return tokens.map((t, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (t.kind) {
      case 'code':
        return <code key={key} className="sunday-md-inline-code">{t.text}</code>;
      case 'bold':
        return <strong key={key}>{renderInline(parseInline(t.text), `${key}-b`)}</strong>;
      case 'italic':
        return <em key={key}>{renderInline(parseInline(t.text), `${key}-i`)}</em>;
      case 'link':
        return (
          <a key={key} href={t.url} target="_blank" rel="noopener noreferrer" className="sunday-md-link">
            {renderInline(parseInline(t.text), `${key}-l`)}
          </a>
        );
      default:
        return <React.Fragment key={key}>{t.text}</React.Fragment>;
    }
  });
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const ta = document.createElement('textarea');
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — non-fatal
    }
  };

  return (
    <div className="sunday-md-codeblock">
      <div className="sunday-md-codeblock-bar">
        <span className="sunday-md-codeblock-lang">{lang || 'code'}</span>
        <button type="button" className="sunday-md-copy" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="sunday-md-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({ source }: { source: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className="sunday-md">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return b.level === 3 ? (
              <h3 key={i} className="sunday-md-h3">
                {renderInline(parseInline(b.text), `h3-${i}`)}
              </h3>
            ) : (
              <h2 key={i} className="sunday-md-h2">
                {renderInline(parseInline(b.text), `h2-${i}`)}
              </h2>
            );
          case 'quote':
            return (
              <blockquote key={i} className="sunday-md-quote">
                {renderInline(parseInline(b.text), `q-${i}`)}
              </blockquote>
            );
          case 'list':
            return (
              <ul key={i} className="sunday-md-list">
                {b.items.map((item, j) => (
                  <li key={j}>{renderInline(parseInline(item), `li-${i}-${j}`)}</li>
                ))}
              </ul>
            );
          case 'code':
            return <CodeBlock key={i} lang={b.lang} code={b.code} />;
          default:
            return (
              <p key={i} className="sunday-md-p">
                {renderInline(parseInline(b.text), `p-${i}`)}
              </p>
            );
        }
      })}
    </div>
  );
}

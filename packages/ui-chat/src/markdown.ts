// Tiny, dependency-free markdown renderer for assistant messages.
//
// Safety first: the raw text is HTML-escaped BEFORE any markup is applied,
// so a model emitting `<script>` can never inject markup. Supports fenced
// code blocks, inline code, **bold**, and paragraphs. Lists/quotes render as
// plain paragraphs — good enough for chat, deliberately small.

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render markdown-ish text to a safe HTML string. */
export function renderMarkdown(src: string): string {
  const fences: string[] = [];
  const spans: string[] = [];

  // 1. Pull out fenced code blocks so inner content is never re-processed.
  const withoutFences = src.replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, (_m, code: string) => {
    fences.push(`<pre><code>${escapeHtml(code.replace(/\n+$/, ''))}</code></pre>`);
    return `\u0000${fences.length - 1}\u0000`;
  });

  // 2. Paragraphs (blank-line separated).
  return withoutFences
    .split(/\n{2,}/)
    .map((para) => {
      const trimmed = para.trim();
      const fenceRef = trimmed.match(/^\u0000(\d+)\u0000$/);
      if (fenceRef) return fences[Number(fenceRef[1])] ?? '';
      let h = escapeHtml(para);
      // Inline code spans — extracted before bold so `**` inside code is safe.
      h = h.replace(/`([^`\n]+?)`/g, (_m, code: string) => {
        spans.push(`<code>${code}</code>`);
        return `\u0001${spans.length - 1}\u0001`;
      });
      h = h.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
      h = h.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => spans[Number(i)] ?? '');
      // A fence placeholder stranded mid-paragraph (no blank lines around
      // the fence) still gets substituted.
      h = h.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => fences[Number(i)] ?? '');
      if (!h.trim()) return '';
      return `<p>${h.replace(/\n/g, '<br>')}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}

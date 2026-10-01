// sundayd — untrusted-content handling (§15.4 prompt-injection defences).
//
// Everything the model did not write itself — tool outputs, web fetches,
// MCP results, file contents — is *data*, never instructions. Before such
// content reaches the model it is wrapped in explicit delimiters (this
// module), and the system prompt carries a standing rule to that effect
// (see INJECTION_GUARD in system-prompt.ts). The wrapper is applied in the
// agent loop's executeCall, the single choke point every tool result flows
// through before entering the conversation history.

export const UNTRUSTED_OPEN_PREFIX = '<untrusted_tool_output tool="';
export const UNTRUSTED_CLOSE_TAG = '</untrusted_tool_output>';
/** Replacement for a literal closing tag inside untrusted content. */
const ESCAPED_CLOSE_TAG = '<untrusted_tool_output_end/>';

/**
 * Wrap a tool result as untrusted data. Any literal closing tag inside the
 * content is neutralised so the delimiters cannot be broken out of.
 */
export function wrapUntrustedToolOutput(toolName: string, output: string): string {
  const safeName = toolName.replace(/"/g, "'");
  const safeOutput = output.split(UNTRUSTED_CLOSE_TAG).join(ESCAPED_CLOSE_TAG);
  return `${UNTRUSTED_OPEN_PREFIX}${safeName}">\n${safeOutput}\n${UNTRUSTED_CLOSE_TAG}`;
}

/**
 * Strip the wrapper again (tests / debug tooling). Returns the inner
 * content, or the input unchanged when it is not wrapped.
 */
export function unwrapToolOutput(wrapped: string): string {
  if (!wrapped.startsWith(UNTRUSTED_OPEN_PREFIX)) return wrapped;
  const firstNl = wrapped.indexOf('\n');
  const lastClose = wrapped.lastIndexOf(UNTRUSTED_CLOSE_TAG);
  if (firstNl === -1 || lastClose === -1 || lastClose < firstNl) return wrapped;
  let inner = wrapped.slice(firstNl + 1, lastClose);
  if (inner.endsWith('\n')) inner = inner.slice(0, -1);
  return inner.replaceAll(ESCAPED_CLOSE_TAG, UNTRUSTED_CLOSE_TAG);
}

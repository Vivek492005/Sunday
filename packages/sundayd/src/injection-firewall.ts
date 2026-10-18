/**
 * injection-firewall.ts — F10: Security Gate & Injection Firewall.
 *
 * Generalizes SEC-09 taint tracking into a full injection firewall:
 *
 * 1. UNTRUSTED SPANS — content from web/MCP/file reads is wrapped in
 *    `UntrustedSpan` values carrying source + taint metadata. Spans flow
 *    through the agent context as data; the firewall inspects them before
 *    any sink is reached.
 * 2. TAINT-TO-SINK POLICY — untrusted content reaching a dangerous sink
 *    (terminal, network, write outside workspace) is NEVER silently
 *    executed: the firewall returns `ask` (user approval) or `block`.
 *    Sinks are aligned with F7's RiskTier taxonomy (permission-intel.ts).
 * 3. INJECTION DETECTION — pattern-based detection of instruction-injection
 *    attempts inside untrusted spans (classic prompt-injection phrasings,
 *    embedded shell commands, exfil directives, markdown image exfil, …).
 *
 * Decision model: `firewallCheck(span, sink)` → 'allow' | 'ask' | 'block'.
 * - block: known-malicious pattern (exfil, destructive, credential theft).
 * - ask:   untrusted content reaching a sensitive sink, or suspicious
 *           instruction-like phrasing. The agent must surface the request
 *           to the user and wait for explicit approval.
 * - allow: trusted content, or untrusted content reaching a read-only sink
 *           with no injection markers.
 */

import type { RiskTier } from './permission-intel.js';

/* ------------------------------------------------------------------ spans */

/** Where untrusted content can come from. Superset of taint.ts sources. */
export type UntrustedSource =
  | 'web_fetch'
  | 'web_search'
  | 'mcp_tool_result'
  | 'file_read_untrusted'
  | 'browser_content'
  | 'readme'
  | 'issue_text'
  | 'chat_message_untrusted'
  | 'clipboard';

/** A chunk of content tagged with its trust level. */
export interface UntrustedSpan {
  /** Raw content (treated as DATA, never instructions). */
  content: string;
  /** Provenance of the content. */
  source: UntrustedSource;
  /** True when the span has not been sanitized/reviewed by the user. */
  tainted: boolean;
  /** Optional origin detail (URL, file path, MCP server/tool). */
  origin?: string;
}

/** Wrap raw content from an untrusted source in a span. */
export function wrapUntrusted(
  content: string,
  source: UntrustedSource,
  origin?: string
): UntrustedSpan {
  return { content, source, tainted: true, origin };
}

/** Mark a span as reviewed/sanitized by the user (clears taint). */
export function sanitizeSpan(span: UntrustedSpan): UntrustedSpan {
  return { ...span, tainted: false };
}

/* ------------------------------------------------------- sink risk mapping */

/**
 * F7-aligned sink classification.
 *
 * The sink is the *action* the agent wants to take with (possibly tainted)
 * content. Tiers come from permission-intel.ts RiskTier; the firewall only
 * cares about tiers that change external state.
 */
export type SinkKind =
  | 'terminal' // run_terminal / shell exec            → destructive tier
  | 'network' // fetch, browser_navigate, webhook    → network tier
  | 'write_outside_workspace' // write/edit outside cwd → destructive tier
  | 'write_workspace' // write/edit inside cwd        → edit-workspace tier
  | 'install_deps' // npm/pip install                → install-deps tier
  | 'run_tests' // test runners                      → run-tests tier
  | 'read'; // read-only ops                         → read-only tier

/** F7 RiskTier for each sink kind. */
export const SINK_TIER: Record<SinkKind, RiskTier> = {
  terminal: 'destructive',
  network: 'network',
  write_outside_workspace: 'destructive',
  write_workspace: 'edit-workspace',
  install_deps: 'install-deps',
  run_tests: 'run-tests',
  read: 'read-only',
};

/**
 * Sinks that are NEVER auto-approved when the content is tainted.
 * Per spec: untrusted → {terminal, network, write outside workspace} = ask.
 * `write_workspace` is ask-worthy too when injection markers are present.
 */
const TAINTED_ASK_SINKS: ReadonlySet<SinkKind> = new Set([
  'terminal',
  'network',
  'write_outside_workspace',
  'install_deps',
]);

/* ------------------------------------------------- injection pattern table */

/** A detected injection marker with severity. */
export interface InjectionMarker {
  /** Stable rule id, e.g. 'ignore-instructions'. */
  rule: string;
  /** Human-readable explanation. */
  detail: string;
  /** 'block' = known-malicious, 'ask' = suspicious. */
  severity: 'block' | 'ask';
}

interface InjectionRule {
  rule: string;
  detail: string;
  severity: 'block' | 'ask';
  pattern: RegExp;
}

/**
 * Detection rules. Patterns are deliberately conservative: false negatives
 * are worse than false positives here because a hit only escalates to the
 * user, it never auto-executes.
 */
const INJECTION_RULES: InjectionRule[] = [
  // --- classic instruction-override phrasings → ask (suspicious, not proof)
  {
    rule: 'ignore-instructions',
    detail: 'Attempts to override system/developer instructions.',
    severity: 'ask',
    pattern:
      /\b(ignore|disregard|forget|override)\b[^.]{0,80}\b(instructions|previous|above|system prompt|guardrails)\b/i,
  },
  {
    rule: 'role-reassign',
    detail: 'Attempts to reassign the agent role or identity.',
    severity: 'ask',
    pattern:
      /\byou are now\b|\bact as (a |an )?(system|root|admin|developer)\b|\bnew (instructions|persona|role)\b/i,
  },
  {
    rule: 'jailbreak-phrasing',
    detail: 'Known jailbreak / DAN-style phrasing.',
    severity: 'ask',
    pattern:
      /\b(do anything now|DAN|developer mode|jailbreak|bypass (your|safety|all) (restrictions|filters|rules))\b/i,
  },
  // --- exfiltration → block
  {
    rule: 'exfil-env',
    detail: 'Attempts to exfiltrate environment variables or secrets.',
    severity: 'block',
    pattern:
      /\b(env\b[^|]{0,40}\|\s*(curl|wget|nc|bash)|printenv|set\s*\|\s*(curl|wget))\b|\$\{?(AWS_SECRET|OPENAI_API_KEY|GITHUB_TOKEN|SUNDAY_[A-Z_]+)\}?[^a-zA-Z0-9_].{0,60}(curl|wget|http)/i,
  },
  {
    rule: 'exfil-markdown-image',
    detail: 'Markdown image with URL — classic token/secret exfil channel.',
    severity: 'block',
    pattern: /!\[[^\]]{0,80}\]\(\s*https?:\/\/[^)]+[?&](token|key|secret|data|env)=/i,
  },
  {
    rule: 'credential-harvest',
    detail: 'Requests credentials, tokens, or private keys.',
    severity: 'block',
    pattern:
      /\b(send|paste|upload|exfiltrate|cat|read|include|reveal|display|show)\b[^.]{0,80}?(?:\.env\b|id_rsa|\.pem\b|credentials\.json|secrets?)/i,
  },
  // --- destructive commands embedded in prose → block
  // NOTE: no \b anchors around non-word chars (':', '~', '/') — \b only
  // matches at word/non-word transitions, so it silently fails there.
  {
    rule: 'destructive-shell',
    detail: 'Embedded destructive shell command.',
    severity: 'block',
    pattern:
      /(?:^|[\s`'";(])(rm\s+-rf\s+(?:\/|~|\$HOME)|\{\s*:\|\s*:&\s*\}\s*;?\s*:?|:\(\)\s*\{\s*:\|\s*:&\s*\}|mkfs(?:\.\w+)?\s|dd\s+if=\S+\s+of=\/dev\/)/i,
  },
  {
    rule: 'reverse-shell',
    detail: 'Reverse-shell one-liner pattern.',
    severity: 'block',
    pattern:
      /\b(bash\s+-i\s+>&\s*\/dev\/tcp\/|nc\s+(-e\s+\/bin\/(ba)?sh|\S+\s+\d+\s+-e)|socat\s+.*exec:)\b/i,
  },
  {
    rule: 'encoded-payload',
    detail: 'Base64-encoded blob piped to a shell — obfuscated payload.',
    severity: 'block',
    pattern:
      /\becho\s+[A-Za-z0-9+/=]{20,}\s*\|\s*base64\s+(-d|--decode)\s*\|\s*(bash|sh)\b/i,
  },
  // --- prompt-injection via tool-output impersonation → ask
  {
    rule: 'fake-tool-output',
    detail: 'Impersonates tool/system output to inject instructions.',
    severity: 'ask',
    pattern:
      /<\/?(system|tool_output|untrusted_tool_output|admin)[^>]*>|\[SYSTEM\]|\[ADMIN OVERRIDE\]/i,
  },
  {
    rule: 'hidden-instruction-html',
    detail: 'HTML comment or zero-width chars hiding instructions.',
    severity: 'ask',
    pattern:
      /<!--[^>]{10,}-->|[\u200b\u200c\u200d\ufeff]{3,}/,
  },
  // --- social-engineering urgency → ask
  {
    rule: 'urgency-social-engineering',
    detail: 'Manufactured urgency to bypass review ("do not ask", "urgent").',
    severity: 'ask',
    pattern:
      /\b(do not ask|don't ask|skip (approval|review|confirmation)|urgent(ly)?,?\s+(run|execute|do not))\b/i,
  },
  // --- indirect: "run this" with code fence in untrusted content → ask
  {
    rule: 'run-this-code-fence',
    detail: 'Untrusted content instructs the agent to execute an embedded snippet.',
    severity: 'ask',
    pattern:
      /\b(run|execute|eval(uate)?)\b[^.]{0,40}\b(this|the|following)\b[^.]{0,20}\b(code|script|command|snippet)\b/i,
  },
];

/** Scan a span's content for injection markers. */
export function detectInjection(content: string): InjectionMarker[] {
  const hits: InjectionMarker[] = [];
  for (const r of INJECTION_RULES) {
    if (r.pattern.test(content)) {
      hits.push({ rule: r.rule, detail: r.detail, severity: r.severity });
    }
  }
  return hits;
}

/** F10: stable rule metadata for the Sunday IDE security panel (real data). */
export interface InjectionRuleInfo {
  rule: string;
  detail: string;
  severity: 'block' | 'ask';
}

export function listInjectionRules(): InjectionRuleInfo[] {
  return INJECTION_RULES.map((r) => ({
    rule: r.rule,
    detail: r.detail,
    severity: r.severity,
  }));
}

/* ---------------------------------------------------------------- decision */

export type FirewallDecision = 'allow' | 'ask' | 'block';

export interface FirewallVerdict {
  decision: FirewallDecision;
  /** Why — rule ids, sink policy, taint sources. */
  reasons: string[];
  /** Injection markers found (if any). */
  markers: InjectionMarker[];
  /** F7 tier of the sink. */
  sinkTier: RiskTier;
}

const READ_ONLY_SINKS: ReadonlySet<SinkKind> = new Set(['read']);

/**
 * Core firewall check. Pure function — no I/O, no side effects.
 *
 * @param span  Content the agent wants to act on (may be trusted).
 * @param sink  The action the agent wants to take.
 */
export function firewallCheck(span: UntrustedSpan, sink: SinkKind): FirewallVerdict {
  const reasons: string[] = [];
  const markers = detectInjection(span.content);
  const sinkTier = SINK_TIER[sink];

  // 1. Known-malicious markers → block, regardless of sink.
  const blockers = markers.filter((m) => m.severity === 'block');
  if (blockers.length > 0) {
    return {
      decision: 'block',
      reasons: blockers.map(
        (m) =>
          `F10 injection firewall BLOCKED: rule '${m.rule}' — ${m.detail} ` +
          `(source: ${span.source}${span.origin ? ` @ ${span.origin}` : ''}). ` +
          `Never silently executed.`
      ),
      markers,
      sinkTier,
    };
  }

  // 2. Tainted content → sensitive sink → ask (never silent).
  if (span.tainted && TAINTED_ASK_SINKS.has(sink)) {
    reasons.push(
      `Taint-to-sink policy (F10): untrusted content from '${span.source}' ` +
        `reaching sink '${sink}' (F7 tier: ${sinkTier}) requires user approval.`
    );
  }

  // 3. Suspicious (ask-level) markers → ask. The only exemption is a
  //    *trusted* (user-reviewed) span reaching a pure read-only sink:
  //    tainted content with suspicious phrasing always deserves user eyes,
  //    even when the immediate action is "just" a read — the injected
  //    instruction typically targets the *next* action (e.g. "read ~/.ssh/id_rsa").
  const askers = markers.filter((m) => m.severity === 'ask');
  if (askers.length > 0 && (span.tainted || !READ_ONLY_SINKS.has(sink))) {
    reasons.push(
      `Suspicious instruction phrasing detected (${askers
        .map((m) => `'${m.rule}'`)
        .join(', ')}): ${askers[0].detail}`
    );
  }

  if (reasons.length > 0) {
    return { decision: 'ask', reasons, markers, sinkTier };
  }

  return { decision: 'allow', reasons: [], markers, sinkTier };
}

/**
 * Convenience: check a proposed tool call. Maps common tool names to sinks.
 * Unknown tools default to the most restrictive sink ('terminal').
 */
const TOOL_TO_SINK: Record<string, SinkKind> = {
  run_terminal: 'terminal',
  shell_exec: 'terminal',
  browser_navigate: 'network',
  web_fetch: 'network',
  http_request: 'network',
  write_file: 'write_workspace',
  edit_file: 'write_workspace',
  delete_file: 'write_workspace',
  npm_install: 'install_deps',
  pip_install: 'install_deps',
  run_tests: 'run_tests',
  read_file: 'read',
  list_dir: 'read',
  search: 'read',
};

export function sinkForTool(toolName: string): SinkKind {
  return TOOL_TO_SINK[toolName] ?? 'terminal';
}

/**
 * One-call evaluation helper used by the red-team eval and the agent loop:
 * wrap content, pick the sink for the proposed tool, run the firewall.
 */
export function evaluateAction(
  content: string,
  source: UntrustedSource,
  toolName: string,
  origin?: string
): FirewallVerdict {
  return firewallCheck(wrapUntrusted(content, source, origin), sinkForTool(toolName));
}

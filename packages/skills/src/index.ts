/**
 * @sunday/skills — skills, rules, and memory loaders for the SUNDAY agent.
 *
 * Progressive disclosure: prompts get cheap summaries (`discover()` /
 * `loadActiveRules()` / `loadMemory()`); full bodies are pulled on demand.
 */

export { parseFrontmatter, toStringArray, toStringValue } from './frontmatter.js';
export type { FrontmatterData, FrontmatterValue, ParsedFrontmatter } from './frontmatter.js';

export { globToRegExp, matchAnyGlob, matchGlob, normalizeForGlob } from './glob.js';

export { SkillLoader, detectScripts } from './skills.js';
export type {
  LoadedSkill,
  SkillLoaderOptions,
  SkillScope,
  SkillSummary,
} from './skills.js';

export { AGENTS_MD, RuleLoader } from './rules.js';
export type { ActiveRule, RuleLoaderOptions, SystemRule } from './rules.js';

export { SecretRefusedError, SECRET_PATTERNS, assertNoSecrets, loadMemory, remember, redactSecrets, redactionMarker } from './memory.js';
export type { MemoryDiff, MemoryOptions, MemoryScope } from './memory.js';

export { MemoryStore, extractMemories, formatMemoriesForPrompt } from './second-brain.js';
export type { LongTermMemory, MemoryStoreOptions, MemorySearchOptions, MemoryListOptions, TranscriptTurn } from './second-brain.js';

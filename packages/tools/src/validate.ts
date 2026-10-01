/** Minimal JSON-Schema validator for tool arguments.
 *
 *  Supports exactly the subset our tools emit: type (object/string/number/
 *  integer/boolean/array), required, properties (nested), enum, items,
 *  minimum, maximum. Returns a list of human-readable errors (empty = valid).
 *  If a future tool needs more (anyOf, pattern, …), extend this deliberately. */

type Schema = Record<string, unknown>;

export function validateArgs(schema: Schema, args: unknown): string[] {
  const errors: string[] = [];
  check(schema, args, 'args', errors);
  return errors;
}

function check(schema: Schema, value: unknown, at: string, errors: string[]): void {
  const type = schema.type as string | undefined;
  if (type && !typeMatches(type, value)) {
    errors.push(`${at}: expected ${type}, got ${describe(value)}`);
    return;
  }
  const enumValues = schema.enum as unknown[] | undefined;
  if (enumValues && !enumValues.includes(value)) {
    errors.push(`${at}: must be one of ${enumValues.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (type === 'object' && isRecord(value)) {
    for (const r of (schema.required as string[] | undefined) ?? []) {
      if (!(r in value)) errors.push(`${at}.${r}: required`);
    }
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [k, sub] of Object.entries(props)) {
      if (k in value) check(sub, value[k], `${at}.${k}`, errors);
    }
  }
  if (type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((v, i) => check(schema.items as Schema, v, `${at}[${i}]`, errors));
  }
  if ((type === 'number' || type === 'integer') && typeof value === 'number') {
    if (schema.minimum !== undefined && value < (schema.minimum as number)) {
      errors.push(`${at}: below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > (schema.maximum as number)) {
      errors.push(`${at}: above maximum ${schema.maximum}`);
    }
  }
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    default:
      return true; // unknown type keyword: don't block
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

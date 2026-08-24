/**
 * A validator for the subset of JSON Schema that plan.schema.json actually uses.
 *
 * The point is not general-purpose validation — it is that the schema stops being decorative.
 * Before this, xray-push.mjs hand-rolled a weaker set of checks and the docs claimed --dry-run
 * "validates the schema", which it did not: a plan with a malformed test id or a typo'd property
 * passed and reached Xray. Two definitions of valid, one of them unenforced, drifting apart.
 *
 * Kept dependency-free on purpose. This repo is an aem-boilerplate site whose package.json ships
 * to a public project; adding a validation library to it so that .claude/ tooling can lint a JSON
 * file is a poor trade. The supported keywords are listed in KEYWORDS below — anything else in the
 * schema is reported as unsupported rather than silently ignored, so the schema cannot quietly
 * grow past what this understands.
 */

const KEYWORDS = new Set([
  '$schema', 'title', 'description',
  'type', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'pattern', 'enum',
]);

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
};

const matchesType = (v, t) => (t === 'integer' ? Number.isInteger(v)
  : t === 'number' ? typeof v === 'number'
    : typeOf(v) === t || (t === 'number' && typeOf(v) === 'integer'));

/** Unsupported keywords are a defect in the schema, not in the document being checked. */
export function unsupportedKeywords(schema, at = '#') {
  const found = [];
  if (!schema || typeof schema !== 'object') return found;
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k)) found.push(`${at}: unsupported schema keyword "${k}"`);
  }
  if (schema.properties) {
    for (const [k, sub] of Object.entries(schema.properties)) {
      found.push(...unsupportedKeywords(sub, `${at}/properties/${k}`));
    }
  }
  if (schema.items) found.push(...unsupportedKeywords(schema.items, `${at}/items`));
  return found;
}

/**
 * @returns {string[]} human-readable problems, empty when the value conforms.
 */
export function validate(value, schema, at = '') {
  const problems = [];
  const where = at || 'plan';

  if (schema.type && !matchesType(value, schema.type)) {
    return [`${where}: expected ${schema.type}, got ${typeOf(value)}`];
  }

  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${where}: ${JSON.stringify(value)} is not one of ${schema.enum.join(' | ')}`);
  }

  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    problems.push(`${where}: "${value}" does not match ${schema.pattern}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      problems.push(`${where}: needs at least ${schema.minItems} item(s), got ${value.length}`);
    }
    if (schema.items) {
      value.forEach((v, i) => problems.push(...validate(v, schema.items, `${where}[${i}]`)));
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!(key in value)) problems.push(`${where}: "${key}" is required`);
    }
    const known = new Set(Object.keys(schema.properties || {}));
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!known.has(key)) problems.push(`${where}: unknown property "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) problems.push(...validate(value[key], sub, at ? `${at}.${key}` : key));
    }
  }

  return problems;
}

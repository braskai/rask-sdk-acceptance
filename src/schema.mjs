// The JSON Schema 2020-12 subset the v3 contract uses, with no dependencies, so the harness starts with nothing but
// Node. `unsupportedKeywords` refuses a contract that starts using anything else, and test/schema.test.mjs compares the
// verdicts with Ajv's over every schema and example.

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const INT32_MAX = 2147483647;

const FORMAT_CHECKS = {
  'date-time': (v) => RFC3339.test(v) && !Number.isNaN(Date.parse(v)),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
  uri: (v) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\S*$/.test(v),
  'uri-reference': (v) => !/\s/.test(v),
  email: (v) => /^[^\s@]+@[^\s@]+$/.test(v),
};

const NUMBER_FORMAT_CHECKS = {
  int32: (v) => Number.isInteger(v) && Math.abs(v) <= INT32_MAX + 1,
  int64: (v) => Number.isInteger(v),
};

const VALIDATED_KEYWORDS = new Set([
  '$ref', 'type', 'enum', 'const', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'items',
  'minItems', 'maxItems', 'uniqueItems', 'properties', 'required', 'additionalProperties', 'propertyNames',
  'minProperties', 'maxProperties', 'anyOf', 'oneOf', 'discriminator',
]);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'example', 'examples', 'deprecated']);
const SUBSCHEMA_MAP_KEYWORDS = new Set(['properties']);
const SUBSCHEMA_KEYWORDS = new Set(['items', 'additionalProperties', 'propertyNames']);
const SUBSCHEMA_LIST_KEYWORDS = new Set(['anyOf', 'oneOf']);

export function unsupportedKeywords(schemas) {
  const found = new Set();
  const walk = (schema, where) => {
    if (schema === null || typeof schema !== 'object') return;
    for (const [key, value] of Object.entries(schema)) {
      if (key.startsWith('x-')) continue;
      if (!VALIDATED_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) found.add(`${key} (${where})`);
      if (SUBSCHEMA_MAP_KEYWORDS.has(key)) {
        for (const [name, sub] of Object.entries(value)) walk(sub, `${where}/${name}`);
      } else if (SUBSCHEMA_KEYWORDS.has(key)) {
        walk(value, `${where}/${key}`);
      } else if (SUBSCHEMA_LIST_KEYWORDS.has(key)) {
        value.forEach((sub, index) => walk(sub, `${where}/${key}/${index}`));
      }
    }
  };
  for (const [name, schema] of Object.entries(schemas)) walk(schema, name);
  return [...found];
}

export const describeValue = (value) => {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

const codePoints = (text) => [...text].length;

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class SchemaValidator {
  constructor(root) {
    this.root = root;
    this.regexes = new Map();
  }

  pointer(ref) {
    let node = this.root;
    for (const part of ref.slice(2).split('/')) node = node[part.replaceAll('~1', '/').replaceAll('~0', '~')];
    if (node === undefined) throw new Error(`Unresolved $ref ${ref}`);
    return node;
  }

  deref(schema) {
    let node = schema;
    while (node && node.$ref) node = this.pointer(node.$ref);
    return node;
  }

  // `open`: response rules (DESIGN 4.2): enums and unions marked x-rask-open-* accept values added later.
  validate(schema, value, { open = false, pointer = '' } = {}) {
    const errors = [];
    this.#check(schema, value, pointer, errors, open);
    return errors;
  }

  #regex(source) {
    let regex = this.regexes.get(source);
    if (!regex) {
      regex = new RegExp(source, 'u');
      this.regexes.set(source, regex);
    }
    return regex;
  }

  #check(schema, value, pointer, errors, open) {
    if (schema === true) return;
    if (schema === false) {
      errors.push({ pointer, message: 'is not allowed here' });
      return;
    }
    if (schema.$ref) this.#check(this.pointer(schema.$ref), value, pointer, errors, open);
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((type) => TYPE_CHECKS[type](value))) {
        errors.push({ pointer, message: `must be ${types.join(' or ')}, got ${describeValue(value)}` });
        return;
      }
    }
    if (schema.const !== undefined && !deepEqual(schema.const, value)) {
      errors.push({ pointer, message: `must be ${describeValue(schema.const)}, got ${describeValue(value)}` });
    }
    if (schema.enum) this.#checkEnum(schema, value, pointer, errors, open);
    if (typeof value === 'string') this.#checkString(schema, value, pointer, errors);
    if (typeof value === 'number') this.#checkNumber(schema, value, pointer, errors);
    if (Array.isArray(value)) this.#checkArray(schema, value, pointer, errors, open);
    else if (value !== null && typeof value === 'object') this.#checkObject(schema, value, pointer, errors, open);
    if (schema.anyOf) this.#checkAnyOf(schema, value, pointer, errors, open);
    if (schema.oneOf) this.#checkOneOf(schema, value, pointer, errors, open);
  }

  #checkEnum(schema, value, pointer, errors, open) {
    if (open && schema['x-rask-open-enum'] && typeof value === 'string') return;
    if (!schema.enum.some((allowed) => deepEqual(allowed, value))) {
      errors.push({ pointer, message: `must be one of ${schema.enum.join(', ')}; got ${describeValue(value)}` });
    }
  }

  #checkString(schema, value, pointer, errors) {
    if (schema.minLength !== undefined && codePoints(value) < schema.minLength) {
      errors.push({ pointer, message: `must have at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && codePoints(value) > schema.maxLength) {
      errors.push({ pointer, message: `must have at most ${schema.maxLength} characters` });
    }
    if (schema.pattern !== undefined && !this.#regex(schema.pattern).test(value)) {
      errors.push({ pointer, message: `must match ${schema.pattern}; got ${describeValue(value)}` });
    }
    const format = FORMAT_CHECKS[schema.format];
    if (format && !format(value)) {
      errors.push({ pointer, message: `must be a valid ${schema.format}; got ${describeValue(value)}` });
    }
  }

  #checkNumber(schema, value, pointer, errors) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ pointer, message: `must be >= ${schema.minimum}; got ${value}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ pointer, message: `must be <= ${schema.maximum}; got ${value}` });
    }
    const format = NUMBER_FORMAT_CHECKS[schema.format];
    if (format && !format(value)) errors.push({ pointer, message: `must be a valid ${schema.format}; got ${value}` });
  }

  #checkArray(schema, value, pointer, errors, open) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ pointer, message: `must have at least ${schema.minItems} items; got ${value.length}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ pointer, message: `must have at most ${schema.maxItems} items; got ${value.length}` });
    }
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push({ pointer, message: 'must not repeat items' });
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => this.#check(schema.items, item, `${pointer}/${index}`, errors, open));
    }
  }

  #checkObject(schema, value, pointer, errors, open) {
    const names = Object.keys(value);
    if (schema.minProperties !== undefined && names.length < schema.minProperties) {
      errors.push({ pointer, message: `must have at least ${schema.minProperties} properties` });
    }
    if (schema.maxProperties !== undefined && names.length > schema.maxProperties) {
      errors.push({ pointer, message: `must have at most ${schema.maxProperties} properties` });
    }
    for (const name of schema.required ?? []) {
      if (!(name in value)) errors.push({ pointer: `${pointer}/${name}`, message: 'is required and missing' });
    }
    const properties = schema.properties ?? {};
    for (const name of names) {
      const childPointer = `${pointer}/${name}`;
      if (schema.propertyNames !== undefined) {
        for (const error of this.validate(schema.propertyNames, name, { open })) {
          errors.push({ pointer: childPointer, message: `property name ${error.message}` });
        }
      }
      if (Object.hasOwn(properties, name)) {
        this.#check(properties[name], value[name], childPointer, errors, open);
      } else if (schema.additionalProperties === false) {
        const known = Object.keys(properties).join(', ');
        errors.push({ pointer: childPointer, message: `is not in the contract; known properties: ${known}` });
      } else if (schema.additionalProperties !== undefined) {
        this.#check(schema.additionalProperties, value[name], childPointer, errors, open);
      }
    }
  }

  #checkAnyOf(schema, value, pointer, errors, open) {
    const branches = schema.anyOf.map((branch) => this.validate(branch, value, { open, pointer }));
    if (branches.some((branch) => branch.length === 0)) return;
    const concrete = schema.anyOf.filter((branch) => this.deref(branch).type !== 'null');
    if (concrete.length === 1) {
      errors.push(...branches[schema.anyOf.indexOf(concrete[0])]);
      return;
    }
    errors.push({ pointer, message: `matches none of the ${schema.anyOf.length} allowed shapes` });
  }

  #checkOneOf(schema, value, pointer, errors, open) {
    if (!schema.discriminator) {
      const matches = schema.oneOf.filter((branch) => this.validate(branch, value, { open, pointer }).length === 0);
      if (matches.length !== 1) {
        errors.push({ pointer, message: `must match exactly one shape; matches ${matches.length}` });
      }
      return;
    }
    if (!TYPE_CHECKS.object(value)) {
      errors.push({ pointer, message: `must be an object, got ${describeValue(value)}` });
      return;
    }
    const { propertyName, mapping } = schema.discriminator;
    const tag = value[propertyName];
    if (tag === undefined) {
      errors.push({ pointer: `${pointer}/${propertyName}`, message: 'discriminator is required and missing' });
      return;
    }
    if (typeof tag === 'string' && Object.hasOwn(mapping, tag)) {
      this.#check(this.pointer(mapping[tag]), value, pointer, errors, open);
      return;
    }
    if (open && schema['x-rask-open-union'] && typeof tag === 'string') return;
    const known = Object.keys(mapping).join(', ');
    errors.push({ pointer: `${pointer}/${propertyName}`, message: `must be one of ${known}; got ${describeValue(tag)}` });
  }
}

const PATTERN_SAMPLES = {
  '^[^/\\\\\\x00-\\x1F\\x7F]+$': 'sample.mp4',
  '^Speaker [1-9][0-9]{0,2}$': 'Speaker 1',
  '^SPEAKER_\\d{2,3}$': 'SPEAKER_00',
  '^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$': 'en',
  '^\\d{4}-\\d{2}$': '2026-11',
  '^[a-z][a-z0-9_]*$': 'sample_code',
};

const FORMAT_SAMPLES = {
  'date-time': '2026-11-03T09:00:00Z',
  date: '2026-11-03',
  uri: 'https://storage.example.com/sample',
  'uri-reference': '/v3/sample',
  email: 'sample@example.com',
};

const sampleString = (schema) => {
  let text = PATTERN_SAMPLES[schema.pattern] ?? FORMAT_SAMPLES[schema.format] ?? 'sample';
  if (schema.minLength !== undefined) text = text.padEnd(schema.minLength, 'x');
  if (schema.maxLength !== undefined) text = text.slice(0, schema.maxLength);
  return text;
};

const sampleNumber = (schema, integer) => {
  const fallback = integer ? 1 : 1.5;
  if (schema.minimum !== undefined && fallback < schema.minimum) return schema.minimum;
  if (schema.maximum !== undefined && fallback > schema.maximum) return schema.maximum;
  return fallback;
};

// A body that validates against `schema`; for contracts or statuses that have no example. Every property is present
// (DESIGN 4.2: `null` when absent), and a union takes its first variant.
export function buildSample(validator, schema, stack = []) {
  if (schema.$ref) {
    if (stack.includes(schema.$ref)) return undefined;
    const value = buildSample(validator, validator.pointer(schema.$ref), [...stack, schema.$ref]);
    return value;
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined && schema.default !== null) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.discriminator) {
    const [tag, target] = Object.entries(schema.discriminator.mapping)[0];
    return { ...buildSample(validator, { $ref: target }, stack), [schema.discriminator.propertyName]: tag };
  }
  if (schema.oneOf) return buildSample(validator, schema.oneOf[0], stack);
  if (schema.anyOf) {
    for (const branch of schema.anyOf) {
      if (validator.deref(branch).type === 'null') continue;
      const value = buildSample(validator, branch, stack);
      if (value !== undefined) return value;
    }
    return null;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find((candidate) => candidate !== 'null') ?? types[0];
  switch (type) {
    case 'string':
      return sampleString(schema);
    case 'integer':
      return sampleNumber(schema, true);
    case 'number':
      return sampleNumber(schema, false);
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array': {
      const count = schema.minItems ?? 1;
      const items = schema.items ? validator.deref(schema.items) : null;
      const values = [];
      for (let index = 0; index < count && items; index += 1) {
        const value = items.enum ? items.enum[index % items.enum.length] : buildSample(validator, schema.items, stack);
        if (value !== undefined) values.push(value);
      }
      return values;
    }
    case 'object':
    case undefined: {
      const object = {};
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        const value = buildSample(validator, property, stack);
        if (value !== undefined) object[name] = value;
      }
      const missing = (schema.minProperties ?? 0) - Object.keys(object).length;
      for (let index = 0; index < missing; index += 1) {
        const value = typeof schema.additionalProperties === 'object' ? buildSample(validator, schema.additionalProperties, stack) : 'sample';
        object[`sample_key_${index}`] = value;
      }
      return object;
    }
    default:
      throw new Error(`Cannot build a sample of type ${type}`);
  }
}

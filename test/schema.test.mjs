import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { DEFAULT_SPEC } from '../src/harness.mjs';
import { SchemaValidator, buildSample, unsupportedKeywords } from '../src/schema.mjs';

const spec = JSON.parse(readFileSync(DEFAULT_SPEC, 'utf8'));
const validator = new SchemaValidator(spec);

const schemaOf = (name) => ({ $ref: `#/components/schemas/${name}` });

describe('the validator', () => {
  test('implements every keyword the contract uses', () => {
    assert.deepEqual(unsupportedKeywords(spec.components.schemas), []);
  });

  test('notices a keyword it does not implement', () => {
    assert.deepEqual(unsupportedKeywords({ Thing: { properties: { a: { not: { type: 'string' } } } } }), ['not (Thing/a)']);
  });

  test('checks types, nullable types and JSON Schema integers', () => {
    const check = (schema, value) => validator.validate(schema, value).length === 0;
    assert.equal(check({ type: ['string', 'null'] }, null), true);
    assert.equal(check({ type: 'string' }, null), false);
    assert.equal(check({ type: 'integer' }, 1), true);
    assert.equal(check({ type: 'integer' }, 1.5), false);
    assert.equal(check({ type: 'integer', format: 'int32' }, 2 ** 31 + 5), false);
    assert.equal(check({ type: 'number' }, 'x'), false);
  });

  test('closes requests and opens responses for x-rask-open-enum', () => {
    const value = 'brand_new_status';
    assert.notEqual(validator.validate(schemaOf('JobStatus'), value).length, 0);
    assert.equal(validator.validate(schemaOf('JobStatus'), value, { open: true }).length, 0);
  });

  test('closes requests and opens responses for x-rask-open-union', () => {
    const value = { credit_type: 'brand_new_pool', anything: 1 };
    assert.notEqual(validator.validate(schemaOf('Cost'), value).length, 0);
    assert.equal(validator.validate(schemaOf('Cost'), value, { open: true }).length, 0);
  });

  test('a known union variant is held to its schema, even in open mode', () => {
    const errors = validator.validate(schemaOf('Cost'), { credit_type: 'minutes' }, { open: true });
    assert.notEqual(errors.length, 0);
  });

  test('names the field and the reason', () => {
    const [first] = validator.validate(schemaOf('CreateFolderRequest'), { name: 'x', color: 'red' });
    assert.equal(first.pointer, '/color');
    assert.match(first.message, /not in the contract/);
  });

  test('reports a nullable anyOf through its concrete branch', () => {
    const schema = { anyOf: [{ type: 'string', maxLength: 1 }, { type: 'null' }] };
    assert.match(validator.validate(schema, 'too long')[0].message, /at most 1/);
  });
});

describe('schema-built bodies', () => {
  for (const name of Object.keys(spec.components.schemas)) {
    test(`${name} validates`, () => {
      const body = buildSample(validator, schemaOf(name));
      assert.deepEqual(validator.validate(schemaOf(name), body), [], JSON.stringify(body)?.slice(0, 400));
    });
  }
});

// A second opinion on the hand-written validator, over the whole contract. Ajv is a dev dependency only: `npm ci` first.
describe('agreement with Ajv', async () => {
  let Ajv;
  let addFormats;
  try {
    ({ Ajv2020: Ajv } = await import('ajv/dist/2020.js'));
    addFormats = (await import('ajv-formats')).default;
  } catch {
    test('skipped: run npm ci to compare with Ajv', { skip: true }, () => {});
    return;
  }
  const ajv = new Ajv({ strict: false, validateSchema: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', { type: 'number', validate: (value) => Number.isInteger(value) && Math.abs(value) <= 2147483648 });
  ajv.addFormat('int64', { type: 'number', validate: Number.isInteger });
  ajv.addFormat('double', { type: 'number', validate: () => true });
  ajv.addSchema({ ...spec, $id: 'contract' });
  const compiled = new Map();
  const ajvVerdict = (pointer, value) => {
    if (!compiled.has(pointer)) compiled.set(pointer, ajv.compile({ $ref: `contract${pointer}` }));
    return compiled.get(pointer)(value);
  };

  const deref = (node) => {
    let current = node;
    while (current?.$ref) current = validator.pointer(current.$ref);
    return current;
  };

  const mutations = function* mutations(value) {
    yield value;
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      yield value.slice(1);
      if (value.length) yield [...value, value[0]];
      return;
    }
    const keys = Object.keys(value);
    for (const key of keys) {
      const { [key]: dropped, ...rest } = value;
      yield rest;
      yield { ...value, [key]: null };
      yield { ...value, [key]: 12345 };
      yield { ...value, [key]: 'not-the-right-value' };
    }
    yield { ...value, added_by_the_test: true };
  };

  const collect = () => {
    const cases = [];
    const add = (pointer, example, label) => cases.push({ pointer, example, label });
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const encoded = path.replaceAll('~', '~0').replaceAll('/', '~1');
        const content = operation.requestBody?.content?.['application/json'];
        for (const [name, example] of Object.entries(content?.examples ?? {})) {
          add(`#/paths/${encoded}/${method}/requestBody/content/application~1json/schema`, deref(example).value, `${operation.operationId} request ${name}`);
        }
        for (const [status, raw] of Object.entries(operation.responses)) {
          const response = deref(raw);
          for (const [mediaType, media] of Object.entries(response.content ?? {})) {
            const base = raw.$ref ? `#/components/responses/${raw.$ref.split('/').at(-1)}` : `#/paths/${encoded}/${method}/responses/${status}`;
            const pointer = `${base}/content/${mediaType.replaceAll('/', '~1')}/schema`;
            for (const [name, example] of Object.entries(media.examples ?? {})) {
              add(pointer, deref(example).value, `${operation.operationId} ${status} ${name}`);
            }
          }
        }
      }
    }
    return cases;
  };

  test('every contract example validates, and Ajv agrees', () => {
    const cases = collect();
    assert.ok(cases.length > 700, `expected the contract's examples, found ${cases.length}`);
    for (const { pointer, example, label } of cases) {
      const schema = validator.pointer(pointer);
      assert.deepEqual(validator.validate(schema, example), [], label);
      assert.equal(ajvVerdict(pointer, example), true, `Ajv refused ${label}`);
    }
  });

  test('the two agree on mutated examples', () => {
    let compared = 0;
    const disagreements = [];
    const seen = new Set();
    for (const { pointer, example, label } of collect()) {
      const schema = validator.pointer(pointer);
      for (const value of mutations(example)) {
        const key = `${pointer}:${JSON.stringify(value)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        compared += 1;
        const mine = validator.validate(schema, value).length === 0;
        const theirs = ajvVerdict(pointer, value);
        if (mine !== theirs) disagreements.push(`${label}: mine ${mine}, Ajv ${theirs}: ${JSON.stringify(value).slice(0, 200)}`);
      }
    }
    assert.ok(compared > 5000, `compared only ${compared}`);
    assert.deepEqual(disagreements.slice(0, 20), [], `${disagreements.length} disagreements out of ${compared}`);
  });
});

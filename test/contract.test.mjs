// The mock against the contract, over HTTP: every operation, every declared problem, every job state, every paged list.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { Contract } from '../src/contract.mjs';
import { DEFAULT_SPEC, Harness } from '../src/harness.mjs';
import { controlClient } from './reference/runner.mjs';
import { UNKNOWN_ENUM_VALUE, UNKNOWN_FIELD, UNKNOWN_VARIANT, injectUnknowns } from '../src/inject.mjs';

const contract = new Contract(DEFAULT_SPEC);
const AUTH = { Authorization: 'Bearer raskai_test_key_test' };

let harness;
let control;
before(async () => {
  harness = new Harness({ port: 0, contract });
  await harness.start();
  control = controlClient(harness);
});
after(() => harness.stop());

const fill = (operation, path) => operation.path.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(path[name]));

const sampleCall = async (operation) => {
  const { path, query, headers, body } = contract.sampleRequest(operation);
  const search = new URLSearchParams(query).toString();
  const response = await fetch(`${harness.baseUrl}${fill(operation, path)}${search ? `?${search}` : ''}`, {
    method: operation.method,
    headers: { ...AUTH, ...headers, ...(body === null ? {} : { 'Content-Type': 'application/json' }) },
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, text, json: text ? JSON.parse(text) : undefined };
};

const assertHeadersValid = (operation, status, response) => {
  const declared = operation.responses[status]?.headers ?? {};
  for (const [name, header] of Object.entries(declared)) {
    const value = response.headers.get(name);
    if (value === null) continue;
    const schema = contract.deref(header.schema);
    const typed = schema.type === 'integer' ? Number(value) : schema.type === 'boolean' ? value === 'true' : value;
    assert.deepEqual(contract.validate(header.schema, typed), [], `${operation.operationId} ${status} header ${name}: ${value}`);
  }
};

describe('every operation answers its sample request', () => {
  for (const operation of contract.operations) {
    test(`${operation.method} ${operation.path} (${operation.operationId})`, async () => {
      await control.post('/reset');
      const { response, json, text } = await sampleCall(operation);
      assert.equal(response.status, Number(operation.successStatus), text.slice(0, 500));
      assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
      assertHeadersValid(operation, operation.successStatus, response);
      const { schema } = operation.responses[operation.successStatus];
      if (schema) assert.deepEqual(contract.validate(schema, json), [], 'the default body must validate strictly');
      else assert.equal(text, '');
      if (operation.responses[operation.successStatus].headers.Location) {
        const location = response.headers.get('location');
        assert.match(location, /^\/v3\//);
        const id = json.id ?? json.segments?.[0]?.id;
        assert.ok(location.endsWith(`/${id}`), `${location} should end in ${id}`);
      }
      const { requests } = (await control.get('/requests')).body;
      assert.equal(requests.at(-1).operationId, operation.operationId);
      assert.deepEqual(requests.at(-1).violations, []);
    });
  }
});

describe('every declared problem can be scripted and validates', () => {
  for (const operation of contract.operations) {
    test(operation.operationId, async () => {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (Number(status) < 400) continue;
        for (const example of Object.values(response.examples)) {
          await control.post('/reset');
          const scripted = await control.post('/script', { operationId: operation.operationId, steps: [{ problem: example.code, status: Number(status) }] });
          assert.equal(scripted.status, 200, JSON.stringify(scripted.body));
          const { response: answer, json } = await sampleCall(operation);
          assert.equal(answer.status, Number(status));
          assert.equal(answer.headers.get('content-type'), 'application/problem+json');
          assert.equal(json.code, example.code);
          assert.equal(json.status, Number(status));
          assert.equal(json.instance, `urn:uuid:${answer.headers.get('x-request-id')}`);
          assert.deepEqual(contract.validate(response.schema, json), []);
          assertHeadersValid(operation, status, answer);
          if (Number(status) === 429 || Number(status) === 503) assert.ok(answer.headers.get('retry-after'));
        }
      }
    });
  }
});

describe('job programs', () => {
  const jobSchema = { $ref: '#/components/schemas/Job' };
  for (const type of contract.jobTemplates.keys()) {
    for (const finalState of ['succeeded', 'failed', 'canceled']) {
      test(`${type} moves queued, running, ${finalState}`, async () => {
        await control.post('/reset');
        const created = await control.post('/jobs', { id: 'job-1', type, states: ['queued', 'running', finalState] });
        assert.equal(created.status, 200, JSON.stringify(created.body));
        const seen = [];
        for (let poll = 0; poll < 4; poll += 1) {
          const response = await fetch(`${harness.baseUrl}/jobs/job-1?wait_seconds=20`, { headers: AUTH });
          const body = await response.json();
          assert.equal(response.status, 200);
          assert.deepEqual(contract.validate(jobSchema, body), [], `${type} ${body.status}`);
          assert.equal(body.id, 'job-1');
          assert.equal(body.type, type);
          assert.equal(body.links.self, '/v3/jobs/job-1');
          assert.match(response.headers.get('etag'), /^"job-1\.\d+"$/);
          const terminal = ['succeeded', 'failed', 'canceled'].includes(body.status);
          assert.equal(response.headers.get('retry-after'), terminal ? null : '1');
          if (body.status === 'succeeded') assert.equal(body.result.type, type);
          if (body.status === 'failed') assert.ok(body.error.code);
          seen.push(body.status);
        }
        assert.deepEqual(seen, ['queued', 'running', finalState, finalState]);
      });
    }
  }

  test('If-None-Match answers 304 while the state holds, never once terminal', async () => {
    await control.post('/reset');
    assert.equal((await control.post('/jobs', { id: 'job-2', states: ['running', 'running', 'succeeded'] })).status, 200);
    const first = await fetch(`${harness.baseUrl}/jobs/job-2`, { headers: AUTH });
    const etag = first.headers.get('etag');
    const second = await fetch(`${harness.baseUrl}/jobs/job-2`, { headers: { ...AUTH, 'If-None-Match': etag } });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), '');
    assert.equal(second.headers.get('retry-after'), '1');
    const third = await fetch(`${harness.baseUrl}/jobs/job-2`, { headers: { ...AUTH, 'If-None-Match': etag } });
    assert.equal(third.status, 200);
    const terminalEtag = third.headers.get('etag');
    const fourth = await fetch(`${harness.baseUrl}/jobs/job-2`, { headers: { ...AUTH, 'If-None-Match': terminalEtag } });
    assert.equal(fourth.status, 200, 'a terminal job ignores If-None-Match');
  });

  test('refuses a program the contract could not produce', async () => {
    const backwards = await control.post('/jobs', { states: ['running', 'queued'] });
    assert.equal(backwards.status, 400);
    assert.match(backwards.body.error, /monotonic/);
    const afterTerminal = await control.post('/jobs', { states: ['failed', 'running'] });
    assert.equal(afterTerminal.status, 400);
    assert.match(afterTerminal.body.error, /terminal/);
  });

  test('a job start can hand out a programmed job, with its Location', async () => {
    await control.post('/reset');
    await control.post('/jobs', { id: 'job-3', type: 'dub', states: ['queued', 'succeeded'] });
    await control.post('/script', { operationId: 'createDub', steps: [{ job: 'job-3' }] });
    const response = await fetch(`${harness.baseUrl}/projects/prj/dub`, {
      method: 'POST',
      headers: { ...AUTH, 'Idempotency-Key': 'k-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'auto', expected_cost_minutes: 1 }),
    });
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.id, 'job-3');
    assert.equal(body.status, 'queued');
    assert.equal(response.headers.get('location'), '/v3/jobs/job-3');
  });
});

describe('paged lists', () => {
  const paged = contract.operations.filter((operation) => operation.meta.pagination === 'cursor');
  test('the contract has paged operations', () => assert.equal(paged.length, 13));
  for (const operation of paged) {
    test(`${operation.operationId} walks 3 pages`, async () => {
      await control.post('/reset');
      const created = await control.post('/pages', { operationId: operation.operationId, pages: 3, page_size: 2 });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const { path, query } = contract.sampleRequest(operation);
      let cursor;
      const ids = [];
      for (let page = 0; page < 3; page += 1) {
        const search = new URLSearchParams({ ...query, ...(cursor ? { cursor } : {}) }).toString();
        const response = await fetch(`${harness.baseUrl}${fill(operation, path)}${search ? `?${search}` : ''}`, { headers: AUTH });
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.deepEqual(contract.validate(operation.responses[operation.successStatus].schema, body), []);
        assert.equal(body.data.length, 2);
        assert.equal(body.has_more, page < 2);
        assert.equal(body.next_cursor === null, page === 2);
        cursor = body.next_cursor;
        ids.push(...body.data.map((item) => item.id));
      }
      if (ids[0] !== undefined) assert.equal(new Set(ids).size, 6, `${operation.operationId} items must be distinct`);
    });
  }

  test('a forged cursor and changed filters answer 400 invalid_cursor', async () => {
    await control.post('/reset');
    await control.post('/pages', { operationId: 'listProjects', pages: 2, page_size: 1 });
    const forged = await fetch(`${harness.baseUrl}/projects?cursor=forged`, { headers: AUTH });
    assert.equal(forged.status, 400);
    assert.equal((await forged.json()).code, 'invalid_cursor');
    const first = await (await fetch(`${harness.baseUrl}/projects?name_contains=a`, { headers: AUTH })).json();
    const changed = await fetch(`${harness.baseUrl}/projects?name_contains=b&cursor=${first.next_cursor}`, { headers: AUTH });
    assert.equal(changed.status, 400);
    assert.equal((await changed.json()).code, 'invalid_cursor');
    const { requests } = (await control.get('/requests')).body;
    assert.equal(requests.at(-1).violations[0].code, 'invalid_cursor');
  });

  test('a non-paged operation cannot be paged', async () => {
    const result = await control.post('/pages', { operationId: 'getMe', pages: 2 });
    assert.equal(result.status, 400);
  });
});

describe('S12 injection reaches every response type', () => {
  const jsonOperations = contract.operations.filter((operation) => operation.responses[operation.successStatus].schema);

  test('unknown fields reach every JSON response; enums and unions reach every open type some example uses', async () => {
    const reached = { enum: new Set(), union: new Set() };
    const noField = [];
    for (const operation of jsonOperations) {
      for (const kind of ['enum', 'union', 'field']) {
        await control.post('/reset');
        await control.post('/script', { operationId: operation.operationId, steps: [{ inject: { [kind]: true } }] });
        const { response, json } = await sampleCall(operation);
        assert.equal(response.status, Number(operation.successStatus));
        const { requests } = (await control.get('/requests')).body;
        const { injections, self_check: selfCheck } = requests.at(-1).response;
        assert.deepEqual(selfCheck, [], `${operation.operationId} ${kind}: the injected body must pass open validation`);
        assert.deepEqual(contract.validate(operation.responses[operation.successStatus].schema, json, { open: true }), []);
        if (kind === 'field' && injections.length === 0) noField.push(operation.operationId);
        if (kind !== 'field') for (const injection of injections) reached[kind].add(`${operation.operationId}:${injection.pointer}`);
        for (const injection of injections) {
          const { kind: injected, value } = injection;
          if (injected === 'enum') assert.equal(value, UNKNOWN_ENUM_VALUE);
          if (injected === 'field') assert.ok(injection.pointer.endsWith(UNKNOWN_FIELD));
          if (injected === 'union') assert.ok(Object.values(value).includes(UNKNOWN_VARIANT));
        }
      }
    }
    assert.deepEqual(noField, [], 'every JSON response must take an unknown field');
    assert.ok(reached.enum.size > 100, `only ${reached.enum.size} enum sites`);
    assert.ok(reached.union.size > 20, `only ${reached.union.size} union sites`);
  });

  test('every open enum and open union in the contract is reached by some response', () => {
    const open = Object.entries(contract.schemas)
      .filter(([, schema]) => schema['x-rask-open-enum'] || schema['x-rask-open-union'])
      .map(([name]) => name);
    assert.equal(open.length, 89);
    const reached = new Set();
    for (const operation of jsonOperations) {
      const response = operation.responses[operation.successStatus];
      for (const example of Object.values(response.examples)) {
        for (const name of injectUnknowns(contract, response.schema, example, { enum: true, union: true }).reached) reached.add(name);
        for (const name of injectUnknowns(contract, response.schema, example, { enum: true }).reached) reached.add(name);
      }
    }
    assert.deepEqual(open.filter((name) => !reached.has(name)), []);
  });

  test('a job shows all three kinds', async () => {
    await control.post('/reset');
    await control.post('/script', { operationId: 'getJob', steps: [{ inject: true }] });
    const body = await (await fetch(`${harness.baseUrl}/jobs/j1`, { headers: AUTH })).json();
    assert.equal(body.params.type, UNKNOWN_VARIANT);
    assert.equal(body.status, UNKNOWN_ENUM_VALUE);
    assert.equal(body[UNKNOWN_FIELD], 'unknown field value');
  });

  test('injection fills a null that holds an open type', async () => {
    await control.post('/reset');
    await control.post('/jobs', { id: 'job-null', states: ['running'] });
    await control.post('/script', { operationId: 'getJob', steps: [{ inject: { union: true } }] });
    const body = await (await fetch(`${harness.baseUrl}/jobs/job-null`, { headers: AUTH })).json();
    assert.equal(body.result.type, UNKNOWN_VARIANT, 'result is null on a running job, and a union when set');
  });
});

describe('with no examples in the contract, bodies are built from the schemas', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rask-acceptance-'));
  const stripExamples = (node) => {
    if (Array.isArray(node)) return node.map(stripExamples);
    if (node === null || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).filter(([name]) => name !== 'examples').map(([name, value]) => [name, stripExamples(value)]));
  };
  const spec = JSON.parse(readFileSync(DEFAULT_SPEC, 'utf8'));
  const stripped = { ...spec, paths: Object.fromEntries(Object.entries(spec.paths).map(([path, item]) => {
    const operations = Object.entries(item).map(([method, operation]) => [method, {
      ...operation,
      responses: stripExamples(operation.responses),
      requestBody: operation.requestBody ? stripExamples(operation.requestBody) : undefined,
    }]);
    return [path, Object.fromEntries(operations)];
  })) };
  const specPath = join(directory, 'openapi.json');
  writeFileSync(specPath, JSON.stringify(stripped));
  const bare = new Contract(specPath);
  let server;
  before(async () => {
    server = new Harness({ port: 0, contract: bare });
    await server.start();
  });
  after(async () => {
    await server.stop();
    rmSync(directory, { recursive: true });
  });

  for (const operation of bare.operations) {
    test(operation.operationId, async () => {
      const { path, query, headers, body } = bare.sampleRequest(operation);
      const search = new URLSearchParams(query).toString();
      const response = await fetch(`${server.baseUrl}${fill(operation, path)}${search ? `?${search}` : ''}`, {
        method: operation.method,
        headers: { ...AUTH, ...headers, ...(body === null ? {} : { 'Content-Type': 'application/json' }) },
        body: body === null ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      assert.equal(response.status, Number(operation.successStatus), text.slice(0, 400));
      const { schema } = operation.responses[operation.successStatus];
      if (schema) assert.deepEqual(bare.validate(schema, JSON.parse(text)), []);
      const { requests } = (await fetch(`${server.controlUrl}/requests`).then((r) => r.json()));
      assert.deepEqual(requests.at(-1).response.self_check, []);
    });
  }

  test('job programs of every type still validate', async () => {
    for (const type of bare.schemas.JobType.enum) {
      for (const state of ['queued', 'running', 'succeeded', 'failed', 'canceled']) {
        const created = await fetch(`${server.controlUrl}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: `${type}-${state}`, type, states: [state] }) });
        assert.equal(created.status, 200, await created.text());
        const body = await (await fetch(`${server.baseUrl}/jobs/${type}-${state}`, { headers: AUTH })).json();
        assert.deepEqual(bare.validate({ $ref: '#/components/schemas/Job' }, body), [], `${type} ${state}`);
        assert.equal(body.status, state);
      }
    }
  });
});

test('contract/SOURCE.json describes this copy of the contract', () => {
  const source = JSON.parse(readFileSync(new URL('../contract/SOURCE.json', import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(readFileSync(DEFAULT_SPEC)).digest('hex'), source.sha256);
});

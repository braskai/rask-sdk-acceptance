// Follows one scenario over HTTP the way a language's test suite does: start, run the calls, check expect_sdk, verify.
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';

import { ReferenceClient } from './sdk.mjs';

export const controlClient = (harness) => {
  const send = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${harness.port}/__control${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    get: (path) => send('GET', path),
    post: (path, body = {}) => send('POST', path, body),
    delete: (path) => send('DELETE', path),
  };
};

const ok = (result) => {
  if (result.status !== 200) throw new Error(`Control call failed: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
};

const fillBytes = (content) => Buffer.from(Array.from({ length: content.size_bytes }, (_, index) => index % 256));

async function runCall(client, call, previous, operations) {
  const options = { path: call.path, query: call.query, body: call.body, if_match: call.if_match, idempotency_key: call.idempotency_key };
  if (call.op && !call.helper) return client.call(call.op, options);
  switch (call.helper) {
    case 'jobs.wait': {
      const jobId = call.job_id ?? previous[call.job_id_from_call].result.body.id;
      return client.waitJob(jobId, call.timeout_seconds ? { timeout_seconds: call.timeout_seconds } : {});
    }
    case 'uploads.upload_file': {
      const progress = [];
      const result = await client.uploadFile({
        filename: call.filename,
        content_type: call.content_type,
        bytes: fillBytes(call.content),
        source: call.source,
        on_progress: (bytes) => progress.push(bytes),
      });
      return { ...result, progress };
    }
    case 'iterate': {
      const items = [];
      for await (const item of client.iterate(call.op, options)) items.push(item);
      return { items };
    }
    case 'first_page':
      return client.call(call.op, options);
    case 'next_page': {
      const before = previous[call.after_call];
      return client.call('listProjects', { query: { limit: 2, cursor: before.result.body.next_cursor } });
    }
    case 'sweep_operations': {
      const results = {};
      for (const operation of operations.filter((candidate) => candidate.has_json_response)) {
        const { path, query, headers, body } = operation.sample;
        results[operation.operationId] = await client.call(operation.operationId, {
          path,
          query,
          body: body ?? undefined,
          if_match: headers['If-Match'],
        });
      }
      return { results };
    }
    default:
      throw new Error(`Unknown helper ${call.helper}`);
  }
}

const readPointer = (value, pointer) => {
  let node = value;
  for (const part of pointer.slice(1).split('/')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part.replaceAll('~1', '/')];
  }
  return node;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const errorClasses = (error) => {
  const names = [];
  for (let proto = Object.getPrototypeOf(error); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    names.push(proto.constructor.name);
  }
  return names;
};

function checkRaised(expectation, outcome, records) {
  const { error } = outcome ?? {};
  if (!error) return ['expected an error, the call returned'];
  const failures = [];
  if (expectation.error_class && !errorClasses(error).includes(expectation.error_class)) {
    failures.push(`expected ${expectation.error_class}, got ${errorClasses(error).join(' < ')}`);
  }
  if (expectation.status !== undefined && error.status !== expectation.status) {
    failures.push(`expected status ${expectation.status}, got ${error.status}`);
  }
  if (expectation.code !== undefined && error.code !== expectation.code) {
    failures.push(`expected code ${expectation.code}, got ${error.code}`);
  }
  for (const [name, value] of Object.entries(expectation.fields ?? {})) {
    const actual = name === 'retry_after' ? error.retry_after : error.problem?.[name];
    if (!same(actual, value)) failures.push(`expected ${name} ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`);
  }
  for (const name of expectation.present ?? []) {
    if (error.problem?.[name] === undefined) failures.push(`expected ${name} on the error`);
  }
  if (expectation.request_id_matches_wire) {
    const known = records.some((record) => record.response?.headers['X-Request-Id'] === error.request_id);
    if (!known) failures.push(`request_id ${error.request_id} is not an X-Request-Id the server sent`);
  }
  return failures;
}

function checkHeader(expectation, outcome, records) {
  const source = outcome.result ?? outcome.error;
  const value = source?.headers?.[expectation.name.toLowerCase()];
  if (value === undefined) return [`header ${expectation.name} is not exposed`];
  if (expectation.equals !== undefined && value !== expectation.equals) return [`header ${expectation.name}: expected ${expectation.equals}, got ${value}`];
  if (expectation.matches !== undefined && !new RegExp(expectation.matches).test(value)) return [`header ${expectation.name}: ${value} does not match ${expectation.matches}`];
  if (expectation.equals_field !== undefined && value !== readPointer(source.body, expectation.equals_field)) return [`header ${expectation.name} differs from ${expectation.equals_field}`];
  if (expectation.matches_wire && !records.some((record) => record.response?.headers[expectation.name] === value)) return [`header ${expectation.name} ${value} is not what the server sent`];
  return [];
}

function checkInjected(outcome, records) {
  const failures = [];
  const results = outcome.result?.results ?? null;
  for (const record of records) {
    const injections = record.response?.injections ?? [];
    if (injections.length === 0) continue;
    const body = results ? results[record.operationId]?.body : outcome.result?.body;
    for (const injection of injections) {
      const actual = injection.pointer === '/' ? body : readPointer(body, injection.pointer);
      if (!same(actual, injection.value)) failures.push(`${record.operationId} lost the ${injection.kind} injected at ${injection.pointer}`);
    }
  }
  if (!records.some((record) => record.response?.injections?.length)) failures.push('nothing was injected');
  return failures;
}

function checkLogs(expectation, client, records) {
  const logs = client.logs.join('\n');
  const failures = [];
  if (expectation.empty && logs !== '') failures.push(`expected no logs, got ${logs.slice(0, 200)}`);
  for (const text of expectation.must_contain ?? []) {
    if (!logs.includes(text)) failures.push(`logs do not contain ${text}`);
  }
  for (const text of expectation.must_not_contain ?? []) {
    if (logs.includes(text)) failures.push('logs contain a secret');
  }
  for (const { operationId, query } of expectation.must_not_contain_wire ?? []) {
    for (const record of records.filter((candidate) => candidate.operationId === operationId)) {
      if (logs.includes(record.raw_query_params[query])) failures.push(`logs contain ${query}`);
    }
  }
  return failures;
}

function checkExpectation(expectation, run, records) {
  const { client, constructError, calls } = run;
  const outcome = calls[expectation.call ?? calls.length - 1];
  switch (expectation.kind) {
    case 'returned':
      return outcome && !outcome.error ? [] : [`call ${expectation.call} raised: ${outcome?.error?.message}`];
    case 'returned_or_raised':
      return [];
    case 'raised':
      return checkRaised(expectation, outcome, records);
    case 'raised_before_network': {
      const error = constructError ?? calls[0]?.error;
      if (!error) return ['expected an error before any request'];
      return error.message.includes(expectation.message_contains) ? [] : [`error "${error.message}" does not mention ${expectation.message_contains}`];
    }
    case 'config':
      if (!client) return [`no client: ${constructError?.message}`];
      return same(client.config[expectation.field], expectation.equals) ? [] : [`config ${expectation.field} is ${client.config[expectation.field]}`];
    case 'repr_redacts': {
      if (!client) return [`no client: ${constructError?.message}`];
      const texts = [String(client), JSON.stringify(client), inspect(client, { showHidden: true, depth: 5 })];
      return texts.some((text) => text.includes(expectation.secret)) ? ['the key shows in the client representation'] : [];
    }
    case 'field': {
      const result = outcome?.result;
      if (!result) return [`call raised: ${outcome?.error?.message}`];
      if (expectation.raw_status !== undefined && result.status !== expectation.raw_status) return [`status is ${result.status}`];
      if (expectation.path === undefined) return [];
      const value = readPointer(result.body, expectation.path);
      if (expectation.present) return value === undefined ? [`${expectation.path} is missing`] : [];
      return same(value, expectation.equals) ? [] : [`${expectation.path} is ${JSON.stringify(value)}`];
    }
    case 'header_exposed':
      return checkHeader(expectation, outcome, records);
    case 'idempotency_key_exposed': {
      const source = outcome.result ?? outcome.error;
      const key = source?.idempotency_key;
      if (!key) return ['the key is not exposed'];
      if (expectation.equals !== undefined && key !== expectation.equals) return [`key is ${key}`];
      if (expectation.matches_wire && !records.some((record) => record.headers['idempotency-key'] === key)) return [`key ${key} was never sent`];
      return [];
    }
    case 'items': {
      const items = outcome?.result?.items;
      if (!items) return [`no items: ${outcome?.error?.message}`];
      if (expectation.count !== undefined && items.length !== expectation.count) return [`saw ${items.length} items, expected ${expectation.count}`];
      if (expectation.ids && !same(items.map((item) => item.id), expectation.ids)) return [`saw ids ${items.map((item) => item.id)}`];
      return [];
    }
    case 'pages': {
      const body = outcome?.result?.body;
      if (!body) return [`no page: ${outcome?.error?.message}`];
      if (body.data.length !== expectation.item_count) return [`page has ${body.data.length} items`];
      return body.has_more === expectation.has_more ? [] : [`has_more is ${body.has_more}`];
    }
    case 'warnings': {
      const failures = client.warnings.length === expectation.count ? [] : [`saw ${client.warnings.length} warnings, expected ${expectation.count}`];
      for (const [name, count] of Object.entries(expectation.per_operation ?? {})) {
        const seen = client.warnings.filter((warning) => warning === name).length;
        if (seen !== count) failures.push(`${name}: saw ${seen} warnings, expected ${count}`);
      }
      return failures;
    }
    case 'progress':
      return outcome?.result?.progress?.at(-1) === expectation.final_bytes ? [] : ['on_progress did not reach the file size'];
    case 'logs':
      return checkLogs(expectation, client, records);
    case 'injected_values_preserved':
      return checkInjected(outcome, records);
    case 'manual':
      return [];
    default:
      throw new Error(`Unknown expectation ${expectation.kind}`);
  }
}

export async function runScenario(harness, id, { faults = {}, lang = 'typescript' } = {}) {
  const control = controlClient(harness);
  const scenario = ok(await control.post(`/scenarios/${id}/start`, { lang }));
  const { operations } = ok(await control.get('/operations'));
  const run = { client: null, constructError: null, calls: [] };
  try {
    run.client = new ReferenceClient({ ...scenario.client, operations, faults });
  } catch (error) {
    run.constructError = error;
  }
  if (run.client) {
    for (const call of scenario.calls) {
      try {
        run.calls.push({ result: await runCall(run.client, call, run.calls, operations) });
      } catch (error) {
        run.calls.push({ error });
      }
    }
  }
  const { requests } = ok(await control.get('/requests'));
  const sdkFailures = scenario.expect_sdk.flatMap((expectation) => checkExpectation(expectation, run, requests));
  const verify = ok(await control.post(`/scenarios/${id}/verify`, {
    lang,
    sdk_passed: sdkFailures.length === 0,
    sdk_detail: sdkFailures.join('; '),
  }));
  return { scenario, verify, sdkFailures, wireFailures: verify.failures.filter((failure) => failure.check !== 'sdk'), requests };
}

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

// The control API's knobs, each against a real socket.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';

import { Harness } from '../src/harness.mjs';
import { controlClient } from './reference/runner.mjs';

let harness;
let control;
before(async () => {
  harness = new Harness({ port: 0 });
  await harness.start();
  control = controlClient(harness);
});
after(() => harness.stop());
beforeEach(() => control.post('/reset'));

const AUTH = { Authorization: 'Bearer raskai_test_key_test' };
const script = async (operationId, ...steps) => {
  const result = await control.post('/script', { operationId, steps });
  assert.equal(result.status, 200, JSON.stringify(result.body));
};
const getMe = () => fetch(`${harness.baseUrl}/me`, { headers: AUTH });
const lastRequest = async () => (await control.get('/requests')).body.requests.at(-1);

// A raw socket read, so a dropped connection shows as what it is rather than as a fetch error.
const rawGet = (path) => new Promise((resolve) => {
  const req = http.get(`${harness.baseUrl}${path}`, { headers: AUTH, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), completed: res.complete }));
    res.on('error', (error) => resolve({ status: res.statusCode, error: error.code, text: Buffer.concat(chunks).toString() }));
  });
  req.on('error', (error) => resolve({ error: error.code }));
});

describe('health and discovery', () => {
  test('health names the URLs and every endpoint', async () => {
    const { body } = await control.get('/health');
    assert.equal(body.ok, true);
    assert.equal(body.prefix, '/custom/prefix/v3');
    assert.equal(body.operations, 82);
    assert.equal(body.base_url, harness.baseUrl);
    assert.ok(body.other_base_url.startsWith('http://localhost:'));
    assert.ok(body.endpoints.includes('POST /__control/scenarios/{id}/start'));
  });

  test('operations carry a sample for table-driven tests', async () => {
    const { body } = await control.get('/operations?operationId=updateSegment');
    const [operation] = body.operations;
    assert.equal(operation.method, 'PATCH');
    assert.equal(operation.if_match, 'required');
    assert.equal(operation.idempotency_key, 'optional');
    assert.ok(operation.sample.path.project_id);
    assert.equal(operation.sample.headers['If-Match'], '"s-a197265875140819"');
    assert.ok(operation.sample.body);
    assert.equal((await control.get('/operations?operationId=nope')).status, 404);
    assert.equal((await control.get('/operations')).body.operations.length, 82);
  });

  test('an unknown control path says where to look', async () => {
    const result = await control.get('/nope');
    assert.equal(result.status, 404);
    assert.match(result.body.error, /health/);
    assert.equal((await control.delete('/health')).status, 405);
  });

  test('the control API stays outside the prefix', async () => {
    const response = await fetch(`${harness.baseUrl}/__control/health`, { headers: AUTH });
    assert.equal(response.status, 400);
  });
});

describe('recorded requests', () => {
  test('hold what an SDK test asserts on', async () => {
    await fetch(`${harness.baseUrl}/folders?`, {
      method: 'POST',
      headers: { ...AUTH, 'Idempotency-Key': 'k-1', 'Content-Type': 'application/json', 'User-Agent': 'ua/1' },
      body: JSON.stringify({ name: 'x' }),
    });
    const record = await lastRequest();
    assert.equal(record.listener, 'api');
    assert.equal(record.operationId, 'createFolder');
    assert.equal(record.method, 'POST');
    assert.equal(record.path, '/custom/prefix/v3/folders');
    assert.equal(record.headers['idempotency-key'], 'k-1');
    assert.equal(record.headers.authorization, AUTH.Authorization);
    assert.deepEqual(record.body, { name: 'x' });
    assert.equal(record.body_text, '{"name":"x"}');
    assert.equal(record.response.status, 201);
    assert.equal(record.response.body.object, 'folder');
    assert.ok(record.response.headers['X-Request-Id']);
    assert.ok(record.received_at_ms > 0);
    assert.deepEqual(record.violations, []);
  });

  test('filter by operationId, listener and since_seq, then clear', async () => {
    await getMe();
    await fetch(`${harness.baseUrl}/balance`, { headers: AUTH });
    const all = (await control.get('/requests')).body.requests;
    assert.equal(all.length, 2);
    assert.deepEqual((await control.get('/requests?operationId=getBalance')).body.requests.map((r) => r.operationId), ['getBalance']);
    assert.equal((await control.get('/requests?listener=other')).body.requests.length, 0);
    assert.equal((await control.get(`/requests?since_seq=${all[0].seq}`)).body.requests.length, 1);
    await control.delete('/requests');
    assert.equal((await control.get('/requests')).body.requests.length, 0);
  });
});

describe('scripted responses', () => {
  test('a status and problem body, then back to normal', async () => {
    await script('getMe', { status: 403, problem: 'insufficient_scope' });
    const first = await getMe();
    assert.equal(first.status, 403);
    assert.equal(first.headers.get('content-type'), 'application/problem+json');
    assert.equal((await first.json()).code, 'insufficient_scope');
    assert.equal((await getMe()).status, 200);
    assert.equal((await lastRequest()).response.scripted, false);
  });

  test('a problem code takes its status from the contract', async () => {
    await script('getMe', { problem: 'insufficient_balance' });
    const response = await getMe();
    assert.equal(response.status, 402);
    assert.equal((await response.json()).required_minutes, 1);
  });

  test('a code the contract does not know needs a status, and validates as a Problem', async () => {
    const refused = await control.post('/script', { operationId: 'getMe', steps: [{ problem: 'brand_new' }] });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /give it a status/);
    await script('getMe', { problem: 'brand_new', status: 409 });
    const response = await getMe();
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'brand_new');
    assert.deepEqual((await lastRequest()).response.self_check, []);
  });

  test('patch overrides fields of a problem', async () => {
    await script('getMe', { problem: 'precondition_failed', patch: { current_etag: '"s-new"' } });
    assert.equal((await (await getMe()).json()).current_etag, '"s-new"');
  });

  test('Retry-After: set, defaulted on 429 and 503, and left out on request', async () => {
    await script('getMe', { problem: 'rate_limited', retry_after: 7 }, { problem: 'rate_limited' }, { status: 503 }, { status: 503, retry_after: null });
    assert.equal((await getMe()).headers.get('retry-after'), '7');
    assert.equal((await getMe()).headers.get('retry-after'), '1');
    assert.equal((await getMe()).headers.get('retry-after'), '1');
    assert.equal((await getMe()).headers.get('retry-after'), null);
  });

  test('repeat counts, and repeat forever', async () => {
    await script('getMe', { status: 500, repeat: 2 });
    assert.equal((await getMe()).status, 500);
    assert.equal((await getMe()).status, 500);
    assert.equal((await getMe()).status, 200);
    await script('getMe', { status: 500, repeat: 'forever' });
    for (let index = 0; index < 3; index += 1) assert.equal((await getMe()).status, 500);
  });

  test('append adds to the queue; "*" applies to every operation', async () => {
    await script('getMe', { status: 500 });
    await control.post('/script', { operationId: 'getMe', steps: [{ status: 501 }], append: true });
    assert.equal((await getMe()).status, 500);
    assert.equal((await getMe()).status, 501);
    await script('*', { status: 502, repeat: 'forever' });
    assert.equal((await getMe()).status, 502);
    assert.equal((await fetch(`${harness.baseUrl}/balance`, { headers: AUTH })).status, 502);
  });

  test('502 and 504 default to an HTML body, as a gateway sends', async () => {
    await script('getMe', { status: 502 });
    const response = await getMe();
    assert.equal(response.headers.get('content-type'), 'text/html');
    assert.match(await response.text(), /Bad Gateway/);
  });

  test('raw body with a chosen content type', async () => {
    await script('getMe', { status: 404, raw: 'nope', content_type: 'text/plain' });
    const response = await getMe();
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'nope');
  });

  test('a delay holds the response', async () => {
    await script('getMe', { delay_ms: 300 });
    const started = Date.now();
    assert.equal((await getMe()).status, 200);
    assert.ok(Date.now() - started >= 290);
  });

  test('a connection drop, before the headers', async () => {
    await script('getMe', { drop: true });
    const result = await rawGet('/me');
    assert.equal(result.error, 'ECONNRESET');
    assert.equal((await lastRequest()).response.dropped, 'before_headers');
    assert.equal((await rawGet('/me')).status, 200, 'the next request is served');
  });

  test('a connection drop in mid-body', async () => {
    await script('getMe', { drop: 'mid_body' });
    const result = await rawGet('/me');
    assert.equal(result.status, 200);
    assert.ok(result.error === 'ECONNRESET' || result.completed === false, JSON.stringify(result).slice(0, 200));
    assert.ok(result.text.length > 0);
  });

  test('a Deprecation header set', async () => {
    await script('getMe', { deprecation: true });
    const response = await getMe();
    assert.match(response.headers.get('deprecation'), /^@\d+$/);
    assert.ok(response.headers.get('sunset'));
    assert.match(response.headers.get('link'), /rel="deprecation"/);
  });

  test('custom headers', async () => {
    await script('createFolder', { headers: { 'Idempotent-Replayed': 'true' } });
    const response = await fetch(`${harness.baseUrl}/folders`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
    assert.equal(response.headers.get('idempotent-replayed'), 'true');
  });

  test('a named example', async () => {
    await script('getJob', { example: 'running' });
    assert.equal((await (await fetch(`${harness.baseUrl}/jobs/j1`, { headers: AUTH })).json()).status, 'running');
    assert.equal((await (await fetch(`${harness.baseUrl}/jobs/j1`, { headers: AUTH })).json()).status, 'succeeded', 'an unprogrammed job is terminal by default');
  });

  test('typos and invalid bodies are refused at the control call', async () => {
    const typo = await control.post('/script', { operationId: 'getMe', steps: [{ retry_afterr: 1 }] });
    assert.equal(typo.status, 400);
    assert.match(typo.body.error, /unknown field "retry_afterr"/);
    const operation = await control.post('/script', { operationId: 'getMee', steps: [{}] });
    assert.equal(operation.status, 400);
    assert.match(operation.body.error, /Unknown operationId/);
    const body = await control.post('/script', { operationId: 'getMe', steps: [{ body: { object: 'me' } }] });
    assert.equal(body.status, 400);
    assert.match(body.body.error, /does not validate.*off_contract/);
    const example = await control.post('/script', { operationId: 'getMe', steps: [{ example: 'nope' }] });
    assert.match(example.body.error, /no example "nope"/);
    const drop = await control.post('/script', { operationId: 'getMe', steps: [{ drop: 'sometimes' }] });
    assert.match(drop.body.error, /drop must be/);
    const inject = await control.post('/script', { operationId: 'getMe', steps: [{ inject: { enums: true } }] });
    assert.match(inject.body.error, /inject has no field "enums"/);
    const job = await control.post('/script', { operationId: 'createDub', steps: [{ job: 'nope' }] });
    assert.match(job.body.error, /no job program/);
  });

  test('off_contract lets a deliberately wrong body through', async () => {
    await script('getMe', { body: { object: 'me' }, off_contract: true });
    assert.deepEqual(await (await getMe()).json(), { object: 'me' });
    assert.deepEqual((await lastRequest()).response.self_check, []);
  });

  test('the script can be read back, and reset clears everything', async () => {
    await script('getMe', { status: 500 });
    assert.equal((await control.get('/script')).body.getMe.length, 1);
    await control.post('/jobs', { id: 'job-x', states: ['running'] });
    await control.post('/reset');
    assert.deepEqual((await control.get('/script')).body, {});
    assert.equal((await control.get('/jobs/job-x')).status, 404);
    assert.equal((await getMe()).status, 200);
  });
});

describe('redirects and the other host', () => {
  test('a redirect points at the other listener, which keeps the operation and records the request', async () => {
    await script('getMe', { redirect: 'other' });
    const first = await fetch(`${harness.baseUrl}/me`, { headers: AUTH, redirect: 'manual' });
    assert.equal(first.status, 307);
    const location = first.headers.get('location');
    assert.ok(location.startsWith(harness.otherBaseUrl));
    const second = await fetch(location);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).object, 'me');
    const [record] = (await control.get('/requests?listener=other')).body.requests;
    assert.equal(record.operationId, 'getMe');
    assert.equal(record.headers.authorization, undefined);
  });

  test('the other host has another name and port, so a client treats it as cross-host', async () => {
    const api = new URL(harness.baseUrl);
    const other = new URL(harness.otherBaseUrl);
    assert.notEqual(api.hostname, other.hostname);
    assert.notEqual(api.port, other.port);
  });

  test('the other host answers its own health check, unrecorded, and records anything else', async () => {
    assert.equal((await fetch(`${harness.otherBaseUrl}/__other/health`)).status, 200);
    assert.equal((await control.get('/requests')).body.requests.length, 0);
    assert.equal((await fetch(`${harness.otherBaseUrl}/anything?x=1`, { headers: AUTH })).status, 200);
    const [record] = (await control.get('/requests')).body.requests;
    assert.equal(record.listener, 'other');
    assert.equal(record.path, '/anything');
    assert.equal(record.headers.authorization, AUTH.Authorization);
  });

  test('Authorization at the other host fails verify, in any scenario', async () => {
    await control.post('/scenarios/S14.language-markers/start', {});
    await fetch(`${harness.otherBaseUrl}/anything`, { headers: AUTH });
    const { body } = await control.post('/scenarios/S14.language-markers/verify', {});
    assert.equal(body.pass, false);
    assert.ok(body.failures.some((failure) => failure.check === 'key_leak'));
  });

  test('a redirect to a chosen URL', async () => {
    await script('getMe', { redirect: { to: 'https://elsewhere.invalid/x', status: 302 } });
    const response = await fetch(`${harness.baseUrl}/me`, { headers: AUTH, redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://elsewhere.invalid/x');
  });
});

describe('the upload target', () => {
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
  const create = async (step) => {
    if (step) await script('createUpload', step);
    const response = await fetch(`${harness.baseUrl}/uploads`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'a b.mp4', content_type: 'video/mp4', size_bytes: bytes.length }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location').startsWith('/v3/uploads/'), true);
    return response.json();
  };
  const put = (upload, headers = {}, body = bytes, url = upload.transfer.url) => fetch(url, {
    method: 'PUT',
    headers: { ...upload.transfer.headers, ...headers },
    body,
  });
  const complete = (upload) => fetch(`${harness.baseUrl}/uploads/${upload.id}/complete`, { method: 'POST', headers: { ...AUTH, 'Idempotency-Key': 'k-1' } });

  test('createUpload signs the request\'s Content-Type and length, on the other host', async () => {
    const upload = await create();
    assert.equal(upload.status, 'pending');
    assert.equal(upload.filename, 'a b.mp4');
    assert.ok(upload.transfer.url.startsWith(`${harness.otherBaseUrl}/storage/${upload.id}/`));
    assert.match(upload.transfer.url, /X-Amz-Signature=[0-9a-f]{64}/);
    assert.deepEqual(upload.transfer.headers, { 'Content-Type': 'video/mp4', 'Content-Length': '4096' });
  });

  test('a correct PUT succeeds, and completeUpload starts a media_import job', async () => {
    const upload = await create();
    const response = await put(upload);
    assert.equal(response.status, 200);
    const record = await lastRequest();
    assert.equal(record.operationId, '__storage_put');
    assert.equal(record.body_bytes, 4096);
    assert.equal(record.body_sha256, createHash('sha256').update(bytes).digest('hex'));
    const completed = await complete(upload);
    assert.equal(completed.status, 202);
    const job = await completed.json();
    assert.equal(job.type, 'media_import');
    assert.equal(job.params.upload_id, upload.id);
    assert.equal(completed.headers.get('location'), `/v3/jobs/${job.id}`);
    const read = await (await fetch(`${harness.baseUrl}/uploads/${upload.id}`, { headers: AUTH })).json();
    assert.equal(read.status, 'completed');
    assert.equal(read.transfer, null);
    assert.equal(read.import_job_id, job.id);
  });

  test('completeUpload before the PUT is 409 upload_incomplete', async () => {
    const upload = await create();
    const response = await complete(upload);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'upload_incomplete');
  });

  test('Authorization fails the PUT, the way S3 refuses two auth mechanisms', async () => {
    const upload = await create();
    const response = await put(upload, AUTH);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Only one auth mechanism/);
    const record = await lastRequest();
    assert.match(record.violations[0].detail, /must not carry Authorization/);
    assert.equal((await complete(upload)).status, 409);
  });

  test('another Content-Type fails the signature', async () => {
    const upload = await create();
    const response = await put(upload, { 'Content-Type': 'application/octet-stream' });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /SignatureDoesNotMatch/);
    assert.match((await lastRequest()).violations[0].detail, /URL signs video\/mp4/);
  });

  test('another length fails the signature', async () => {
    const upload = await create();
    const response = await put(upload, { 'Content-Length': '10' }, bytes.subarray(0, 10));
    assert.equal(response.status, 403);
    assert.match((await lastRequest()).violations[0].detail, /URL signs 4096/);
  });

  test('a chunked PUT has no signed length', async () => {
    const upload = await create();
    const url = new URL(upload.transfer.url);
    const status = await new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.write(bytes);
      req.end();
    });
    assert.equal(status, 411);
  });

  test('a re-encoded query string fails the signature', async () => {
    const upload = await create();
    const response = await put(upload, {}, bytes, `${upload.transfer.url}&extra=1`);
    assert.equal(response.status, 403);
    assert.match((await lastRequest()).violations[0].detail, /used verbatim/);
  });

  test('an unknown path fails', async () => {
    const response = await fetch(`${harness.otherBaseUrl}/storage/nope/1/a.mp4?x=1`, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: 'x' });
    assert.equal(response.status, 404);
  });

  test('a URL expired at creation: past expires_at, refused, and getUpload re-signs', async () => {
    const upload = await create({ upload: { expired: true } });
    assert.ok(Date.parse(upload.transfer.expires_at) < Date.now());
    const response = await put(upload);
    assert.equal(response.status, 403);
    assert.match(await response.text(), /Request has expired/);
    const read = await (await fetch(`${harness.baseUrl}/uploads/${upload.id}`, { headers: AUTH })).json();
    assert.notEqual(read.transfer.url, upload.transfer.url);
    assert.ok(Date.parse(read.transfer.expires_at) > Date.now());
    assert.equal((await put(read)).status, 200);
    assert.equal((await complete(read)).status, 202);
  });

  test('a URL that expires in flight stays dead', async () => {
    await script('__storage_put', { expired: true });
    const upload = await create();
    assert.equal((await put(upload)).status, 403);
    assert.equal((await put(upload)).status, 403);
    const { body } = await control.get(`/uploads/${upload.id}`);
    assert.deepEqual(body.expired_generations, [1]);
  });

  test('scripted storage failures, in order, and a drop', async () => {
    await script('__storage_put', { status: 503 }, { drop: true }, { status: 500, raw: 'boom', content_type: 'text/plain' });
    const upload = await create();
    assert.equal((await put(upload)).status, 503);
    await assert.rejects(() => put(upload));
    assert.equal((await put(upload)).status, 500);
    assert.equal((await put(upload)).status, 200);
    assert.equal((await complete(upload)).status, 202);
  });

  test('a storage step refuses fields only the API takes', async () => {
    const refused = await control.post('/script', { operationId: '__storage_put', steps: [{ problem: 'internal_error' }] });
    assert.equal(refused.status, 400);
  });
});

describe('scenario control', () => {
  test('start resets, runs the setup and returns the filled-in scenario', async () => {
    await script('getBalance', { status: 500 });
    const { status, body } = await control.post('/scenarios/S3.retry-429-honours-retry-after/start', { lang: 'php' });
    assert.equal(status, 200);
    assert.equal(body.applies, true);
    assert.equal(body.client.args.base_url, harness.baseUrl);
    assert.match(body.client.args.api_key, /^raskai_test_key_.{49}$/);
    assert.deepEqual(Object.keys((await control.get('/script')).body), ['getMe']);
  });

  test('verify reports failures with what it saw', async () => {
    await control.post('/scenarios/S1.key-argument/start', {});
    const { body } = await control.post('/scenarios/S1.key-argument/verify', { lang: 'go' });
    assert.equal(body.pass, false);
    assert.match(body.failures[0].message, /saw 0 request/);
  });

  test('verify counts contract violations, whatever the scenario asserts', async () => {
    await control.post('/scenarios/S14.language-markers/start', {});
    await fetch(`${harness.baseUrl}/me?nope=1`, { headers: AUTH });
    const { body } = await control.post('/scenarios/S14.language-markers/verify', {});
    assert.ok(body.failures.some((failure) => failure.check === 'contract'));
  });

  test('an unknown scenario is a 404; a scenario for another language says so', async () => {
    assert.equal((await control.post('/scenarios/nope/start', {})).status, 404);
    assert.equal((await control.post('/scenarios/S17.browser-refused/start', { lang: 'go' })).body.applies, false);
    const { body } = await control.get('/scenarios?lang=go');
    assert.equal(body.scenarios.find((scenario) => scenario.id === 'S17.browser-refused').applies, false);
    assert.equal(body.scenarios.find((scenario) => scenario.id === 'S8.webhooks-unwrap').status, 'later');
  });
});

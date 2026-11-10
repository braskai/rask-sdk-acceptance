// What the harness refuses, and how clearly it says so.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { Harness } from '../src/harness.mjs';
import { controlClient } from './reference/runner.mjs';

let harness;
let control;
before(async () => {
  harness = new Harness({ port: 0, prefix: '/custom/prefix/v3' });
  await harness.start();
  control = controlClient(harness);
});
after(() => harness.stop());

const AUTH = { Authorization: 'Bearer raskai_test_key_test' };
const JSON_HEADERS = { ...AUTH, 'Content-Type': 'application/json' };
const FOLDER = JSON.stringify({ name: 'x' });

const refused = async (path, init, pointer, pattern) => {
  const response = await fetch(`http://127.0.0.1:${harness.port}${path}`, init);
  const text = await response.text();
  assert.equal(response.status, 400, text);
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
  const body = JSON.parse(text);
  assert.equal(body.code, 'contract_violation');
  assert.equal(body.retryable, false);
  assert.equal(body.retry, 'none');
  const match = body.errors.find((error) => error.pointer === pointer);
  assert.ok(match, `no error at ${pointer}: ${text}`);
  assert.match(match.detail, pattern);
  const { requests } = (await control.get('/requests')).body;
  assert.ok(requests.at(-1).violations.some((violation) => violation.pointer === pointer), 'the violation must be recorded');
};

const API = '/custom/prefix/v3';

describe('paths', () => {
  test('outside the prefix, naming the likely cause', () => refused('/me', { headers: AUTH }, 'path', /outside the API prefix .*dropped the base URL/));
  test('a /v3 link resolved against the origin', () => refused('/v3/jobs/x', { headers: AUTH }, 'path', /outside the API prefix .*Location or links/));
  test('double slash', () => refused(`${API}//me`, { headers: AUTH }, 'path', /empty segment/));
  test('trailing slash', () => refused(`${API}/me/`, { headers: AUTH }, 'path', /ends in "\/"/));
  test('/v3 appended to a base URL that has it', () => refused(`${API}/v3/me`, { headers: AUTH }, 'path', /repeats \/v3/));
  test('unknown path', () => refused(`${API}/nope`, { headers: AUTH }, 'path', /No contract path/));
  test('wrong method', () => refused(`${API}/me`, { method: 'POST', headers: AUTH }, 'path', /has no POST/));
  test('path parameter against its schema', () => refused(`${API}/projects/p/speakers/SPEAKER_X`, { headers: AUTH }, 'path:speaker_id', /must match/));
  test('integer path parameter', () => refused(`${API}/projects/p/transcript/versions/seven`, { headers: AUTH }, 'path:version_number', /must be integer/));

  test('an encoded path parameter is decoded and accepted', async () => {
    const response = await fetch(`http://127.0.0.1:${harness.port}${API}/projects/a%2Fb`, { headers: AUTH });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, 'a/b');
  });

  test('a literal segment beats a parameter', async () => {
    const response = await fetch(`http://127.0.0.1:${harness.port}${API}/voice-clones/quota`, { headers: AUTH });
    assert.equal(response.status, 200);
    const { requests } = (await control.get('/requests')).body;
    assert.equal(requests.at(-1).operationId, 'getVoiceCloneQuota');
  });
});

describe('query', () => {
  test('unknown parameter', () => refused(`${API}/me?nope=1`, { headers: AUTH }, 'query:nope', /no query parameter "nope"/));
  test('wrong type', () => refused(`${API}/projects?limit=abc`, { headers: AUTH }, 'query:limit', /must be integer/));
  test('above the maximum', () => refused(`${API}/projects?limit=101`, { headers: AUTH }, 'query:limit', /<= 100/));
  test('closed enum in a request', () => refused(`${API}/jobs?channel=carrier_pigeon`, { headers: AUTH }, 'query:channel', /must be one of/));
  test('wait_seconds above 20', () => refused(`${API}/jobs/j?wait_seconds=21`, { headers: AUTH }, 'query:wait_seconds', /<= 20/));
  test('an array repeated instead of comma-separated', () => refused(`${API}/projects?ids=a&ids=b`, { headers: AUTH }, 'query:ids', /comma-separated/));
  test('array item against its enum', () => refused(`${API}/jobs?status=running,nope`, { headers: AUTH }, 'query:status/1', /must be one of/));
  test('array above maxItems', () => refused(`${API}/jobs?status=queued,running,succeeded,failed,canceled,queued`, { headers: AUTH }, 'query:status', /at most 5/));
  test('a required parameter missing', () => refused(`${API}/voices`, { headers: AUTH }, 'query:target_language', /requires the query parameter/));

  test('accepts a comma list, encoded commas included, like the real server', async () => {
    for (const ids of ['a,b', 'a%2Cb']) {
      const response = await fetch(`http://127.0.0.1:${harness.port}${API}/projects?ids=${ids}&limit=5&order=asc`, { headers: AUTH });
      assert.equal(response.status, 200);
    }
  });

  test('a key in the query string is 400 token_in_query, as the contract says', async () => {
    const response = await fetch(`http://127.0.0.1:${harness.port}${API}/me?api_key=secret`, { headers: AUTH });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, 'token_in_query');
    assert.equal(body.parameter, 'api_key');
    const { requests } = (await control.get('/requests')).body;
    assert.equal(requests.at(-1).violations.at(-1).code, 'token_in_query');
  });
});

describe('required headers', () => {
  test('Idempotency-Key where required', () => refused(`${API}/projects/p/dub`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ mode: 'auto', expected_cost_minutes: 1 }) }, 'header:Idempotency-Key', /createDub requires Idempotency-Key/));
  test('Idempotency-Key too long', () => refused(`${API}/folders`, { method: 'POST', headers: { ...JSON_HEADERS, 'Idempotency-Key': 'k'.repeat(256) }, body: FOLDER }, 'header:Idempotency-Key', /at most 255/));
  test('Idempotency-Key on a GET', () => refused(`${API}/me`, { headers: { ...AUTH, 'Idempotency-Key': 'k' } }, 'header:Idempotency-Key', /does not take/));
  test('Idempotency-Key on an ordinary DELETE', () => refused(`${API}/projects/p`, { method: 'DELETE', headers: { ...AUTH, 'Idempotency-Key': 'k' } }, 'header:Idempotency-Key', /does not take/));
  test('If-Match where required', () => refused(`${API}/projects/p/segments/s`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ translation_text: 'x' }) }, 'header:If-Match', /requires If-Match/));
  test('If-Match wildcard', () => refused(`${API}/projects/p/segments/s`, { method: 'PATCH', headers: { ...JSON_HEADERS, 'If-Match': '*' }, body: JSON.stringify({ translation_text: 'x' }) }, 'header:If-Match', /forbidden/));
  test('If-Match without quotes', () => refused(`${API}/projects/p/segments/s`, { method: 'PATCH', headers: { ...JSON_HEADERS, 'If-Match': 's-1' }, body: JSON.stringify({ translation_text: 'x' }) }, 'header:If-Match', /quotes included/));
  test('If-Match where the contract takes none', () => refused(`${API}/projects/p/segments`, { method: 'POST', headers: { ...JSON_HEADERS, 'If-Match': '"s-1"', 'Idempotency-Key': 'k' }, body: JSON.stringify({ start_seconds: 1, end_seconds: 2, speaker_id: 'SPEAKER_00', source_text: 'x' }) }, 'header:If-Match', /does not take/));
});

describe('authentication', () => {
  test('no Authorization is 401 authentication_required', async () => {
    const response = await fetch(`http://127.0.0.1:${harness.port}${API}/me`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'authentication_required');
    assert.ok(response.headers.get('www-authenticate'));
    const { requests } = (await control.get('/requests')).body;
    assert.equal(requests.at(-1).violations[0].pointer, 'header:Authorization');
  });

  test('another scheme is 401 invalid_token', async () => {
    const response = await fetch(`http://127.0.0.1:${harness.port}${API}/me`, { headers: { Authorization: 'Token abc' } });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'invalid_token');
  });
});

describe('bodies', () => {
  const post = (body, headers = JSON_HEADERS) => ({ method: 'POST', headers, body });
  test('missing where required', () => refused(`${API}/folders`, { method: 'POST', headers: AUTH }, 'body', /requires a JSON body/));
  test('sent where none is allowed', () => refused(`${API}/jobs/j/cancel`, post('{}'), 'body', /takes no request body/));
  test('not JSON', () => refused(`${API}/folders`, post('{nope'), 'body', /not valid JSON/));
  test('wrong Content-Type', () => refused(`${API}/folders`, post(FOLDER, { ...AUTH, 'Content-Type': 'text/plain' }), 'header:Content-Type', /application\/json/));
  test('unknown field', () => refused(`${API}/folders`, post(JSON.stringify({ name: 'x', color: 'red' })), '/color', /not in the contract/));
  test('null, which requests never send', () => refused(`${API}/projects/p`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name: null }) }, '/name', /must be string, got null/));
  test('required field missing', () => refused(`${API}/uploads`, post(JSON.stringify({ filename: 'a.mp4' })), '/content_type', /required/));
  test('closed enum', () => refused(`${API}/uploads`, post(JSON.stringify({ filename: 'a', content_type: 'text/plain', size_bytes: 1 })), '/content_type', /must be one of/));
  test('below the minimum', () => refused(`${API}/uploads`, post(JSON.stringify({ filename: 'a', content_type: 'video/mp4', size_bytes: 0 })), '/size_bytes', />= 1/));
  test('minProperties on a PATCH', () => refused(`${API}/folders/f`, { method: 'PATCH', headers: JSON_HEADERS, body: '{}' }, '/', /at least 1 properties/));
  test('union with an unknown variant in a request', () => refused(`${API}/projects/p/exports`, { method: 'POST', headers: { ...JSON_HEADERS, 'Idempotency-Key': 'k' }, body: JSON.stringify({ type: 'nope' }) }, '/type', /must be one of/));
  test('over the size cap', () => refused(`${API}/folders`, post(JSON.stringify({ name: 'x'.repeat(1024 * 1024 + 1) })), 'body', /at most 1048576 bytes/));

  test('an empty string clears: it is valid', async () => {
    const response = await fetch(`http://127.0.0.1:${harness.port}${API}/projects/p`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ folder_id: '' }) });
    assert.equal(response.status, 200);
  });

  test('an optional body may be left out', async () => {
    const response = await fetch(`http://127.0.0.1:${harness.port}${API}/uploads/u/complete`, { method: 'POST', headers: { ...AUTH, 'Idempotency-Key': 'k' } });
    assert.equal(response.status, 202);
  });
});

describe('a violation does not use up a scripted step', () => {
  test('the next valid request still gets it', async () => {
    await control.post('/reset');
    await control.post('/script', { operationId: 'getMe', steps: [{ status: 500 }] });
    assert.equal((await fetch(`http://127.0.0.1:${harness.port}${API}/me?nope=1`, { headers: AUTH })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${harness.port}${API}/me`, { headers: AUTH })).status, 500);
  });
});

describe('another prefix', () => {
  test('--prefix /v3 and an empty prefix both serve the API', async () => {
    for (const prefix of ['/v3', '/', '/gw/rask/']) {
      const other = new Harness({ port: 0, prefix, contract: harness.contract });
      await other.start();
      try {
        const expected = prefix.replace(/\/+$/, '');
        assert.equal(other.prefix, expected);
        const response = await fetch(`http://127.0.0.1:${other.port}${expected}/me`, { headers: AUTH });
        assert.equal(response.status, 200);
      } finally {
        await other.stop();
      }
    }
  });

  test('a prefix under /__control is refused', () => {
    assert.throws(() => new Harness({ port: 0, prefix: '/__control/x', contract: harness.contract }), /outside \/__control/);
  });
});

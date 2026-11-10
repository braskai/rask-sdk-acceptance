import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { Contract } from '../src/contract.mjs';
import { DEFAULT_SCENARIOS, DEFAULT_SPEC, Harness } from '../src/harness.mjs';
import { ScenarioList, lintScenarios } from '../src/scenarios.mjs';
import { controlClient, runScenario } from './reference/runner.mjs';
import { ConfigError, ReferenceClient } from './reference/sdk.mjs';

const contract = new Contract(DEFAULT_SPEC);
const list = new ScenarioList(DEFAULT_SCENARIOS);
const RUN_SLOW = process.env.RUN_SLOW === '1';

const withHarness = async (fn, options = {}) => {
  const harness = new Harness({ port: 0, contract, ...options });
  await harness.start();
  try {
    return await fn(harness);
  } finally {
    await harness.stop();
  }
};

describe('the scenario list as data', () => {
  test('lints clean', () => {
    assert.deepEqual(lintScenarios(list, contract), []);
  });

  test('covers S1-S17 and the base URL requirement', () => {
    const design = new Set(list.scenarios.flatMap((scenario) => scenario.design));
    for (let index = 1; index <= 17; index += 1) assert.ok(design.has(`S${index}`), `S${index} has no scenario`);
    for (const id of ['BU1.path-prefix', 'BU2.trailing-slash', 'BU3.env-var', 'BU5.no-key-on-redirect-get', 'BU6.presigned-put-no-authorization']) {
      assert.ok(list.byId.has(id), `${id} is missing`);
    }
  });

  test('names the five languages, and S17 only applies to TypeScript', () => {
    assert.deepEqual(list.data.defaults.languages, ['go', 'python', 'typescript', 'php', 'java']);
    assert.deepEqual(list.byId.get('S17.browser-refused').languages, ['typescript']);
    assert.equal(list.byId.get('S8.webhooks-unwrap').status, 'later');
  });

  test('every setup is accepted by the control API', async () => {
    await withHarness(async (harness) => {
      const control = controlClient(harness);
      for (const scenario of list.scenarios) {
        const result = await control.post(`/scenarios/${scenario.id}/start`, { lang: 'go' });
        assert.equal(result.status, 200, `${scenario.id}: ${JSON.stringify(result.body)}`);
      }
    });
  });
});

describe('a correct SDK passes every scenario', { concurrency: 8 }, () => {
  for (const scenario of list.scenarios) {
    if ((scenario.status ?? 'active') !== 'active') continue;
    test(scenario.id, { skip: scenario.slow && !RUN_SLOW ? 'slow: set RUN_SLOW=1' : false }, async () => {
      await withHarness(async (harness) => {
        const { verify, sdkFailures } = await runScenario(harness, scenario.id);
        assert.deepEqual(verify.failures, [], JSON.stringify(verify.failures, null, 2));
        assert.deepEqual(sdkFailures, []);
      });
    });
  }
});

// If a scenario passes whatever the SDK does, it tests nothing. Each row breaks one behaviour and names a scenario that
// must catch it. `by` says which side has to see it: the wire checks (harness) or the SDK-side expectations.
const FAULTS = [
  ['wrongAuthScheme', 'S1.key-argument', 'wire'],
  ['ignoreEnvKey', 'S1.key-env', 'wire'],
  ['envKeyBeatsArgument', 'S1.argument-beats-env', 'wire'],
  ['noKeyCheck', 'S1.key-missing', 'wire'],
  ['keyInRepr', 'S1.key-redacted', 'sdk'],
  ['wrongDefaultBaseUrl', 'S2.default-base-url', 'sdk'],
  ['dropPrefix', 'BU1.path-prefix', 'wire'],
  ['appendV3', 'BU1.path-prefix', 'wire'],
  ['keepTrailingSlash', 'BU2.trailing-slash', 'wire'],
  ['keepTrailingSlash', 'BU3.env-var-trailing-slash', 'wire'],
  ['ignoreEnvBaseUrl', 'BU3.env-var', 'sdk'],
  ['envBeatsArgument', 'BU4.argument-beats-env', 'wire'],
  ['keepAuthOnRedirect', 'BU5.no-key-on-redirect-get', 'wire'],
  ['keepAuthOnRedirect', 'BU5.no-key-on-redirect-post', 'wire'],
  ['authOnPut', 'BU6.presigned-put-no-authorization', 'wire'],
  ['linksFromOrigin', 'BU7.path-absolute-links-under-prefix', 'wire'],
  ['noRetry', 'S3.retry-429-honours-retry-after', 'wire'],
  ['ignoreRetryAfter', 'S3.retry-429-honours-retry-after', 'wire'],
  ['noRetry', 'S3.retry-502-503-504', 'wire'],
  ['noBackoff', 'S3.retry-502-503-504', 'wire'],
  ['noRetry', 'S3.retry-connection-errors', 'wire'],
  ['noRetry', 'S3.retry-timeout', 'wire'],
  ['rotateKeyOnRetry', 'S3.retry-post-same-key', 'wire'],
  ['noRetry', 'S3.retry-delete', 'wire'],
  ['retry500', 'S3.no-retry-500', 'wire'],
  ['retry409', 'S3.no-retry-409-state', 'wire'],
  ['noRetry', 'S3.key-in-use-retried', 'wire'],
  ['tooManyInUseRetries', 'S3.key-in-use-gives-up', 'wire'],
  ['noIdempotencyKey', 'S4.key-is-uuid4', 'wire'],
  ['fixedKey', 'S4.key-is-uuid4', 'wire'],
  ['fixedKey', 'S4.key-fresh-per-call', 'wire'],
  ['rotateKeyOnRetry', 'S4.key-stable-across-retries', 'wire'],
  ['rotateKeyOnRetry', 'S4.delete-segment-keyed', 'wire'],
  ['noIdempotencyKey', 'S4.required-key-operations', 'wire'],
  ['ignoreCallerKey', 'S4.caller-override', 'wire'],
  ['keyNotExposed', 'S4.key-exposed-on-results-and-errors', 'sdk'],
  ['pagingIgnoresCursor', 'S5.auto-paging', 'wire'],
  ['pagingStopsOnShortPage', 'S5.short-and-empty-pages', 'wire'],
  ['pagingLosesFilters', 'S5.filters-kept', 'wire'],
  ['pageTruncates', 'S5.page-level-access', 'sdk'],
  ['pagingOneTooMany', 'S5.last-page-stops', 'wire'],
  ['waitWithoutLongPoll', 'S6.wait-succeeds', 'wire'],
  ['ignoreRetryAfter', 'S6.wait-succeeds', 'wire'],
  ['noRetry', 'S6.survives-retryable-errors', 'wire'],
  ['waitIgnoresFailure', 'S6.wait-failed', 'sdk'],
  ['waitIgnoresFailure', 'S6.wait-canceled', 'sdk'],
  ['waitCancelsOnTimeout', 'S6.wait-timeout', 'wire'],
  ['wrongDefaultWaitTimeout', 'S6.default-timeout', 'sdk'],
  ['fail304', 'S6.not-modified', 'sdk'],
  ['wrongPutContentType', 'S7.happy-path', 'wire'],
  ['authOnPut', 'S7.happy-path', 'wire'],
  ['noPutRetry', 'S7.put-retried-whole-file', 'wire'],
  ['partialRetry', 'S7.put-retried-whole-file', 'wire'],
  ['noResign', 'S7.expired-url-in-flight', 'wire'],
  ['noResign', 'S7.expired-url-at-create', 'wire'],
  ['streamWithoutLength', 'S7.stream-input', 'wire'],
  ['tooManyPutRetries', 'S7.put-gives-up', 'wire'],
  ['flatErrors', 'S9.problem-fields', 'sdk'],
  ...['400', '401', '403', '404', '409', '410', '413', '415', '422', '429-past-budget', '503-past-budget'].map((status) => ['dropProblem', `S9.status-${status}`, 'sdk']),
  ['dropProblem', 'S9.unknown-code-preserved', 'sdk'],
  ['errorBodyMustBeJson', 'S9.non-json-error', 'sdk'],
  ['hideHeaders', 'S10.etag-exposed', 'sdk'],
  ['alwaysIfMatch', 'S10.if-match-optional-omitted', 'wire'],
  ['alwaysIfMatch', 'S10.merge-and-create-send-no-if-match', 'wire'],
  ['retry412', 'S10.412-not-retried', 'wire'],
  ['retry412', 'S10.428-not-retried', 'wire'],
  ['unquotedIfMatch', 'S10.if-match-sent', 'wire'],
  ['skipIfMatchCheck', 'S10.if-match-required-by-the-sdk', 'wire'],
  ['hideHeaders', 'S11.headers-on-create', 'sdk'],
  ['hideHeaders', 'S11.headers-on-read', 'sdk'],
  ['hideHeaders', 'S11.headers-on-error', 'sdk'],
  ['dropUnknown', 'S12.job-unknown-field', 'sdk'],
  ['dropUnknown', 'S12.job-unknown-enum', 'sdk'],
  ['unknownsAreFatal', 'S12.job-unknown-union-variant', 'sdk'],
  ['dropUnknown', 'S12.sweep-unknown-enum', 'sdk'],
  ['dropUnknown', 'S12.sweep-unknown-field', 'sdk'],
  ['unknownsAreFatal', 'S12.sweep-unknown-union-variant', 'sdk'],
  ['nullForOmitted', 'S12.omitted-stays-omitted', 'wire'],
  ['wrongDefaultTimeout', 'S13.default-timeout', 'sdk'],
  ['unknownStatusIsTerminal', 'S12.job-unknown-status-keeps-waiting', 'wire'],
  ['nullForEmptyString', 'S12.clear-with-empty-string', 'wire'],
  ['warnEveryCall', 'S14.warn-once-per-operation', 'sdk'],
  ['warnAlways', 'S14.no-warning-without-header', 'sdk'],
  ['noUserAgent', 'S15.user-agent', 'wire'],
  ['logSecrets', 'S16.debug-log-redacts', 'sdk'],
  ['logAlways', 'S16.debug-off-by-default', 'sdk'],
];

test('every scenario that can fail has a fault that makes it fail', () => {
  const covered = new Set(FAULTS.map(([, id]) => id));
  // Only a human can judge these two, and the slow ones run for minutes; test.todo would hide that, so name them.
  const exempt = new Set(['S14.language-markers', 'S17.browser-refused', 'S3.total-budget', 'S13.default-timeout-covers-long-poll']);
  const uncovered = list.scenarios
    .filter((scenario) => (scenario.status ?? 'active') === 'active')
    .map((scenario) => scenario.id)
    .filter((id) => !covered.has(id) && !exempt.has(id));
  assert.deepEqual(uncovered, []);
});

describe('a broken SDK fails the scenario that covers the behaviour', { concurrency: 8 }, () => {
  for (const [fault, id, side] of FAULTS) {
    test(`${fault} fails ${id}`, async () => {
      await withHarness(async (harness) => {
        const { verify, sdkFailures, wireFailures } = await runScenario(harness, id, { faults: { [fault]: true } });
        assert.equal(verify.pass, false, `${fault} went unnoticed by ${id}`);
        if (side === 'wire') assert.ok(wireFailures.length > 0, `${fault}: expected a wire failure, got only ${sdkFailures}`);
        else assert.ok(sdkFailures.length > 0, `${fault}: expected an SDK-side failure`);
      });
    });
  }
});

test('the reference client refuses to leave this machine, so a fault cannot reach production', async () => {
  const operations = [{ operationId: 'getMe', method: 'GET', path: '/me', idempotency_key: 'none', if_match: 'none' }];
  const client = new ReferenceClient({ args: { api_key: 'k' }, operations });
  assert.equal(client.baseUrl, 'https://api.rask.ai/v3');
  await assert.rejects(() => client.call('getMe'), ConfigError);
});

describe('the report', () => {
  let harness;
  before(async () => {
    harness = new Harness({ port: 0, contract });
    await harness.start();
  });
  after(() => harness.stop());

  test('tracks what a language ran, passed and left out', async () => {
    const control = controlClient(harness);
    const before = (await control.get('/report?lang=go')).body;
    assert.equal(before.complete, false);
    assert.equal(before.passed.length, 0);
    assert.ok(before.not_run.includes('S1.key-argument'));
    assert.ok(!before.not_run.includes('S17.browser-refused'), 'S17 is TypeScript only');
    assert.ok(!before.not_run.includes('S8.webhooks-unwrap'), 'S8 is Later');
    assert.ok(before.slow_not_run.includes('S3.total-budget'));

    await runScenario(harness, 'S1.key-argument', { lang: 'go' });
    await runScenario(harness, 'S1.key-env', { lang: 'go', faults: { wrongAuthScheme: true } });
    const report = (await control.get('/report?lang=go')).body;
    assert.deepEqual(report.passed, ['S1.key-argument']);
    assert.deepEqual(report.failed.map((item) => item.id), ['S1.key-env']);

    const typescript = (await control.get('/report?lang=typescript')).body;
    assert.ok(typescript.not_run.includes('S17.browser-refused'));

    assert.equal((await control.delete('/report')).status, 200);
    assert.equal((await control.get('/report?lang=go')).body.passed.length, 0);
  });

  test('S15 narrows to the language under test', async () => {
    const control = controlClient(harness);
    const python = (await control.post('/scenarios/S15.user-agent/start', { lang: 'python' })).body;
    assert.match(python.wire[0].matches, /^\^rask-sdk-python\//);
    const any = (await control.get('/scenarios/S15.user-agent')).body;
    assert.match(any.wire[0].matches, /\(go\|python\|typescript\|php\|java\)/);
  });
});

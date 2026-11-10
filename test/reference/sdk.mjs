// A minimal SDK that passes the scenario list. It exists to prove the scenarios can pass, and, through `faults`, that each
// of them fails when an SDK gets the behaviour wrong. It also reads as a worked example of the wire behaviour, but it is
// not the SDK and nothing ships from here.
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

export class ConfigError extends Error {}

export class RaskError extends Error {
  constructor({ status, problem, headers, idempotencyKey }) {
    super(problem?.detail ?? `HTTP ${status}`);
    this.name = new.target.name;
    this.status = status;
    this.problem = problem ?? null;
    this.code = problem?.code ?? null;
    this.headers = headers;
    this.request_id = headers?.['x-request-id'] ?? null;
    this.idempotency_key = idempotencyKey ?? null;
    const retryAfter = headers?.['retry-after'];
    this.retry_after = retryAfter === undefined ? null : Number(retryAfter);
  }
}
export class InsufficientBalanceError extends RaskError {}
export class JobFailedError extends RaskError {}
export class JobCanceledError extends RaskError {}
export class WaitTimeoutError extends Error {}

const DEFAULT_BASE_URL = 'https://api.rask.ai/v3';
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const TOTAL_BUDGET_MS = 120_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// These tests must never leave the machine: a fault that loses the base URL would otherwise reach production.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const assertLocal = (url) => {
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new ConfigError(`Refusing to send a request off this machine: ${url}`);
};

export class ReferenceClient {
  #apiKey;

  constructor({ args = {}, env = {}, operations, faults = {} }) {
    this.#apiKey = args.api_key ?? (faults.ignoreEnvKey ? undefined : env.RASK_API_KEY);
    if (faults.envKeyBeatsArgument && env.RASK_API_KEY) this.#apiKey = env.RASK_API_KEY;
    if (!this.#apiKey && !faults.noKeyCheck) throw new ConfigError('No API key: pass api_key or set RASK_API_KEY.');
    this.faults = faults;
    this.operations = new Map(operations.map((operation) => [operation.operationId, operation]));
    const fromEnv = faults.ignoreEnvBaseUrl ? undefined : env.RASK_BASE_URL;
    let baseUrl = args.base_url ?? fromEnv ?? (faults.wrongDefaultBaseUrl ? 'https://api.rask.ai' : DEFAULT_BASE_URL);
    if (faults.envBeatsArgument && env.RASK_BASE_URL) baseUrl = env.RASK_BASE_URL;
    if (!faults.keepTrailingSlash) baseUrl = baseUrl.replace(/\/+$/, '');
    this.baseUrl = baseUrl;
    this.timeoutMs = (args.timeout_seconds ?? 60) * 1000;
    this.debug = env.RASK_LOG === 'debug' || Boolean(faults.logAlways);
    this.logs = [];
    this.warnings = [];
    this.warned = new Set();
    this.config = {
      base_url: baseUrl,
      timeout_seconds: args.timeout_seconds ?? (faults.wrongDefaultTimeout ? 30 : 60),
      'jobs.wait.timeout_seconds': faults.wrongDefaultWaitTimeout ? 3600 : 14400,
    };
  }

  toString() {
    return this.faults.keyInRepr ? `ReferenceClient(${this.baseUrl}, ${this.#apiKey})` : `ReferenceClient(${this.baseUrl})`;
  }

  toJSON() {
    return { base_url: this.baseUrl };
  }

  #log(line) {
    if (!this.debug) return;
    if (this.faults.logSecrets) this.logs.push(`${line} Authorization: Bearer ${this.#apiKey}`);
    else this.logs.push(line.replace(/(X-Amz-Signature=)[^&\s]+/g, '$1***'));
  }

  #url(operation, path = {}, query = {}) {
    const filled = operation.path.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(path[name]));
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined) continue;
      search.set(name, Array.isArray(value) ? value.join(',') : String(value));
    }
    const text = search.toString();
    const suffix = text ? `?${text}` : '';
    if (this.faults.dropPrefix) return new URL(`${filled}${suffix}`, this.baseUrl).toString();
    if (this.faults.linksFromOrigin && operation.operationId === 'getJob') return new URL(`/v3${filled}${suffix}`, this.baseUrl).toString();
    if (this.faults.appendV3) return `${this.baseUrl}/v3${filled}${suffix}`;
    return `${this.baseUrl}${filled}${suffix}`;
  }

  #headers(operation, options, key) {
    const headers = { Accept: 'application/json' };
    headers.Authorization = this.faults.wrongAuthScheme ? `Token ${this.#apiKey}` : `Bearer ${this.#apiKey}`;
    if (!this.faults.noUserAgent) headers['User-Agent'] = 'rask-sdk-typescript/0.0.0 node/24.0.0';
    if (key !== undefined) headers['Idempotency-Key'] = key;
    if (options.if_match !== undefined) {
      headers['If-Match'] = this.faults.unquotedIfMatch ? options.if_match.replaceAll('"', '') : options.if_match;
    } else if (this.faults.alwaysIfMatch) {
      headers['If-Match'] = '"s-0"';
    }
    if (options.body !== undefined && options.body !== null) headers['Content-Type'] = 'application/json';
    return { ...headers, ...options.headers };
  }

  #serialize(body) {
    if (body === undefined || body === null) return undefined;
    if (!this.faults.nullForEmptyString) return JSON.stringify(body);
    return JSON.stringify(body, (_, value) => (value === '' ? null : value));
  }

  // One logical call: retries, keys, redirects, errors. Returns { status, headers, body, idempotency_key }.
  async call(operationId, options = {}) {
    const operation = this.operations.get(operationId);
    if (operation.if_match === 'required' && options.if_match === undefined && !this.faults.skipIfMatchCheck) {
      throw new ConfigError(`${operationId} requires if_match.`);
    }
    const carriesKey = operation.method !== 'GET' && operation.idempotency_key !== 'none' && !this.faults.noIdempotencyKey;
    let key = (this.faults.ignoreCallerKey ? undefined : options.idempotency_key) ?? (carriesKey ? randomUUID() : undefined);
    if (this.faults.fixedKey && carriesKey) key = 'same-key-every-call';
    const url = this.#url(operation, options.path, options.query);
    assertLocal(url);
    const body = this.#serialize(this.faults.nullForOmitted && operationId === 'updateProject'
      ? { folder_id: null, metadata: null, ...options.body } : options.body);
    const started = Date.now();
    let attempt = 0;
    let inUseRetries = 0;
    for (;;) {
      let response;
      let failure;
      const headers = this.#headers(operation, options, key);
      try {
        response = await this.#send(operation.method, url, headers, body);
      } catch (error) {
        failure = error;
      }
      let retry;
      let wait = this.faults.noBackoff ? 0 : Math.min(500 * 1.5 ** attempt, 30_000) * (0.75 + Math.random() / 2);
      if (failure) {
        retry = !this.faults.noRetry && !(failure instanceof ConfigError);
      } else {
        const ok = response.status < 300 || (response.status === 304 && options.allow304);
        if (ok) return this.#result(operationId, response, key);
        const problem = this.faults.errorBodyMustBeJson ? JSON.parse(response.text) : parseProblem(response);
        retry = RETRY_STATUSES.has(response.status) && !this.faults.noRetry;
        if (response.status === 409 && problem?.code === 'idempotency_key_in_use' && !this.faults.noRetry) {
          retry = inUseRetries < (this.faults.tooManyInUseRetries ? 5 : 3);
          inUseRetries += 1;
        }
        if (this.faults.retry500 && response.status === 500) retry = attempt < 1;
        if (this.faults.retry409 && response.status === 409 && problem?.code !== 'idempotency_key_in_use') retry = attempt < 1;
        if (this.faults.retry412 && (response.status === 412 || response.status === 428)) retry = attempt < 1;
        const retryAfter = response.headers['retry-after'];
        if (retryAfter !== undefined && !this.faults.ignoreRetryAfter) wait = Math.max(wait, Number(retryAfter) * 1000);
        failure = this.#error(response, problem, key);
      }
      if (!retry || Date.now() - started + wait > TOTAL_BUDGET_MS) throw failure;
      attempt += 1;
      if (this.faults.rotateKeyOnRetry && key !== undefined) key = randomUUID();
      await sleep(wait);
    }
  }

  #error(response, problem, key) {
    const ErrorClass = response.status === 402 && !this.faults.flatErrors ? InsufficientBalanceError : RaskError;
    return new ErrorClass({
      status: response.status,
      problem: this.faults.dropProblem ? null : problem,
      headers: this.faults.hideHeaders ? {} : response.headers,
      idempotencyKey: this.faults.keyNotExposed ? undefined : key,
    });
  }

  #result(operationId, response, key) {
    if (response.headers.deprecation !== undefined && !this.warned.has(operationId)) {
      this.warned.add(operationId);
      this.warnings.push(operationId);
    }
    if (this.faults.warnEveryCall && response.headers.deprecation !== undefined) this.warnings.push(operationId);
    if (this.faults.warnAlways) this.warnings.push(operationId);
    return {
      status: response.status,
      headers: this.faults.hideHeaders ? {} : response.headers,
      body: this.#decode(response),
      idempotency_key: this.faults.keyNotExposed ? null : key ?? null,
    };
  }

  #decode(response) {
    if (!response.text) return null;
    if (this.faults.unknownsAreFatal && response.text.includes('s12_')) throw new Error('Unknown value in the response.');
    const body = JSON.parse(response.text);
    if (this.faults.pageTruncates && body.object === 'list') body.data = body.data.slice(0, 1);
    return this.faults.dropUnknown ? stripUnknown(body) : body;
  }

  async #send(method, url, headers, body, hops = 0) {
    this.#log(`> ${method} ${url}`);
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    this.#log(`< ${response.status} ${url}`);
    const result = { status: response.status, headers: Object.fromEntries(response.headers), text };
    if (response.status >= 300 && response.status < 400 && result.headers.location && hops < 3) {
      const target = new URL(result.headers.location, url);
      assertLocal(target);
      const nextHeaders = { ...headers };
      if (target.origin !== new URL(url).origin && !this.faults.keepAuthOnRedirect) delete nextHeaders.Authorization;
      return this.#send(method, target.toString(), nextHeaders, body, hops + 1);
    }
    return result;
  }

  async *iterate(operationId, options = {}) {
    let cursor;
    do {
      const query = this.faults.pagingLosesFilters && cursor ? { limit: options.query?.limit } : { ...options.query };
      if (cursor) query.cursor = cursor;
      const page = await this.call(operationId, { ...options, query });
      yield* page.body.data;
      cursor = page.body.next_cursor;
      if (this.faults.pagingStopsOnShortPage && page.body.data.length < (options.query?.limit ?? 20)) return;
      if (this.faults.pagingIgnoresCursor) return;
    } while (cursor);
    if (this.faults.pagingOneTooMany) await this.call(operationId, options);
  }

  async waitJob(jobId, { timeout_seconds: timeoutSeconds = 14400 } = {}) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let etag;
    for (;;) {
      const headers = etag ? { 'If-None-Match': etag } : {};
      const query = this.faults.waitWithoutLongPoll ? {} : { wait_seconds: 20 };
      const response = await this.call('getJob', { path: { job_id: jobId }, query, headers, allow304: !this.faults.fail304 });
      if (response.status !== 304) {
        etag = response.headers.etag;
        const job = response.body;
        if (job.status === 'succeeded') return response;
        if (this.faults.waitIgnoresFailure && (job.status === 'failed' || job.status === 'canceled')) return response;
        if (job.status === 'failed') throw new JobFailedError({ status: job.error.status, problem: job.error, headers: response.headers });
        if (job.status === 'canceled') throw new JobCanceledError({ status: 409, problem: job.error, headers: response.headers });
        if (this.faults.unknownStatusIsTerminal && job.status !== 'queued' && job.status !== 'running') return response;
      }
      const wait = this.faults.ignoreRetryAfter ? 0 : Number(response.headers['retry-after'] ?? 1) * 1000;
      if (Date.now() + wait >= deadline) {
        if (this.faults.waitCancelsOnTimeout) await this.call('cancelJob', { path: { job_id: jobId } });
        throw new WaitTimeoutError(`Job ${jobId} did not finish in ${timeoutSeconds} s.`);
      }
      await sleep(wait);
    }
  }

  async uploadFile({ filename, content_type: contentType, bytes, source, on_progress: onProgress }) {
    const created = await this.call('createUpload', { body: { filename, content_type: contentType, size_bytes: bytes.length } });
    let upload = created.body;
    let failures = 0;
    let resigned = false;
    for (;;) {
      const put = await this.#put(upload, bytes, failures, source);
      if (put.ok) break;
      if (put.expired && !resigned && !this.faults.noResign) {
        resigned = true;
        upload = (await this.call('getUpload', { path: { upload_id: upload.id } })).body;
        continue;
      }
      failures += 1;
      const allowed = this.faults.noPutRetry ? 0 : (this.faults.tooManyPutRetries ? 5 : 3);
      if (failures > allowed) {
        throw new RaskError({ status: put.status ?? 0, problem: null, headers: {} });
      }
      await sleep(200);
    }
    onProgress?.(bytes.length);
    return this.call('completeUpload', { path: { upload_id: upload.id } });
  }

  async #put(upload, bytes, attempt, source) {
    const headers = { ...upload.transfer.headers };
    if (this.faults.authOnPut) headers.Authorization = `Bearer ${this.#apiKey}`;
    if (this.faults.wrongPutContentType) headers['Content-Type'] = 'application/octet-stream';
    let body = bytes;
    if (this.faults.partialRetry && attempt > 0) body = bytes.subarray(0, bytes.length / 2);
    if (body !== bytes) headers['Content-Length'] = String(body.length);
    const init = { method: 'PUT', headers, body, signal: AbortSignal.timeout(this.timeoutMs) };
    if (source === 'stream' && this.faults.streamWithoutLength) {
      delete headers['Content-Length'];
      init.body = Readable.toWeb(Readable.from([bytes]));
      init.duplex = 'half';
    }
    assertLocal(upload.transfer.url);
    this.#log(`> PUT ${upload.transfer.url}`);
    let response;
    try {
      response = await fetch(upload.transfer.url, init);
    } catch {
      return { ok: false, expired: false };
    }
    const text = await response.text();
    this.#log(`< ${response.status} PUT`);
    return { ok: response.ok, status: response.status, expired: response.status === 403 && text.includes('Request has expired') };
  }
}

const parseProblem = (response) => {
  try {
    return JSON.parse(response.text);
  } catch {
    return null;
  }
};

function stripUnknown(value) {
  if (Array.isArray(value)) return value.map(stripUnknown);
  if (value === 's12_unknown_enum_value') return null;
  if (value === null || typeof value !== 'object') return value;
  const result = {};
  for (const [name, child] of Object.entries(value)) {
    if (name !== 's12_unknown_field') result[name] = stripUnknown(child);
  }
  return result;
}

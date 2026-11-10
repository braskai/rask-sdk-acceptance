import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Contract } from './contract.mjs';
import { ControlApi } from './control.mjs';
import { JobPrograms, PagePrograms, Uploads } from './programs.mjs';
import { checkRequest } from './request-check.mjs';
import { Responder } from './responses.mjs';
import { ScenarioList } from './scenarios.mjs';
import { STORAGE_PUT, ScriptQueues } from './script.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SPEC = join(ROOT, 'contract', 'openapi.json');
export const DEFAULT_SCENARIOS = join(ROOT, 'scenarios', 'scenarios.json');
export const DEFAULT_PREFIX = '/custom/prefix/v3';

// A body the API itself would refuse with 413 is read no further; uploads go to the other listener, which only hashes.
const MAX_API_BODY_BYTES = 16 * 1024 * 1024;

const readBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_API_BODY_BYTES) chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const splitUrl = (url) => {
  const index = url.indexOf('?');
  return index === -1 ? [url, ''] : [url.slice(0, index), url.slice(index + 1)];
};

const sleepUnlessClosed = (ms, socket) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  socket.once('close', () => {
    clearTimeout(timer);
    resolve();
  });
});

const s3Error = (code, message) => `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message></Error>`;

export class Harness {
  constructor({ port = 4010, otherPort, host = '127.0.0.1', publicHost, otherPublicHost = 'localhost', prefix = DEFAULT_PREFIX,
    specPath = DEFAULT_SPEC, scenariosPath = DEFAULT_SCENARIOS, contract } = {}) {
    this.host = host;
    this.requestedPort = port;
    this.requestedOtherPort = otherPort ?? (port === 0 ? 0 : port + 1);
    this.publicHost = publicHost ?? (host === '0.0.0.0' ? '127.0.0.1' : host);
    this.otherPublicHost = otherPublicHost;
    this.prefix = Harness.normalizePrefix(prefix);
    this.contract = contract ?? new Contract(specPath);
    this.scenarios = new ScenarioList(scenariosPath);
    this.control = new ControlApi(this);
    this.scripts = new ScriptQueues();
    this.results = new Map();
    this.servers = [];
    this.records = [];
    this.seq = 0;
  }

  static normalizePrefix(prefix) {
    const trimmed = prefix.replace(/\/+$/, '');
    if (trimmed !== '' && !trimmed.startsWith('/')) throw new Error(`--prefix must start with "/", got ${prefix}`);
    if (trimmed === '/__control' || trimmed.startsWith('/__control/')) throw new Error('--prefix must stay outside /__control');
    return trimmed;
  }

  get baseUrl() {
    return `http://${this.publicHost}:${this.port}${this.prefix}`;
  }

  get controlUrl() {
    return `http://${this.publicHost}:${this.port}/__control`;
  }

  get otherBaseUrl() {
    return `http://${this.otherPublicHost}:${this.otherPort}`;
  }

  scenarioVars() {
    return { base_url: this.baseUrl, prefix: this.prefix, other_base_url: this.otherBaseUrl, control_url: this.controlUrl };
  }

  async start() {
    const api = http.createServer((req, res) => this.#guard(res, () => this.#handleApi(req, res)));
    const other = http.createServer((req, res) => this.#guard(res, () => this.#handleOther(req, res)));
    this.port = await this.#listen(api, this.requestedPort, this.host);
    this.otherPort = await this.#listen(other, this.requestedOtherPort, this.host);
    // The other host's name is `localhost` by default, which a client may resolve to ::1 first.
    if (this.host === '127.0.0.1') {
      const v6 = http.createServer((req, res) => this.#guard(res, () => this.#handleOther(req, res)));
      await this.#listen(v6, this.otherPort, '::1').catch(() => {});
    }
    this.resetState();
    return this;
  }

  async stop() {
    await Promise.all(this.servers.map((server) => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    })));
    this.servers = [];
  }

  #listen(server, port, host) {
    // Longer than any client pool's idle time: a server closing a kept-alive socket as the client reuses it looks like a
    // connection error, and an SDK would rightly retry, which would make request counts flaky.
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 125_000;
    server.requestTimeout = 0;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        this.servers.push(server);
        resolve(server.address().port);
      });
    });
  }

  resetState() {
    this.clearRecords();
    this.scripts.clear();
    this.jobs = new JobPrograms(this.contract);
    this.pages = new PagePrograms(this.contract);
    this.uploads = new Uploads(this.otherBaseUrl);
    this.moved = new Map();
    this.responder = new Responder({
      contract: this.contract,
      jobs: this.jobs,
      pages: this.pages,
      uploads: this.uploads,
      moved: this.moved,
      otherBaseUrl: this.otherBaseUrl,
    });
  }

  clearRecords() {
    this.records = [];
  }

  recordResult(lang, id, result) {
    if (!this.results.has(lang)) this.results.set(lang, new Map());
    this.results.get(lang).set(id, result);
  }

  async #guard(res, handler) {
    try {
      await handler();
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Harness bug: ${error.message}` }));
      } else {
        res.destroy();
      }
    }
  }

  #record({ listener, req, path, rawQuery, buffer, hash }) {
    let body = null;
    if (buffer?.length) {
      try {
        body = JSON.parse(buffer.toString('utf8'));
      } catch {
        body = null;
      }
    }
    this.seq += 1;
    const record = {
      seq: this.seq,
      listener,
      received_at: new Date().toISOString(),
      received_at_ms: Date.now(),
      method: req.method,
      url: req.url,
      path,
      raw_query: rawQuery,
      raw_query_params: Object.fromEntries(new URLSearchParams(rawQuery)),
      operationId: null,
      path_params: {},
      headers: req.headers,
      body,
      body_text: buffer && buffer.length <= 64 * 1024 ? buffer.toString('utf8') : null,
      body_bytes: hash ? hash.bytes : (buffer?.length ?? 0),
      body_sha256: hash ? hash.sha256 : createHash('sha256').update(buffer ?? '').digest('hex'),
      violations: [],
      response: null,
    };
    this.records.push(record);
    return record;
  }

  async #handleApi(req, res) {
    const [path, rawQuery] = splitUrl(req.url);
    const buffer = await readBody(req);
    if (path === '/__control' || path.startsWith('/__control/')) {
      return this.control.handle(req, res, path, rawQuery, buffer);
    }
    const record = this.#record({ listener: 'api', req, path, rawQuery, buffer });
    const requestId = randomUUID();
    const located = this.#locate(req.method, path);
    if (located.violation) {
      return this.#answerViolation(req, res, record, null, [located.violation], requestId);
    }
    const { operation, pathParams } = located;
    record.operationId = operation.operationId;
    record.path_params = pathParams;
    const checked = checkRequest({ contract: this.contract, operation, pathParams, rawQuery, headers: req.headers, buffer });
    if (checked.credentialInQuery) {
      record.violations.push({
        pointer: `query:${checked.credentialInQuery}`,
        code: 'token_in_query',
        detail: `A credential travelled in the query string parameter "${checked.credentialInQuery}".`,
      });
      return this.#answerPlan(req, res, record, this.responder.plan(operation, { requestId, pathParams, headers: req.headers, query: {} }, { problem: 'token_in_query', patch: { parameter: checked.credentialInQuery } }));
    }
    if (checked.auth) {
      record.violations.push({ pointer: 'header:Authorization', code: checked.auth, detail: 'Authorization must be "Bearer <key>".' });
      return this.#answerPlan(req, res, record, this.responder.plan(operation, { requestId, pathParams, headers: req.headers, query: {} }, { problem: checked.auth, status: 401 }));
    }
    if (checked.violations.length > 0) {
      return this.#answerViolation(req, res, record, operation.operationId, checked.violations, requestId);
    }
    const ctx = { requestId, pathParams, headers: req.headers, query: checked.query, body: checked.body };
    const plan = this.responder.plan(operation, ctx, this.scripts.next(operation.operationId));
    record.violations.push(...plan.violations);
    return this.#answerPlan(req, res, record, plan);
  }

  // Where a raw path points, or a violation that says what the SDK most likely did wrong.
  #locate(method, path) {
    const violation = (detail) => ({ violation: { pointer: 'path', code: 'invalid_path', detail } });
    if (path.includes('//')) {
      return violation(`Path ${path} has an empty segment: did the SDK join a base URL ending in "/" with a path starting with "/"?`);
    }
    const prefix = this.prefix;
    if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) {
      const v3 = path === '/v3' || path.startsWith('/v3/');
      const hint = v3
        ? 'It starts with /v3: the SDK probably resolved a Location or links.* value against the origin, or hardcoded /v3. Re-root contract links under base_url.'
        : 'The SDK probably dropped the base URL\'s path (URL resolution of a path starting with "/" does that).';
      return violation(`Path ${path} is outside the API prefix ${prefix}. ${hint}`);
    }
    const rest = path.slice(prefix.length) || '/';
    if (rest.startsWith('/v3/') && !this.contract.route(method, rest)) {
      const inner = this.contract.route(method, rest.slice(3));
      if (inner) return violation(`Path ${path} repeats /v3: base_url already holds it, so the SDK must not append it.`);
    }
    if (rest.length > 1 && rest.endsWith('/')) {
      return violation(`Path ${path} ends in "/": no contract path does.`);
    }
    const routed = this.contract.route(method, rest);
    if (!routed) return violation(`No contract path matches ${method} ${rest}.`);
    if (routed.allowed) return violation(`${routed.path} has no ${method}; the contract allows ${routed.allowed.join(', ')}.`);
    return routed;
  }

  #answerViolation(req, res, record, operationId, violations, requestId) {
    record.violations.push(...violations);
    const problem = this.responder.violationProblem(operationId, violations, requestId);
    return this.#answerPlan(req, res, record, {
      status: 400,
      headers: { 'X-Request-Id': requestId },
      json: problem,
      contentType: 'application/problem+json',
      delayMs: 0,
      drop: null,
      injections: [],
      scripted: false,
      selfCheck: false,
    });
  }

  async #answerPlan(req, res, record, plan) {
    const payload = plan.raw ?? (plan.json !== undefined ? JSON.stringify(plan.json) : '');
    const selfCheck = plan.selfCheck && plan.json !== undefined && plan.schema
      ? this.contract.validate(plan.schema, plan.json, { open: true }) : [];
    record.response = {
      status: plan.status,
      headers: plan.headers,
      body: plan.json ?? null,
      raw: plan.raw ?? null,
      scripted: plan.scripted,
      injections: plan.injections,
      delay_ms: plan.delayMs,
      dropped: plan.drop ? (plan.drop === true ? 'before_headers' : plan.drop) : null,
      self_check: selfCheck,
    };
    await this.#deliver(req, res, plan, payload);
  }

  async #deliver(req, res, plan, payload) {
    if (plan.delayMs > 0) await sleepUnlessClosed(plan.delayMs, req.socket);
    if (req.socket.destroyed) return;
    const drop = plan.drop === true ? 'before_headers' : plan.drop;
    if (drop === 'before_headers') {
      req.socket.destroy();
      return;
    }
    const buffer = Buffer.from(payload);
    const headers = { ...plan.headers, 'Content-Length': buffer.length };
    if (plan.contentType) headers['Content-Type'] = plan.contentType;
    if (drop === 'after_headers' || drop === 'mid_body') {
      res.writeHead(plan.status, headers);
      if (drop === 'mid_body') res.write(buffer.subarray(0, Math.floor(buffer.length / 2)));
      await new Promise((resolve) => setTimeout(resolve, 20));
      req.socket.destroy();
      return;
    }
    res.writeHead(plan.status, headers);
    res.end(buffer);
  }

  async #handleOther(req, res) {
    const [path, rawQuery] = splitUrl(req.url);
    if (path === '/__other/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"listener":"other"}');
      return;
    }
    if (path.startsWith('/storage/')) return this.#handleStorage(req, res, path, rawQuery);
    const buffer = await readBody(req);
    const record = this.#record({ listener: 'other', req, path, rawQuery, buffer });
    const moved = /^\/moved\/([^/]+)$/.exec(path);
    const target = moved ? this.moved.get(moved[1]) : null;
    if (target) {
      record.operationId = target.operation.operationId;
      record.path_params = target.ctx.pathParams;
      return this.#answerPlan(req, res, record, this.responder.plan(target.operation, target.ctx));
    }
    return this.#answerPlan(req, res, record, {
      status: 200,
      headers: {},
      json: { ok: true, listener: 'other' },
      contentType: 'application/json',
      delayMs: 0,
      drop: null,
      injections: [],
      scripted: false,
      selfCheck: false,
    });
  }

  // A presigned PUT. Reads the bytes only to hash them, since an upload can be large, and judges them the way S3 would.
  async #handleStorage(req, res, path, rawQuery) {
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of req) {
      digest.update(chunk);
      bytes += chunk.length;
    }
    const record = this.#record({ listener: 'other', req, path, rawQuery, hash: { bytes, sha256: digest.digest('hex') } });
    record.operationId = STORAGE_PUT;
    const plan = this.#storagePlan(req, record, path, rawQuery);
    await this.#answerPlan(req, res, record, plan);
  }

  #storagePlan(req, record, path, rawQuery) {
    const answer = (status, code, message, violationDetail) => {
      if (violationDetail) record.violations.push({ pointer: 'storage', code, detail: violationDetail });
      return this.#storageAnswer(status, code ? s3Error(code, message) : '', {});
    };
    if (req.method !== 'PUT') return answer(405, 'MethodNotAllowed', 'Only PUT is signed.', `The presigned URL is signed for PUT, got ${req.method}.`);
    const match = /^\/storage\/([^/]+)\/(\d+)\/[^/]+$/.exec(path);
    const upload = match ? this.uploads.get(match[1]) : null;
    if (!upload) return answer(404, 'NoSuchUpload', 'Unknown upload.', `Storage path ${path} was not handed out by createUpload or getUpload.`);
    const generation = upload.generations.get(Number(match[2]));
    if (!generation || generation.query !== rawQuery) {
      return answer(403, 'SignatureDoesNotMatch', 'The query string is not the signed one.',
        'The presigned URL must be used verbatim: its query string changed.');
    }
    const headers = req.headers;
    if (headers.authorization !== undefined) {
      return answer(400, 'InvalidArgument', 'Only one auth mechanism allowed; both X-Amz-Algorithm and Authorization were sent.',
        'A presigned PUT must not carry Authorization: the API key went to the storage host.');
    }
    if (headers['content-length'] === undefined) {
      return answer(411, 'MissingContentLength', 'The signed Content-Length is required.',
        `The PUT must carry Content-Length: ${upload.size_bytes}; a chunked upload fails the signature.`);
    }
    if (Number(headers['content-length']) !== upload.size_bytes) {
      return answer(403, 'SignatureDoesNotMatch', 'Content-Length differs from the signed one.',
        `The PUT carried Content-Length: ${headers['content-length']}; the URL signs ${upload.size_bytes}.`);
    }
    if (headers['content-type'] !== upload.content_type) {
      return answer(403, 'SignatureDoesNotMatch', 'Content-Type differs from the signed one.',
        `The PUT carried Content-Type: ${headers['content-type'] ?? '(none)'}; the URL signs ${upload.content_type}.`);
    }
    if (generation.expired) return answer(403, 'AccessDenied', 'Request has expired');
    const step = this.scripts.next(STORAGE_PUT);
    if (step?.expired) {
      generation.expired = true;
      return { ...answer(403, 'AccessDenied', 'Request has expired'), scripted: true };
    }
    if (step) return this.#scriptedStorage(step, upload, record);
    upload.put_ok = true;
    upload.put_sha256 = record.body_sha256;
    return this.#storageAnswer(200, '', { ETag: `"${record.body_sha256.slice(0, 32)}"` });
  }

  #scriptedStorage(step, upload, record) {
    const status = step.status ?? 200;
    const plan = this.#storageAnswer(status, step.raw ?? (status >= 400 ? s3Error('ServiceUnavailable', 'Scripted storage failure.') : ''), step.headers ?? {});
    Object.assign(plan, { scripted: true, delayMs: step.delay_ms ?? 0, drop: step.drop ?? null });
    if (step.content_type) plan.contentType = step.content_type;
    if (status < 300 && !step.drop) {
      upload.put_ok = true;
      upload.put_sha256 = record.body_sha256;
    }
    return plan;
  }

  #storageAnswer(status, raw, headers) {
    return {
      status,
      headers,
      raw,
      contentType: raw ? 'application/xml' : null,
      delayMs: 0,
      drop: null,
      injections: [],
      scripted: false,
      selfCheck: false,
    };
  }
}

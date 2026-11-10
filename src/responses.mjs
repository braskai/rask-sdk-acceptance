// Turns "this operation was called" plus an optional scripted step into a response plan.
import { randomUUID } from 'node:crypto';

import { clone } from './contract.mjs';
import { injectUnknowns } from './inject.mjs';
import { isTerminalStatus } from './programs.mjs';

const GENERIC_CODES = {
  400: 'token_in_query', 401: 'invalid_token', 402: 'insufficient_balance', 403: 'forbidden', 404: 'project_not_found',
  409: 'project_busy', 410: 'upload_expired', 412: 'precondition_failed', 413: 'request_too_large',
  415: 'unsupported_media_type', 422: 'validation_failed', 428: 'precondition_required', 429: 'rate_limited',
  500: 'internal_error', 503: 'temporarily_unavailable',
};
// Gateways answer these, not the API: they are outside the contract and rarely JSON (DESIGN S3 retries them).
const GATEWAY_HTML = {
  502: '<html><body><h1>502 Bad Gateway</h1></body></html>',
  504: '<html><body><h1>504 Gateway Time-out</h1></body></html>',
};
const RETRY_AFTER_CODES = new Set(['idempotency_key_in_use', 'transcript_busy']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const merge = (base, patch) => {
  if (!isObject(base) || !isObject(patch)) return clone(patch);
  const result = { ...base };
  for (const [name, value] of Object.entries(patch)) result[name] = merge(base[name], value);
  return result;
};

export class Responder {
  constructor({ contract, jobs, pages, uploads, moved, otherBaseUrl }) {
    this.contract = contract;
    this.jobs = jobs;
    this.pages = pages;
    this.uploads = uploads;
    this.moved = moved;
    this.otherBaseUrl = otherBaseUrl;
  }

  problem(code, { status, requestId } = {}) {
    const example = this.contract.problemExample(code);
    const resolved = status ?? example?.status ?? 400;
    const base = example ? clone(example) : {
      type: `https://docs.api.rask.ai/errors/${code}`,
      title: code.replaceAll('_', ' '),
      detail: `Scripted problem ${code}.`,
      code,
      retryable: false,
      retry: 'none',
      recommendation: 'fix_request',
      hint: null,
      errors: [],
    };
    return { ...base, status: resolved, instance: `urn:uuid:${requestId ?? randomUUID()}` };
  }

  // What the harness answers when the SDK breaks the contract: a Problem, so an SDK surfaces it like any other 400.
  violationProblem(operationId, violations, requestId) {
    const summary = violations.map((item) => item.detail).join(' ');
    return {
      type: 'https://docs.api.rask.ai/errors/contract_violation',
      title: 'Request violates the API v3 contract',
      status: 400,
      detail: operationId ? `${operationId}: ${summary}` : summary,
      instance: `urn:uuid:${requestId}`,
      code: 'contract_violation',
      retryable: false,
      retry: 'none',
      recommendation: 'fix_request',
      hint: 'This answer comes from the acceptance harness: fix the SDK. See errors[] for each field.',
      errors: violations,
    };
  }

  plan(operation, ctx, step = null) {
    const plan = {
      status: undefined,
      headers: {},
      json: undefined,
      raw: undefined,
      contentType: null,
      delayMs: step?.delay_ms ?? 0,
      drop: step?.drop ?? null,
      injections: [],
      scripted: Boolean(step),
      selfCheck: !step?.off_contract,
      schema: null,
      job: null,
      violations: [],
    };
    if (step?.redirect) {
      this.#redirect(operation, ctx, step, plan);
    } else if (step?.raw !== undefined) {
      plan.status = step.status ?? 200;
      plan.raw = step.raw;
      plan.contentType = step.content_type ?? 'text/plain';
      plan.selfCheck = false;
    } else if (GATEWAY_HTML[step?.status] && step.problem === undefined && step.body === undefined) {
      plan.status = step.status;
      plan.raw = GATEWAY_HTML[step.status];
      plan.contentType = 'text/html';
      plan.selfCheck = false;
    } else if (step?.problem !== undefined || (step?.status ?? 0) >= 400) {
      this.#errorBody(operation, ctx, step, plan);
    } else {
      this.#successBody(operation, ctx, step, plan);
    }
    if (step?.patch !== undefined && plan.json !== undefined) plan.json = merge(plan.json, step.patch);
    if (step?.inject && plan.json !== undefined && plan.schema) {
      const { body, injections } = injectUnknowns(this.contract, plan.schema, plan.json, step.inject);
      plan.json = body;
      plan.injections = injections;
    }
    this.#addHeaders(operation, ctx, step, plan);
    return plan;
  }

  #redirect(operation, ctx, step, plan) {
    const target = step.redirect === 'other' ? { to: 'other' } : step.redirect;
    plan.status = target.status ?? 307;
    plan.selfCheck = false;
    plan.raw = '';
    if (target.to === 'other') {
      const token = randomUUID();
      this.moved.set(token, { operation, ctx });
      plan.headers.Location = `${this.otherBaseUrl}/moved/${token}`;
    } else {
      plan.headers.Location = target.to;
    }
  }

  #errorBody(operation, ctx, step, plan) {
    const code = step.problem ?? this.#defaultCode(operation, step.status);
    const status = step.status ?? this.contract.problemExample(code)?.status;
    plan.status = status ?? 400;
    plan.schema = operation.responses[plan.status]?.schema ?? { $ref: '#/components/schemas/Problem' };
    plan.problemCode = code;
    plan.json = step.body !== undefined ? clone(step.body)
      : this.problem(code, { status: plan.status, requestId: ctx.requestId });
  }

  #defaultCode(operation, status) {
    const response = operation.responses[status];
    // Not idempotency_key_in_use unless the caller asks: an SDK retries that one, and a bare 409 means a state conflict.
    const codes = response ? Object.values(response.examples).map((example) => example?.code).filter(Boolean) : [];
    const declared = codes.find((code) => code !== 'idempotency_key_in_use') ?? codes[0];
    return declared ?? GENERIC_CODES[status] ?? `http_${status}`;
  }

  #successBody(operation, ctx, step, plan) {
    plan.status = step?.status ?? Number(operation.successStatus);
    const response = operation.responses[plan.status];
    plan.schema = response?.schema ?? null;
    if (step?.body !== undefined) {
      plan.json = clone(step.body);
      return;
    }
    if (step?.status !== undefined && !response?.schema && step.status !== Number(operation.successStatus)) return;
    this.#defaultBody(operation, ctx, step, plan);
    if (plan.status === 304 || plan.status >= 400) return;
    if (plan.json !== undefined) this.#echoIds(operation, ctx, plan.json);
  }

  #example(operation, step) {
    const { examples } = operation.responses[operation.successStatus];
    const name = step?.example ?? Object.keys(examples)[0];
    if (name === undefined) {
      const { schema } = operation.responses[operation.successStatus];
      return schema ? this.contract.build(schema) : undefined;
    }
    return clone(examples[name]);
  }

  #defaultBody(operation, ctx, step, plan) {
    const { operationId } = operation;
    const pages = this.pages.get(operationId);
    if (pages) {
      const page = this.pages.respond(pages, ctx.query);
      if (page.invalidCursor) {
        plan.violations.push({ pointer: 'query:cursor', code: 'invalid_cursor', detail: `Invalid cursor: ${page.invalidCursor}.` });
        this.#errorBody(operation, ctx, { problem: 'invalid_cursor', status: 400 }, plan);
      } else {
        plan.json = page.body;
      }
      return;
    }
    if (operationId === 'getJob') return void this.#getJob(operation, ctx, step, plan);
    if (operationId === 'createUpload') return void this.#createUpload(operation, ctx, step, plan);
    if (operationId === 'getUpload') return void this.#getUpload(operation, ctx, step, plan);
    if (operationId === 'completeUpload') {
      const upload = this.uploads.get(ctx.pathParams.upload_id);
      if (upload && !upload.put_ok) {
        this.#errorBody(operation, ctx, { problem: 'upload_incomplete', status: 409 }, plan);
        plan.json.detail = `Upload ${upload.id} has not received its bytes.`;
        plan.json.errors = [];
        return;
      }
      if (upload) {
        this.#completeUpload(upload, step, plan, operation);
        return;
      }
    }
    if (step?.job !== undefined) {
      const view = this.jobs.peek(this.jobs.get(step.job));
      plan.json = view.body;
      plan.job = view;
      return;
    }
    plan.json = this.#example(operation, step);
    if (plan.json?.object === 'job') {
      plan.job = { terminal: isTerminalStatus(plan.json.status), retryAfter: 1, etag: null };
    }
    if (operationId === 'listLanguages' && ctx.headers['if-none-match']) {
      const etag = operation.responses[operation.successStatus].headers.ETag?.example;
      if (ctx.headers['if-none-match'] === etag) {
        plan.status = 304;
        plan.json = undefined;
        plan.schema = null;
      }
    }
  }

  #completeUpload(upload, step, plan, operation) {
    const view = step?.job !== undefined ? this.jobs.peek(this.jobs.get(step.job)) : null;
    plan.json = view ? view.body : this.#example(operation, step);
    plan.job = view ?? { terminal: false, retryAfter: 1, etag: null };
    Object.assign(upload, { status: 'completed', media_id: plan.json.media_id ?? randomUUID(), import_job_id: plan.json.id });
  }

  #getJob(operation, ctx, step, plan) {
    const id = ctx.pathParams.job_id;
    const program = this.jobs.get(id);
    if (!program) {
      const { examples } = operation.responses[operation.successStatus];
      const body = examples.succeeded && !step?.example ? clone(examples.succeeded) : this.#example(operation, step);
      body.id = id;
      body.links.self = `/v3/jobs/${id}`;
      plan.json = body;
      plan.job = { terminal: isTerminalStatus(body.status), retryAfter: 1, etag: `"${id}.1"` };
      return;
    }
    // A response that never arrives must not use up a state: the retry has to see it.
    const view = step?.drop ? this.jobs.peek(program) : this.jobs.poll(program);
    plan.job = view;
    if (program.hold_ms > 0 && !plan.delayMs) plan.delayMs = program.hold_ms;
    if (!view.terminal && ctx.headers['if-none-match'] === view.etag) {
      plan.status = 304;
      plan.schema = null;
      return;
    }
    plan.json = view.body;
  }

  #uploadBody(operation, upload, signOptions) {
    const body = this.#example(operation);
    const pending = upload.status === 'pending';
    return {
      ...body,
      id: upload.id,
      filename: upload.filename,
      content_type: upload.content_type,
      size_bytes: upload.size_bytes,
      purpose: upload.purpose,
      status: upload.status,
      transfer: pending ? this.uploads.sign(upload, signOptions) : null,
      media_id: pending ? null : upload.media_id,
      import_job_id: pending ? null : upload.import_job_id,
    };
  }

  #createUpload(operation, ctx, step, plan) {
    plan.json = this.#uploadBody(operation, this.uploads.create(ctx.body), step?.upload);
  }

  #getUpload(operation, ctx, step, plan) {
    const id = ctx.pathParams.upload_id;
    let upload = this.uploads.get(id);
    if (!upload) {
      // An id this run did not create (a sample request, say): answer it, and do not hold completeUpload to a PUT.
      upload = this.uploads.create({ ...this.#example(operation), id });
      upload.put_ok = true;
    }
    plan.json = this.#uploadBody(operation, upload, step?.upload);
  }

  #echoIds(operation, ctx, body) {
    if (!isObject(body)) return;
    const names = Object.keys(ctx.pathParams);
    const last = names.at(-1);
    if (last && operation.path.endsWith(`{${last}}`) && operation.method !== 'DELETE') {
      if ('id' in body) body.id = String(ctx.pathParams[last]);
      if (last === 'version_number' && 'number' in body) body.number = Number(ctx.pathParams[last]);
    }
    if (ctx.pathParams.project_id && typeof body.project_id === 'string') body.project_id = ctx.pathParams.project_id;
    if (body.object === 'job' && operation.operationId === 'completeUpload' && body.params) {
      body.params.upload_id = ctx.pathParams.upload_id;
    }
  }

  // The contract's own links are path-absolute with /v3 (DESIGN 4.2), whatever prefix the harness runs under. An SDK that
  // resolves them against the origin leaves a custom prefix: that is what scenario BU7 is there to catch.
  #location(operation, ctx, plan) {
    const { json } = plan;
    if (plan.status === 202) return `/v3/jobs/${json?.id}`;
    const id = json?.id ?? json?.segments?.[0]?.id ?? json?.number;
    const filled = operation.path.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(ctx.pathParams[name]));
    return `/v3${filled}/${id}`;
  }

  #addHeaders(operation, ctx, step, plan) {
    const response = operation.responses[plan.status];
    const headers = { 'X-Request-Id': ctx.requestId };
    for (const [name, header] of Object.entries(response?.headers ?? {})) {
      if (name === 'X-Request-Id' || name === 'Idempotent-Replayed' || name === 'Retry-After') continue;
      if (name === 'Location') {
        if (plan.json !== undefined) headers.Location = this.#location(operation, ctx, plan);
      } else if (name === 'ETag') {
        const etag = plan.job?.etag ?? plan.json?.etag ?? header.example;
        if (etag) headers.ETag = etag;
      } else if (header.example !== undefined) {
        headers[name] = String(header.example);
      }
    }
    const retryAfter = this.#retryAfter(step, plan);
    if (retryAfter !== null) headers['Retry-After'] = String(retryAfter);
    if (step?.deprecation) Object.assign(headers, deprecationHeaders(step.deprecation));
    plan.headers = { ...headers, ...plan.headers, ...(step?.headers ?? {}) };
    if (plan.contentType === null && plan.json !== undefined) {
      plan.contentType = response?.mediaType ?? (plan.status >= 400 ? 'application/problem+json' : 'application/json');
    }
  }

  #retryAfter(step, plan) {
    if (step?.retry_after === null) return null;
    if (step?.retry_after !== undefined) return step.retry_after;
    if (plan.status === 429 || plan.status === 503 || RETRY_AFTER_CODES.has(plan.problemCode)) return 1;
    if (plan.job && !plan.job.terminal && (plan.status === 200 || plan.status === 202 || plan.status === 304)) {
      return plan.job.retryAfter;
    }
    return null;
  }
}

function deprecationHeaders(value) {
  const options = value === true ? {} : value;
  return {
    Deprecation: options.deprecation ?? '@1798761600',
    Sunset: options.sunset ?? 'Sat, 01 May 2027 00:00:00 GMT',
    Link: options.link ?? '<https://docs.api.rask.ai/deprecations/acceptance>; rel="deprecation"',
  };
}

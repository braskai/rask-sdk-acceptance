// The few things that must stay consistent across requests: a job moving through states, a list across pages, an upload
// whose URLs get re-signed. Everything else in the mock is stateless.
import { createHash, createHmac, randomUUID } from 'node:crypto';

import { clone } from './contract.mjs';

export class ProgramError extends Error {}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const STATUS_ORDER = { queued: 0, running: 1, succeeded: 2, failed: 2, canceled: 2 };
const NOW = '2026-11-03T09:00:00Z';
const LATER = '2026-11-03T09:10:00Z';

export const isTerminalStatus = (status) => TERMINAL.has(status);

export class JobPrograms {
  constructor(contract) {
    this.contract = contract;
    this.programs = new Map();
  }

  // Scripted job. states: what successive getJob calls see; the last one repeats.
  create({ id = randomUUID(), type = 'dub', states, retry_after = 1, error = null, result = null, hold_ms = 0 }) {
    if (!Array.isArray(states) || states.length === 0) throw new ProgramError('states must be a non-empty array.');
    const known = this.contract.schemas.JobType.enum;
    if (!known.includes(type)) throw new ProgramError(`Unknown job type ${type}. Known: ${known.join(', ')}.`);
    states.forEach((state, index) => {
      if (isTerminalStatus(state) && index !== states.length - 1) {
        throw new ProgramError(`A job never leaves a terminal state, but ${state} is not last in ${states}.`);
      }
      const previous = states[index - 1];
      if (index > 0 && STATUS_ORDER[state] < STATUS_ORDER[previous]) {
        throw new ProgramError(`Job status is monotonic, but ${state} follows ${previous}.`);
      }
    });
    const program = { id, type, states, retry_after, error, result, hold_ms, polls: 0 };
    this.programs.set(id, program);
    return program;
  }

  get(id) {
    return this.programs.get(id);
  }

  #version(program, index) {
    let version = 1;
    for (let position = 1; position <= index; position += 1) {
      if (program.states[position] !== program.states[position - 1]) version += 1;
    }
    return version;
  }

  // What the next getJob sees; advances.
  poll(program) {
    const index = Math.min(program.polls, program.states.length - 1);
    program.polls += 1;
    return this.#view(program, index);
  }

  // What a 202 starting this job sees; does not advance.
  peek(program) {
    return this.#view(program, Math.min(program.polls, program.states.length - 1));
  }

  #view(program, index) {
    const status = program.states[index];
    const version = this.#version(program, index);
    return {
      status,
      terminal: isTerminalStatus(status),
      etag: `"${program.id}.${version}"`,
      retryAfter: program.retry_after,
      body: this.#body(program, status),
    };
  }

  // The contract's example jobs of this type; without one, a job built from the schema.
  #templates(type) {
    const examples = this.contract.jobTemplates.get(type);
    if (examples) return examples;
    const params = { ...this.contract.build({ $ref: this.contract.schemas.JobParams.discriminator.mapping[type] }), type };
    return [{ ...this.contract.build({ $ref: '#/components/schemas/Job' }), type, params, details: null, cost: null }];
  }

  #template(type, status) {
    const templates = this.#templates(type);
    return templates.find((job) => job.status === status) ?? templates[0];
  }

  #result(program) {
    if (program.result) return clone(program.result);
    const example = this.#templates(program.type).find((job) => job.result?.type === program.type);
    if (example) return clone(example.result);
    const mapping = this.contract.schemas.JobResult.discriminator.mapping;
    return { ...this.contract.build({ $ref: mapping[program.type] }), type: program.type };
  }

  #error(program) {
    const template = this.#templates(program.type).find((job) => job.error);
    const entry = Object.entries(this.contract.jobErrors).find(([, value]) => value.job_types?.includes(program.type));
    const base = template ? clone(template.error) : {
      type: `https://docs.api.rask.ai/errors/${entry?.[0] ?? 'internal_error'}`,
      title: entry?.[1].title ?? 'Internal error',
      status: entry?.[1].status ?? 500,
      detail: `Job ${program.id} failed.`,
      code: entry?.[0] ?? 'internal_error',
      retryable: (entry?.[1].retry ?? 'none') !== 'none',
      retry: entry?.[1].retry ?? 'none',
      recommendation: entry?.[1].recommendation ?? 'retry_later',
      hint: entry?.[1].hint ?? null,
      errors: [],
    };
    return { ...base, instance: `/v3/jobs/${program.id}`, ...(program.error ?? {}) };
  }

  #body(program, status) {
    const job = clone(this.#template(program.type, status));
    job.id = program.id;
    job.type = program.type;
    job.status = status;
    job.links.self = `/v3/jobs/${program.id}`;
    job.result = null;
    job.error = null;
    job.finished_at = null;
    if (status === 'queued') {
      Object.assign(job, { progress: 0, started_at: null, queue_position: 1 });
    } else {
      Object.assign(job, { started_at: NOW, queue_position: null });
    }
    if (status === 'running' || !STATUS_ORDER[status]) job.progress = 50;
    if (isTerminalStatus(status)) Object.assign(job, { finished_at: LATER, estimated_finish_at: null });
    if (status === 'succeeded') Object.assign(job, { progress: 100, result: this.#result(program) });
    if (status === 'failed') job.error = this.#error(program);
    if (status === 'canceled') job.error = program.error ? this.#error(program) : null;
    return job;
  }
}

export class PagePrograms {
  constructor(contract) {
    this.contract = contract;
    this.programs = new Map();
  }

  // sizes: how many items each page holds; a zero with has_more is allowed (DESIGN 4.5).
  create({ operationId, pages, page_size = 2, sizes }) {
    const operation = this.contract.byId.get(operationId);
    if (!operation) throw new ProgramError(`Unknown operationId ${operationId}.`);
    if (operation.meta.pagination !== 'cursor') {
      throw new ProgramError(`${operationId} is not a paged operation.`);
    }
    const pageSizes = sizes ?? Array.from({ length: pages ?? 3 }, () => page_size);
    if (!Array.isArray(pageSizes) || pageSizes.length === 0) throw new ProgramError('sizes must be a non-empty array.');
    const program = { operationId, sizes: pageSizes, item: this.#itemTemplate(operation) };
    this.programs.set(operationId, program);
    return { operationId, sizes: pageSizes, total_items: pageSizes.reduce((sum, size) => sum + size, 0) };
  }

  get(operationId) {
    return this.programs.get(operationId);
  }

  #itemTemplate(operation) {
    const success = operation.responses[operation.successStatus];
    const example = Object.values(success.examples).find((value) => value?.data?.length);
    if (example) return example.data[0];
    const list = this.contract.deref(success.schema);
    return this.contract.build(list.properties.data.items);
  }

  // The filter hash the contract's cursors embed: changed filters answer 400 invalid_cursor (limit is not a filter).
  #filterHash(query) {
    const filters = Object.entries(query).filter(([name]) => name !== 'cursor' && name !== 'limit');
    filters.sort(([a], [b]) => a.localeCompare(b));
    return createHash('sha256').update(JSON.stringify(filters)).digest('hex').slice(0, 12);
  }

  // { body } or { invalidCursor: reason }.
  respond(program, query) {
    const hash = this.#filterHash(query);
    let page = 0;
    if (query.cursor !== undefined) {
      const match = /^page-(\d+)\.([0-9a-f]{12})$/.exec(query.cursor);
      if (!match || Number(match[1]) >= program.sizes.length) {
        return { invalidCursor: `"${query.cursor}" is not a cursor this listing handed out` };
      }
      if (match[2] !== hash) return { invalidCursor: 'the filters changed since this cursor was issued' };
      page = Number(match[1]);
    }
    const before = program.sizes.slice(0, page).reduce((sum, size) => sum + size, 0);
    const data = Array.from({ length: program.sizes[page] }, (_, index) => {
      const item = clone(program.item);
      if ('id' in item) item.id = `${program.operationId}-item-${before + index + 1}`;
      return item;
    });
    const hasMore = page + 1 < program.sizes.length;
    return {
      body: { object: 'list', data, next_cursor: hasMore ? `page-${page + 1}.${hash}` : null, has_more: hasMore },
    };
  }
}

export class Uploads {
  constructor(otherBaseUrl) {
    this.otherBaseUrl = otherBaseUrl;
    this.uploads = new Map();
    this.secret = randomUUID();
  }

  create({ id = randomUUID(), filename, content_type, size_bytes, purpose = 'project_source' }) {
    const upload = {
      id, filename, content_type, size_bytes, purpose,
      status: 'pending', generation: 0, generations: new Map(), put_ok: false, put_sha256: null,
    };
    this.uploads.set(id, upload);
    return upload;
  }

  get(id) {
    return this.uploads.get(id);
  }

  sign(upload, { expired = false } = {}) {
    upload.generation += 1;
    const generation = upload.generation;
    const signature = createHmac('sha256', this.secret).update(`${upload.id}/${generation}`).digest('hex');
    const query = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': 'ACCEPTANCE/20261103/us-east-1/s3/aws4_request',
      'X-Amz-Date': '20261103T090000Z',
      'X-Amz-Expires': '3600',
      'X-Amz-SignedHeaders': 'content-length;content-type;host',
      'X-Amz-Signature': signature,
    }).toString();
    upload.generations.set(generation, { query, expired });
    const offset = expired ? -3600_000 : 3600_000;
    return {
      method: 'single',
      url: `${this.otherBaseUrl}/storage/${upload.id}/${generation}/${encodeURIComponent(upload.filename)}?${query}`,
      headers: { 'Content-Type': upload.content_type, 'Content-Length': String(upload.size_bytes) },
      expires_at: new Date(Date.now() + offset).toISOString().replace(/\.\d+Z$/, 'Z'),
    };
  }
}

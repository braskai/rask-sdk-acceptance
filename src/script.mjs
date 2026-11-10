// Per-operation queues of scripted responses, with the control API's step vocabulary.
import { clone } from './contract.mjs';
import { ProgramError } from './programs.mjs';

export const STORAGE_PUT = '__storage_put';

const STEP_FIELDS = new Set([
  'status', 'problem', 'body', 'raw', 'content_type', 'patch', 'example', 'headers', 'retry_after', 'delay_ms', 'drop',
  'inject', 'deprecation', 'redirect', 'job', 'upload', 'expired', 'repeat', 'off_contract', 'comment',
]);
const STORAGE_STEP_FIELDS = new Set(['status', 'raw', 'content_type', 'headers', 'delay_ms', 'drop', 'expired', 'repeat', 'comment']);
const DROPS = new Set([true, 'before_headers', 'after_headers', 'mid_body']);
const INJECT_FIELDS = new Set(['enum', 'union', 'field']);

const fail = (message) => {
  throw new ProgramError(message);
};

function checkCommon(step, where) {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) fail(`${where}: a step must be an object.`);
  if (step.status !== undefined && !(Number.isInteger(step.status) && step.status >= 200 && step.status <= 599)) {
    fail(`${where}: status must be an HTTP status, got ${step.status}.`);
  }
  if (step.delay_ms !== undefined && !(Number.isFinite(step.delay_ms) && step.delay_ms >= 0)) {
    fail(`${where}: delay_ms must be a number of milliseconds.`);
  }
  if (step.drop !== undefined && !DROPS.has(step.drop)) {
    fail(`${where}: drop must be true, "before_headers", "after_headers" or "mid_body".`);
  }
  if (step.repeat !== undefined && step.repeat !== 'forever' && !(Number.isInteger(step.repeat) && step.repeat >= 1)) {
    fail(`${where}: repeat must be a positive integer or "forever".`);
  }
}

function checkInject(inject, where) {
  if (inject === true) return;
  if (inject === null || typeof inject !== 'object') fail(`${where}: inject must be true or {enum, union, field}.`);
  for (const name of Object.keys(inject)) {
    if (!INJECT_FIELDS.has(name)) fail(`${where}: inject has no field "${name}". Known: enum, union, field.`);
  }
}

// Scripts fail here, at the control call, so an SDK author sees the typo before the SDK runs.
export function checkStep(contract, jobs, operationId, step, index) {
  const where = `${operationId} step ${index}`;
  checkCommon(step, where);
  const storage = operationId === STORAGE_PUT;
  const allowed = storage ? STORAGE_STEP_FIELDS : STEP_FIELDS;
  for (const name of Object.keys(step)) {
    if (!allowed.has(name)) fail(`${where}: unknown field "${name}". Known: ${[...allowed].join(', ')}.`);
  }
  if (storage) return;
  const operation = operationId === '*' ? null : contract.byId.get(operationId);
  if (step.inject !== undefined) checkInject(step.inject, where);
  if (step.problem !== undefined) {
    if (typeof step.problem !== 'string') fail(`${where}: problem must be a problem code.`);
    if (!contract.problemExample(step.problem) && step.status === undefined) {
      fail(`${where}: the contract has no problem "${step.problem}", so give it a status too.`);
    }
  }
  if (step.job !== undefined && !jobs.get(step.job)) {
    fail(`${where}: no job program "${step.job}"; POST /__control/jobs first.`);
  }
  if (step.redirect !== undefined && step.redirect !== 'other') {
    const target = step.redirect;
    if (target === null || typeof target !== 'object' || typeof target.to !== 'string') {
      fail(`${where}: redirect must be "other" or {to: "other" | absolute URL, status?}.`);
    }
  }
  if (step.upload !== undefined && operationId !== 'createUpload' && operationId !== 'getUpload') {
    fail(`${where}: upload only applies to createUpload and getUpload.`);
  }
  if (step.expired !== undefined) fail(`${where}: expired only applies to ${STORAGE_PUT}.`);
  if (!operation) return;
  if (step.example !== undefined) {
    const { examples } = operation.responses[operation.successStatus];
    if (!Object.hasOwn(examples, step.example)) {
      fail(`${where}: no example "${step.example}". Known: ${Object.keys(examples).join(', ') || '(none)'}.`);
    }
  }
  if (step.body !== undefined && !step.off_contract) {
    const status = step.status ?? Number(operation.successStatus);
    const schema = operation.responses[status]?.schema ?? (status >= 400 ? { $ref: '#/components/schemas/Problem' } : null);
    if (schema) {
      const errors = contract.validate(schema, step.body, { open: true });
      if (errors.length > 0) {
        const detail = errors.slice(0, 5).map((error) => `${error.pointer || '/'} ${error.message}`).join('; ');
        fail(`${where}: body does not validate against the contract: ${detail}. Set off_contract: true if that is the point.`);
      }
    }
  }
}

export class ScriptQueues {
  constructor() {
    this.queues = new Map();
  }

  set(operationId, steps, { append = false } = {}) {
    const queued = steps.map((step) => ({ ...clone(step), remaining: step.repeat ?? 1 }));
    this.queues.set(operationId, append ? [...(this.queues.get(operationId) ?? []), ...queued] : queued);
    return this.queues.get(operationId).length;
  }

  // The next step for this operation (or the "*" queue); null means answer normally.
  next(operationId) {
    return this.#take(operationId) ?? (operationId === STORAGE_PUT ? null : this.#take('*'));
  }

  #take(id) {
    const queue = this.queues.get(id);
    if (!queue?.length) return null;
    const step = queue[0];
    if (step.remaining === 'forever') return step;
    step.remaining -= 1;
    if (step.remaining === 0) queue.shift();
    return step;
  }

  view() {
    return Object.fromEntries(this.queues);
  }

  clear() {
    this.queues.clear();
  }
}

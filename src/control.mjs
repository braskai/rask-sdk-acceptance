// The control API, under /__control, outside the API prefix. Plain JSON, so any language can drive it.
import { ProgramError } from './programs.mjs';
import { STORAGE_PUT, checkStep } from './script.mjs';
import { verify } from './verify.mjs';

class ControlError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const parseJson = (buffer) => {
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new ControlError(400, `The control body is not valid JSON: ${error.message}`);
  }
};

export class ControlApi {
  constructor(harness) {
    this.harness = harness;
    const route = (method, template, handler) => {
      const pattern = new RegExp(`^${template.replace(/\{id\}/g, '([^/]+)')}$`);
      return { method, template, pattern, handler };
    };
    this.routes = [
      route('GET', '/__control/health', () => this.health()),
      route('GET', '/__control/operations', (_, query) => this.operations(query)),
      route('GET', '/__control/requests', (_, query) => this.requests(query)),
      route('DELETE', '/__control/requests', () => this.clearRequests()),
      route('POST', '/__control/reset', () => this.reset()),
      route('GET', '/__control/script', () => harness.scripts.view()),
      route('POST', '/__control/script', (body) => this.script(body)),
      route('POST', '/__control/pages', (body) => this.pages(body)),
      route('POST', '/__control/jobs', (body) => this.createJob(body)),
      route('GET', '/__control/jobs/{id}', (_, __, match) => this.getJob(match[1])),
      route('GET', '/__control/uploads/{id}', (_, __, match) => this.getUpload(match[1])),
      route('GET', '/__control/scenarios', (_, query) => this.scenarioList(query)),
      route('GET', '/__control/scenarios/{id}', (_, __, match) => this.scenario(match[1])),
      route('POST', '/__control/scenarios/{id}/start', (body, _, match) => this.startScenario(match[1], body)),
      route('POST', '/__control/scenarios/{id}/verify', (body, _, match) => this.verifyScenario(match[1], body)),
      route('GET', '/__control/report', (_, query) => this.report(query)),
      route('DELETE', '/__control/report', () => this.clearReport()),
    ];
  }

  // Also runs a scenario's `setup`, so its entries behave exactly like the HTTP calls an author could make.
  dispatch(method, path, query, body) {
    const allowed = [];
    for (const route of this.routes) {
      const match = route.pattern.exec(path);
      if (!match) continue;
      if (route.method === method) return route.handler(body, query, match);
      allowed.push(route.method);
    }
    if (allowed.length > 0) throw new ControlError(405, `${method} ${path}: use ${allowed.join(' or ')}.`);
    throw new ControlError(404, `No control endpoint ${method} ${path}. See GET /__control/health for the list.`);
  }

  async handle(req, res, path, rawQuery, buffer) {
    let status = 200;
    let payload;
    try {
      payload = this.dispatch(req.method, path, new URLSearchParams(rawQuery), parseJson(buffer));
    } catch (error) {
      if (error instanceof ControlError) status = error.status;
      else if (error instanceof ProgramError) status = 400;
      else throw error;
      payload = { error: error.message };
    }
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  health() {
    const { harness } = this;
    return {
      ok: true,
      contract_version: harness.contract.version,
      operations: harness.contract.operations.length,
      prefix: harness.prefix,
      base_url: harness.baseUrl,
      other_base_url: harness.otherBaseUrl,
      control_url: harness.controlUrl,
      test_api_key: harness.scenarios.data.constants.api_key,
      scenarios: harness.scenarios.scenarios.length,
      endpoints: this.routes.map((route) => `${route.method} ${route.template}`),
    };
  }

  operations(query) {
    const { contract } = this.harness;
    const wanted = query.get('operationId');
    const operations = contract.operations.filter((operation) => !wanted || operation.operationId === wanted);
    if (wanted && operations.length === 0) throw new ControlError(404, `Unknown operationId ${wanted}.`);
    return {
      operations: operations.map((operation) => {
        const idempotency = operation.parameters.header.find((p) => p.name === 'Idempotency-Key');
        const ifMatch = operation.parameters.header.find((p) => p.name === 'If-Match');
        return {
          operationId: operation.operationId,
          method: operation.method,
          path: operation.path,
          idempotency_key: idempotency ? (idempotency.required ? 'required' : 'optional') : 'none',
          if_match: ifMatch ? (ifMatch.required ? 'required' : 'optional') : 'none',
          pagination: operation.meta.pagination ?? 'none',
          async: operation.meta.async ?? 'none',
          success_status: Number(operation.successStatus),
          has_json_response: Boolean(operation.responses[operation.successStatus].schema),
          sample: contract.sampleRequest(operation),
        };
      }),
    };
  }

  requests(query) {
    let records = this.harness.records;
    const operationId = query.get('operationId');
    const listener = query.get('listener');
    const since = query.get('since_seq');
    if (operationId) records = records.filter((record) => record.operationId === operationId);
    if (listener) records = records.filter((record) => record.listener === listener);
    if (since) records = records.filter((record) => record.seq > Number(since));
    return { requests: records };
  }

  clearRequests() {
    this.harness.clearRecords();
    return { ok: true };
  }

  reset() {
    this.harness.resetState();
    return { ok: true };
  }

  script({ operationId, steps, append = false, ...rest }) {
    const { contract, jobs, scripts } = this.harness;
    if (Object.keys(rest).length > 0) throw new ControlError(400, `Unknown fields: ${Object.keys(rest).join(', ')}. A script is {operationId, steps, append?}.`);
    if (operationId !== '*' && operationId !== STORAGE_PUT && !contract.byId.has(operationId)) {
      throw new ControlError(400, `Unknown operationId ${operationId}. See GET /__control/operations; "*" and "${STORAGE_PUT}" are also allowed.`);
    }
    if (!Array.isArray(steps) || steps.length === 0) throw new ControlError(400, 'steps must be a non-empty array.');
    steps.forEach((step, index) => checkStep(contract, jobs, operationId, step, index));
    return { operationId, queued: scripts.set(operationId, steps, { append }) };
  }

  pages(body) {
    return this.harness.pages.create(body);
  }

  createJob(body) {
    const program = this.harness.jobs.create(body);
    return { id: program.id, type: program.type, states: program.states };
  }

  getJob(id) {
    const program = this.harness.jobs.get(id);
    if (!program) throw new ControlError(404, `No job program ${id}.`);
    return { id, type: program.type, states: program.states, polls: program.polls };
  }

  getUpload(id) {
    const upload = this.harness.uploads.get(id);
    if (!upload) throw new ControlError(404, `No upload ${id}.`);
    const { generations, ...rest } = upload;
    return { ...rest, expired_generations: [...generations].filter(([, value]) => value.expired).map(([key]) => key) };
  }

  scenarioList(query) {
    const lang = query.get('lang');
    const list = this.harness.scenarios;
    return {
      scenarios: list.scenarios.map((scenario) => ({
        id: scenario.id,
        design: scenario.design,
        title: scenario.title,
        status: scenario.status ?? 'active',
        slow: Boolean(scenario.slow),
        applies: list.applies(scenario, lang),
      })),
    };
  }

  #resolved(id, lang) {
    const { languages } = this.harness.scenarios.data.defaults;
    const known = languages.includes(lang) ? lang : `(${languages.join('|')})`;
    const scenario = this.harness.scenarios.resolve(id, { ...this.harness.scenarioVars(), lang: known });
    if (!scenario) throw new ControlError(404, `No scenario ${id}. See GET /__control/scenarios.`);
    return scenario;
  }

  scenario(id) {
    return this.#resolved(id);
  }

  startScenario(id, { lang } = {}) {
    const scenario = this.#resolved(id, lang);
    this.harness.resetState();
    for (const entry of scenario.setup) {
      try {
        this.dispatch(entry.method, entry.path, new URLSearchParams(), entry.body ?? {});
      } catch (error) {
        throw new ControlError(500, `Scenario ${id}: setup ${entry.method} ${entry.path} failed: ${error.message}`);
      }
    }
    const applies = this.harness.scenarios.applies(scenario, lang);
    return { ...scenario, applies };
  }

  verifyScenario(id, { lang = 'unspecified', sdk_passed: sdkPassed, sdk_detail: sdkDetail } = {}) {
    const scenario = this.#resolved(id, lang);
    const failures = verify(scenario, this.harness.records);
    if (sdkPassed === false) failures.push({ check: 'sdk', message: sdkDetail ?? 'the language test reported an SDK-side failure' });
    const pass = failures.length === 0;
    const result = { scenario: id, lang, pass, failures, requests: this.harness.records.length };
    this.harness.recordResult(lang, id, result);
    return result;
  }

  // Which scenarios a language ran, so a language cannot pass by leaving some out. Slow ones count only with ?slow=true.
  report(query) {
    const { harness } = this;
    const lang = query.get('lang');
    if (!lang) return { languages: Object.fromEntries([...harness.results.keys()].map((name) => [name, this.#languageReport(name, query)])) };
    return this.#languageReport(lang, query);
  }

  #languageReport(lang, query) {
    const { harness } = this;
    const includeSlow = query.get('slow') === 'true';
    const results = harness.results.get(lang) ?? new Map();
    const applicable = harness.scenarios.scenarios.filter((scenario) => harness.scenarios.applies(scenario, lang));
    const passed = [];
    const failed = [];
    const notRun = [];
    const slowNotRun = [];
    for (const scenario of applicable) {
      const result = results.get(scenario.id);
      if (!result) (scenario.slow && !includeSlow ? slowNotRun : notRun).push(scenario.id);
      else if (result.pass) passed.push(scenario.id);
      else failed.push({ id: scenario.id, failures: result.failures });
    }
    return { lang, complete: failed.length === 0 && notRun.length === 0, passed, failed, not_run: notRun, slow_not_run: slowNotRun };
  }

  clearReport() {
    this.harness.results.clear();
    return { ok: true };
  }
}

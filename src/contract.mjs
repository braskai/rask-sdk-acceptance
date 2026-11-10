import { readFileSync } from 'node:fs';

import { SchemaValidator, buildSample, unsupportedKeywords } from './schema.mjs';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

export const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export class Contract {
  constructor(specPath) {
    this.spec = JSON.parse(readFileSync(specPath, 'utf8'));
    this.version = this.spec.info.version;
    this.schemas = this.spec.components.schemas;
    this.validator = new SchemaValidator(this.spec);
    const unsupported = unsupportedKeywords(this.schemas);
    if (unsupported.length > 0) {
      throw new Error(`The contract uses schema keywords the validator does not implement: ${unsupported.join('; ')}`);
    }
    this.operations = [];
    this.byId = new Map();
    this.pathTable = [];
    for (const [path, item] of Object.entries(this.spec.paths)) {
      const segments = path.split('/').slice(1);
      const entry = { path, segments, methods: new Map() };
      for (const method of METHODS) {
        if (!item[method]) continue;
        const operation = this.#normalize(path, method, item[method]);
        this.operations.push(operation);
        this.byId.set(operation.operationId, operation);
        entry.methods.set(method.toUpperCase(), operation);
      }
      this.pathTable.push(entry);
    }
    // A literal segment beats a parameter: /projects/estimate is not getProject("estimate").
    const literals = (entry) => entry.segments.filter((segment) => !segment.startsWith('{')).length;
    this.pathTable.sort((a, b) => literals(b) - literals(a));
    this.jobTemplates = this.#collectJobTemplates();
    this.jobErrors = this.spec.components['x-rask-job-errors']?.codes ?? {};
  }

  deref(node) {
    return this.validator.deref(node);
  }

  validate(schema, value, options) {
    return this.validator.validate(schema, value, options);
  }

  build(schema) {
    return buildSample(this.validator, schema);
  }

  #normalize(path, method, raw) {
    const parameters = (raw.parameters ?? []).map((parameter) => this.deref(parameter));
    const byLocation = (location) => parameters.filter((parameter) => parameter.in === location);
    const responses = {};
    for (const [status, response] of Object.entries(raw.responses)) {
      responses[status] = this.#normalizeResponse(response);
    }
    const successStatus = Object.keys(responses).filter((status) => status.startsWith('2')).sort()[0];
    return {
      operationId: raw.operationId,
      method: method.toUpperCase(),
      path,
      meta: raw['x-rask-operation'] ?? {},
      parameters: { path: byLocation('path'), query: byLocation('query'), header: byLocation('header') },
      requestBody: raw.requestBody ? this.#normalizeRequestBody(raw.requestBody) : null,
      responses,
      successStatus,
    };
  }

  #normalizeRequestBody(raw) {
    const body = this.deref(raw);
    const content = body.content['application/json'];
    return { required: Boolean(body.required), schema: content.schema, examples: this.#examples(content) };
  }

  #normalizeResponse(raw) {
    const response = this.deref(raw);
    const headers = {};
    const headerRefs = {};
    for (const [name, header] of Object.entries(response.headers ?? {})) {
      headers[name] = this.deref(header);
      headerRefs[name] = header.$ref ? header.$ref.split('/').at(-1) : name;
    }
    const mediaType = Object.keys(response.content ?? {})[0] ?? null;
    const content = mediaType ? response.content[mediaType] : null;
    return {
      headers,
      headerRefs,
      mediaType,
      schema: content?.schema ?? null,
      examples: content ? this.#examples(content) : {},
    };
  }

  #examples(content) {
    const examples = {};
    for (const [name, example] of Object.entries(content.examples ?? {})) examples[name] = this.deref(example).value;
    return examples;
  }

  #collectJobTemplates() {
    const templates = new Map();
    const add = (job) => {
      if (!job || job.object !== 'job') return;
      if (!templates.has(job.type)) templates.set(job.type, []);
      templates.get(job.type).push(job);
    };
    for (const operation of this.operations) {
      for (const response of Object.values(operation.responses)) {
        for (const example of Object.values(response.examples)) {
          add(example);
          if (example?.object === 'list') example.data.forEach(add);
        }
      }
    }
    return templates;
  }

  // The operation at `path` (relative to the API root): { operation, pathParams }, { allowed: [...] } when only the
  // method is wrong, or null.
  route(method, path) {
    const parts = path.split('/').slice(1);
    for (const entry of this.pathTable) {
      if (entry.segments.length !== parts.length) continue;
      const pathParams = {};
      const matched = entry.segments.every((segment, index) => {
        if (!segment.startsWith('{')) return segment === parts[index];
        if (parts[index] === '') return false;
        try {
          pathParams[segment.slice(1, -1)] = decodeURIComponent(parts[index]);
        } catch {
          pathParams[segment.slice(1, -1)] = parts[index];
        }
        return true;
      });
      if (!matched) continue;
      const operation = entry.methods.get(method);
      return operation ? { operation, pathParams } : { allowed: [...entry.methods.keys()], path: entry.path };
    }
    return null;
  }

  problemExample(code) {
    return this.spec.components.examples[code]?.value ?? null;
  }

  // A request an SDK may send for this operation, built from the contract's own examples.
  sampleRequest(operation) {
    const path = {};
    for (const parameter of operation.parameters.path) {
      path[parameter.name] = parameter.example ?? this.build(parameter.schema);
    }
    const query = {};
    for (const parameter of operation.parameters.query) {
      if (!parameter.required) continue;
      const value = parameter.example ?? this.build(parameter.schema);
      query[parameter.name] = Array.isArray(value) ? value.join(',') : value;
    }
    const headers = {};
    for (const parameter of operation.parameters.header) {
      if (parameter.required) headers[parameter.name] = parameter.example;
    }
    let body = null;
    if (operation.requestBody) {
      const first = Object.values(operation.requestBody.examples)[0];
      if (first !== undefined) body = clone(first);
      else if (operation.requestBody.required) body = this.build(operation.requestBody.schema);
    }
    return { path, query, headers, body };
  }
}

export function headerParameter(operation, name) {
  return operation.parameters.header.find((parameter) => parameter.name.toLowerCase() === name.toLowerCase());
}

import { headerParameter } from './contract.mjs';

// DESIGN 4.2: request size caps, with the DV-13 exceptions.
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = {
  createProject: 5 * 1024 * 1024,
  importTranscript: 5 * 1024 * 1024,
  createGlossary: 10 * 1024 * 1024,
  updateGlossary: 10 * 1024 * 1024,
};

// The names a real server refuses with 400 token_in_query (routes/v3/deps.py TOKEN_QUERY_PARAMETERS).
const CREDENTIAL_QUERY_NAMES = new Set(['access_token', 'api_key', 'token']);
const ETAG = /^(W\/)?"[^"]*"$/;

const violation = (pointer, code, detail) => ({ pointer, code, detail });

const coerceScalar = (schema, raw) => {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('integer') && /^-?\d+$/.test(raw)) return Number(raw);
  if (types.includes('number') && raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
  if (types.includes('boolean') && (raw === 'true' || raw === 'false')) return raw === 'true';
  return raw;
};

function checkQuery(contract, operation, rawQuery, violations) {
  const params = new URLSearchParams(rawQuery);
  const declared = new Map(operation.parameters.query.map((parameter) => [parameter.name, parameter]));
  const query = {};
  for (const name of new Set(params.keys())) {
    const parameter = declared.get(name);
    if (!parameter) {
      const known = [...declared.keys()].join(', ') || '(none)';
      violations.push(violation(`query:${name}`, 'unknown_query_parameter',
        `${operation.operationId} has no query parameter "${name}". Known: ${known}.`));
      continue;
    }
    const values = params.getAll(name);
    const schema = contract.deref(parameter.schema);
    if (values.length > 1) {
      const form = schema.type === 'array' ? ' Arrays are style=form, explode=false: send one comma-separated value.' : '';
      violations.push(violation(`query:${name}`, 'repeated_query_parameter', `"${name}" was sent ${values.length} times.${form}`));
      continue;
    }
    const value = schema.type === 'array'
      ? values[0].split(',').map((item) => coerceScalar(contract.deref(schema.items), item))
      : coerceScalar(schema, values[0]);
    query[name] = value;
    for (const error of contract.validate(parameter.schema, value)) {
      violations.push(violation(`query:${name}${error.pointer}`, 'invalid_query_parameter', `"${name}" ${error.message}.`));
    }
  }
  for (const parameter of operation.parameters.query) {
    if (parameter.required && !params.has(parameter.name)) {
      violations.push(violation(`query:${parameter.name}`, 'missing_query_parameter',
        `${operation.operationId} requires the query parameter "${parameter.name}".`));
    }
  }
  return query;
}

function checkPath(contract, operation, pathParams, violations) {
  for (const parameter of operation.parameters.path) {
    const schema = contract.deref(parameter.schema);
    const value = coerceScalar(schema, pathParams[parameter.name]);
    for (const error of contract.validate(parameter.schema, value)) {
      violations.push(violation(`path:${parameter.name}`, 'invalid_path_parameter', `"${parameter.name}" ${error.message}.`));
    }
  }
}

function checkHeaders(contract, operation, headers, violations) {
  for (const parameter of operation.parameters.header) {
    const value = headers[parameter.name.toLowerCase()];
    if (value === undefined) {
      if (parameter.required) {
        const reason = parameter.name === 'If-Match'
          ? `${operation.operationId} requires If-Match with the current ETag (a real server answers 428 precondition_required).`
          : `${operation.operationId} requires ${parameter.name} (a real server answers 400 idempotency_key_required).`;
        violations.push(violation(`header:${parameter.name}`, 'missing_required_header', reason));
      }
      continue;
    }
    for (const error of contract.validate(parameter.schema, value)) {
      violations.push(violation(`header:${parameter.name}`, 'invalid_header', `${parameter.name} ${error.message}.`));
    }
    if (parameter.name === 'If-Match') {
      if (value.trim() === '*') {
        violations.push(violation('header:If-Match', 'if_match_wildcard',
          'If-Match: * is forbidden (DV-7; a real server answers 428). Send the ETag you read.'));
      } else if (!ETAG.test(value.trim())) {
        violations.push(violation('header:If-Match', 'if_match_not_an_etag',
          `If-Match must be the ETag exactly as read, quotes included (e.g. "s-a197265875140819"); got ${value}.`));
      }
    }
  }
  // DESIGN 4.6 and 4.7 list exactly who takes these headers; a key on GET or on an ordinary DELETE is an SDK bug.
  for (const name of ['Idempotency-Key', 'If-Match', 'If-None-Match']) {
    if (headers[name.toLowerCase()] !== undefined && !headerParameter(operation, name)) {
      violations.push(violation(`header:${name}`, 'undeclared_header', `${operation.operationId} does not take ${name}.`));
    }
  }
}

function checkBody(contract, operation, headers, buffer, violations) {
  const { requestBody } = operation;
  if (buffer.length === 0) {
    if (requestBody?.required) {
      violations.push(violation('body', 'missing_body', `${operation.operationId} requires a JSON body.`));
    }
    return undefined;
  }
  if (!requestBody) {
    violations.push(violation('body', 'unexpected_body',
      `${operation.operationId} takes no request body; ${buffer.length} bytes were sent.`));
    return undefined;
  }
  const maxBytes = MAX_BODY_BYTES[operation.operationId] ?? DEFAULT_MAX_BODY_BYTES;
  if (buffer.length > maxBytes) {
    violations.push(violation('body', 'body_too_large',
      `${operation.operationId} accepts at most ${maxBytes} bytes; got ${buffer.length} (a real server answers 413 request_too_large).`));
  }
  const contentType = (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    violations.push(violation('header:Content-Type', 'invalid_content_type',
      `A JSON body needs Content-Type: application/json; got ${headers['content-type'] ?? '(none)'}.`));
  }
  let body;
  try {
    body = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    violations.push(violation('body', 'invalid_json', `The body is not valid JSON: ${error.message}.`));
    return undefined;
  }
  for (const error of contract.validate(requestBody.schema, body)) {
    violations.push(violation(error.pointer || '/', 'invalid_body', `${error.pointer || 'body'} ${error.message}.`));
  }
  return body;
}

// Everything the contract says about one request. `auth` and `credentialInQuery` are kept apart because the contract
// names their own answers (401, 400 token_in_query).
export function checkRequest({ contract, operation, pathParams, rawQuery, headers, buffer }) {
  const violations = [];
  checkPath(contract, operation, pathParams, violations);
  const query = checkQuery(contract, operation, rawQuery, violations);
  checkHeaders(contract, operation, headers, violations);
  const body = checkBody(contract, operation, headers, buffer, violations);
  const credentialInQuery = [...new URLSearchParams(rawQuery).keys()].find(
    (name) => CREDENTIAL_QUERY_NAMES.has(name),
  ) ?? null;
  const authorization = headers.authorization;
  let auth = null;
  if (authorization === undefined) auth = 'authentication_required';
  else if (!/^Bearer \S+$/i.test(authorization)) auth = 'invalid_token';
  return { violations, query, body, auth, credentialInQuery };
}

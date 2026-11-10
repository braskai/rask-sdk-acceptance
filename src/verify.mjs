// Evaluates a scenario's wire assertions against the recorded requests. The vocabulary is listed in the README and is
// deliberately small: a language's tests can evaluate the same data themselves from GET /__control/requests.

export const ASSERTIONS = new Set([
  'count', 'header', 'query', 'path', 'body', 'status', 'field', 'same', 'distinct', 'gap_at_least_ms',
  'total_gap_at_least_ms', 'total_gap_at_most_ms', 'order',
]);

const select = (records, where = {}) => records.filter((record) => {
  if (where.listener !== undefined && record.listener !== where.listener) return false;
  if (where.operationId !== undefined && record.operationId !== where.operationId) return false;
  if (where.method !== undefined && record.method !== where.method) return false;
  if (where.path !== undefined && record.path !== where.path) return false;
  if (where.status !== undefined && record.response?.status !== where.status) return false;
  return true;
});

const pick = (records, nth) => {
  if (nth === undefined) return records;
  const record = records.at(nth);
  return record ? [record] : [];
};

const readPointer = (value, pointer) => {
  if (pointer === '' || pointer === undefined) return value;
  let node = value;
  for (const part of pointer.slice(1).split('/')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return node;
};

const fieldOf = (record, field) => {
  if (field.startsWith('header:')) return record.headers[field.slice(7).toLowerCase()];
  if (field.startsWith('query:')) return record.raw_query_params[field.slice(6)];
  if (field.startsWith('body:')) return JSON.stringify(readPointer(record.body, field.slice(5)));
  if (field === 'body_sha256') return record.body_sha256;
  if (field === 'path') return record.path;
  if (field === 'url') return record.url;
  throw new Error(`Unknown field ${field}`);
};

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const describeWhere = (where = {}) => (Object.keys(where).length ? JSON.stringify(where) : 'all requests');

// equals / matches / absent / one_of / present against one value; a failure message or null.
function compare(assertion, value, what) {
  if (assertion.absent) return value === undefined ? null : `${what} must be absent, got ${JSON.stringify(value)}`;
  if (assertion.present) return value !== undefined ? null : `${what} must be present`;
  if (value === undefined) return `${what} is missing`;
  if (assertion.equals !== undefined && !sameValue(value, assertion.equals)) {
    return `${what} must equal ${JSON.stringify(assertion.equals)}, got ${JSON.stringify(value)}`;
  }
  if (assertion.matches !== undefined && !new RegExp(assertion.matches).test(String(value))) {
    return `${what} must match ${assertion.matches}, got ${JSON.stringify(value)}`;
  }
  if (assertion.one_of !== undefined && !assertion.one_of.some((option) => sameValue(option, value))) {
    return `${what} must be one of ${JSON.stringify(assertion.one_of)}, got ${JSON.stringify(value)}`;
  }
  return null;
}

function compareEach(assertion, records, read, label) {
  const targets = pick(select(records, assertion.where), assertion.nth);
  if (targets.length === 0) {
    return assertion.only_if_any ? [] : [`no request matches ${describeWhere(assertion.where)} (nth ${assertion.nth ?? 'any'})`];
  }
  return targets
    .map((record) => compare(assertion, read(record), `${label} of request #${record.seq} (${record.operationId ?? record.path})`))
    .filter(Boolean);
}

const gapBetween = (a, b) => b.received_at_ms - a.received_at_ms;

const CHECKS = {
  count(assertion, records) {
    const { length } = select(records, assertion.where);
    const label = `${describeWhere(assertion.where)}: saw ${length} request(s)`;
    if (assertion.equals !== undefined && length !== assertion.equals) return [`${label}, expected exactly ${assertion.equals}`];
    if (assertion.at_least !== undefined && length < assertion.at_least) return [`${label}, expected at least ${assertion.at_least}`];
    if (assertion.at_most !== undefined && length > assertion.at_most) return [`${label}, expected at most ${assertion.at_most}`];
    return [];
  },
  header(assertion, records) {
    return compareEach(assertion, records, (record) => record.headers[assertion.name.toLowerCase()], `header ${assertion.name}`);
  },
  query(assertion, records) {
    return compareEach(assertion, records, (record) => record.raw_query_params[assertion.name], `query ${assertion.name}`);
  },
  path(assertion, records) {
    return compareEach(assertion, records, (record) => record.path, 'path');
  },
  body(assertion, records) {
    return compareEach(assertion, records, (record) => readPointer(record.body, assertion.pointer), `body ${assertion.pointer || '/'}`);
  },
  status(assertion, records) {
    return compareEach(assertion, records, (record) => record.response?.status, 'response status');
  },
  field(assertion, records) {
    return compareEach(assertion, records, (record) => fieldOf(record, assertion.field), assertion.field);
  },
  same(assertion, records) {
    const targets = select(records, assertion.where);
    if (targets.length < 2) return [`${describeWhere(assertion.where)}: need at least 2 requests to compare ${assertion.field}, saw ${targets.length}`];
    const values = targets.map((record) => fieldOf(record, assertion.field));
    if (values[0] === undefined) return [`${assertion.field} is missing on request #${targets[0].seq}`];
    return values.every((value) => value === values[0]) ? []
      : [`${assertion.field} must not change across retries, saw ${JSON.stringify(values)}`];
  },
  distinct(assertion, records) {
    const values = select(records, assertion.where).map((record) => fieldOf(record, assertion.field));
    if (values.length < 2) return [`${describeWhere(assertion.where)}: need at least 2 requests to compare ${assertion.field}, saw ${values.length}`];
    return new Set(values).size === values.length ? []
      : [`${assertion.field} must differ between calls, saw ${JSON.stringify(values)}`];
  },
  gap_at_least_ms(assertion, records) {
    const targets = select(records, assertion.where);
    const [from, to] = assertion.between ?? [0, 1];
    if (!targets[from] || !targets[to]) return [`${describeWhere(assertion.where)}: need requests ${from} and ${to}, saw ${targets.length}`];
    const gap = gapBetween(targets[from], targets[to]);
    return gap >= assertion.ms ? [] : [`gap between requests ${from} and ${to} is ${gap} ms, expected at least ${assertion.ms} ms`];
  },
  total_gap_at_least_ms(assertion, records) {
    const targets = select(records, assertion.where);
    if (targets.length < 2) return [`${describeWhere(assertion.where)}: need at least 2 requests, saw ${targets.length}`];
    const gap = gapBetween(targets[0], targets.at(-1));
    return gap >= assertion.ms ? [] : [`first to last request took ${gap} ms, expected at least ${assertion.ms} ms`];
  },
  total_gap_at_most_ms(assertion, records) {
    const targets = select(records, assertion.where);
    if (targets.length < 2) return [];
    const gap = gapBetween(targets[0], targets.at(-1));
    return gap <= assertion.ms ? [] : [`first to last request took ${gap} ms, expected at most ${assertion.ms} ms`];
  },
  order(assertion, records) {
    const seen = records.map((record) => record.operationId);
    let position = 0;
    for (const expected of assertion.sequence) {
      position = seen.indexOf(expected, position);
      if (position === -1) return [`expected ${assertion.sequence.join(' -> ')} in order, saw ${seen.join(', ')}`];
      position += 1;
    }
    return [];
  },
};

// Always on: an SDK cannot pass a scenario by breaking the contract, by handing the key to another host, or by getting a
// response the harness itself should not have produced.
function implicitFailures(scenario, records) {
  const failures = [];
  for (const record of records) {
    if (!scenario.allow_violations) {
      for (const violation of record.violations) {
        failures.push({ check: 'contract', message: `request #${record.seq} ${record.method} ${record.path}: ${violation.detail}` });
      }
    }
    if (record.listener === 'other' && record.headers.authorization !== undefined) {
      failures.push({ check: 'key_leak', message: `request #${record.seq} ${record.method} ${record.url} sent Authorization to another host` });
    }
    for (const error of record.response?.self_check ?? []) {
      failures.push({ check: 'harness', message: `the harness answered off-contract at ${error.pointer || '/'}: ${error.message}` });
    }
  }
  return failures;
}

export function verify(scenario, records) {
  const failures = implicitFailures(scenario, records);
  for (const assertion of scenario.wire ?? []) {
    for (const message of CHECKS[assertion.assert](assertion, records)) {
      failures.push({ check: assertion.assert, message, assertion });
    }
  }
  return failures;
}

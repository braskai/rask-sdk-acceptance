import { readFileSync } from 'node:fs';

import { ASSERTIONS } from './verify.mjs';

export const SDK_EXPECTATIONS = new Set([
  'returned', 'raised', 'returned_or_raised', 'raised_before_network', 'config', 'repr_redacts', 'field', 'header_exposed',
  'idempotency_key_exposed', 'items', 'pages', 'warnings', 'progress', 'logs', 'injected_values_preserved', 'manual',
]);
export const HELPERS = new Set(['jobs.wait', 'uploads.upload_file', 'iterate', 'first_page', 'next_page', 'sweep_operations']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const applyVars = (value, vars) => {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      if (!(name in vars)) throw new Error(`Unknown scenario variable ${match}`);
      return vars[name];
    });
  }
  if (Array.isArray(value)) return value.map((item) => applyVars(item, vars));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, applyVars(item, vars)]));
  return value;
};

export class ScenarioList {
  constructor(path) {
    this.data = JSON.parse(readFileSync(path, 'utf8'));
    this.byId = new Map(this.data.scenarios.map((scenario) => [scenario.id, scenario]));
  }

  get scenarios() {
    return this.data.scenarios;
  }

  // The scenario as an SDK test uses it: defaults merged, {{variables}} filled in.
  resolve(id, vars) {
    const scenario = this.byId.get(id);
    if (!scenario) return null;
    const allVars = { ...this.data.constants, ...vars };
    const defaults = this.data.defaults;
    return applyVars({
      languages: defaults.languages,
      status: 'active',
      slow: false,
      setup: [],
      calls: [],
      wire: [],
      expect_sdk: [],
      ...scenario,
      client: { args: scenario.client?.args ?? defaults.client.args, env: scenario.client?.env ?? defaults.client.env },
    }, allVars);
  }

  applies(scenario, lang) {
    if ((scenario.status ?? 'active') !== 'active') return false;
    const languages = scenario.languages ?? this.data.defaults.languages;
    return !lang || languages.includes(lang);
  }
}

// Problems in the data itself; a broken list would pass silently in five languages.
export function lintScenarios(list, contract) {
  const problems = [];
  const seen = new Set();
  const { languages } = list.data.defaults;
  for (const scenario of list.scenarios) {
    const where = scenario.id ?? '(no id)';
    if (seen.has(where)) problems.push(`${where}: duplicate id`);
    seen.add(where);
    if (!scenario.title) problems.push(`${where}: no title`);
    if (!Array.isArray(scenario.design) || scenario.design.length === 0) problems.push(`${where}: no design reference`);
    for (const language of scenario.languages ?? []) {
      if (!languages.includes(language)) problems.push(`${where}: unknown language ${language}`);
    }
    for (const assertion of scenario.wire ?? []) {
      if (!ASSERTIONS.has(assertion.assert)) problems.push(`${where}: unknown assertion ${assertion.assert}`);
      const id = assertion.where?.operationId;
      if (id && id !== '__storage_put' && !contract.byId.has(id)) problems.push(`${where}: unknown operation ${id}`);
    }
    for (const expectation of scenario.expect_sdk ?? []) {
      if (!SDK_EXPECTATIONS.has(expectation.kind)) problems.push(`${where}: unknown expectation ${expectation.kind}`);
    }
    for (const call of scenario.calls ?? []) {
      if (call.op && !contract.byId.has(call.op)) problems.push(`${where}: unknown operation ${call.op}`);
      if (call.helper && !HELPERS.has(call.helper)) problems.push(`${where}: unknown helper ${call.helper}`);
      if (!call.op && !call.helper) problems.push(`${where}: a call needs op or helper`);
    }
    for (const entry of scenario.setup ?? []) {
      if (!entry.method || !entry.path?.startsWith('/__control/')) problems.push(`${where}: bad setup entry ${JSON.stringify(entry)}`);
    }
    if (scenario.status === 'active' || scenario.status === undefined) {
      if (!scenario.wire?.length && !scenario.expect_sdk?.length) problems.push(`${where}: asserts nothing`);
    }
  }
  return problems;
}

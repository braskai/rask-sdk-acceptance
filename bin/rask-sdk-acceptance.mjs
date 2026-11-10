#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { DEFAULT_PREFIX, Harness } from '../src/harness.mjs';

const USAGE = `Usage: rask-sdk-acceptance [options]

Options:
  --port <n>                API and control listener; 0 picks a free port (default 4010)
  --other-port <n>          "Another host" listener (default port + 1)
  --prefix <path>           API path prefix (default ${DEFAULT_PREFIX})
  --host <addr>             Bind address (default 127.0.0.1; the Docker image uses 0.0.0.0)
  --public-host <name>      Host name in the printed base URL (default: the bind address)
  --other-public-host <name>  Host name of the other host in URLs it hands out (default localhost)
  --spec <file>             Contract to serve (default contract/openapi.json)
  --scenarios <file>        Scenario list (default scenarios/scenarios.json)
  --help                    This text
`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      port: { type: 'string' },
      'other-port': { type: 'string' },
      prefix: { type: 'string' },
      host: { type: 'string' },
      'public-host': { type: 'string' },
      'other-public-host': { type: 'string' },
      spec: { type: 'string' },
      scenarios: { type: 'string' },
      help: { type: 'boolean' },
    },
  }));
} catch (error) {
  console.error(`${error.message}\n\n${USAGE}`);
  process.exit(2);
}
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const toPort = (text, name) => {
  const port = Number(text);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`--${name} must be a port number, got ${text}`);
    process.exit(2);
  }
  return port;
};

const harness = new Harness({
  port: values.port === undefined ? 4010 : toPort(values.port, 'port'),
  otherPort: values['other-port'] === undefined ? undefined : toPort(values['other-port'], 'other-port'),
  prefix: values.prefix ?? DEFAULT_PREFIX,
  host: values.host ?? '127.0.0.1',
  publicHost: values['public-host'],
  otherPublicHost: values['other-public-host'],
  specPath: values.spec,
  scenariosPath: values.scenarios,
});

await harness.start();
console.log(`Rask API v3 acceptance harness, contract ${harness.contract.version}, ${harness.contract.operations.length} operations
  base_url        ${harness.baseUrl}
  control         ${harness.controlUrl}  (GET /__control/health lists every endpoint)
  other host      ${harness.otherBaseUrl}
  test API key    ${harness.scenarios.data.constants.api_key}
  scenarios       GET /__control/scenarios (${harness.scenarios.scenarios.length})`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    harness.stop().finally(() => process.exit(0));
  });
}

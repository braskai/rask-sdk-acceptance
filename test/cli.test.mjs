import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rask-sdk-acceptance.mjs');

const start = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.stdout.on('data', (chunk) => {
    output += chunk;
    const match = /base_url\s+(\S+)\n\s+control\s+(\S+)[^\n]*\n\s+other host\s+(\S+)/.exec(output);
    if (match) resolve({ child, baseUrl: match[1], controlUrl: match[2], otherUrl: match[3] });
  });
  child.on('exit', (code) => reject(new Error(`exited ${code}: ${output}`)));
});

test('the CLI serves the chosen prefix and stops on SIGTERM', async () => {
  const { child, baseUrl, controlUrl, otherUrl } = await start(['--port', '0', '--prefix', '/gw/rask/v3']);
  try {
    assert.match(baseUrl, /\/gw\/rask\/v3$/);
    const health = await (await fetch(`${controlUrl}/health`)).json();
    assert.equal(health.prefix, '/gw/rask/v3');
    assert.equal(health.other_base_url, otherUrl);
    assert.equal((await fetch(`${baseUrl}/me`, { headers: { Authorization: 'Bearer k' } })).status, 200);
    assert.equal((await fetch(`${otherUrl}/__other/health`)).status, 200);
  } finally {
    child.removeAllListeners('exit');
    const stopped = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    assert.equal(await stopped, 0);
  }
});

test('the CLI refuses bad flags', async () => {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, '--nope'], { stdio: 'ignore' });
    child.on('exit', resolve);
  });
  assert.equal(code, 2);
});

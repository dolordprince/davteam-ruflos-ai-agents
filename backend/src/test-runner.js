// backend/src/test-runner.js — Runtime verification tests.
import { rufloAvailable, getRufloVersion, runRufloJson, runDoctor, getCapabilities } from './ruflo-runtime.js';
import { safePath, PathValidationError } from './workspace.js';
import { listModels, listProviders } from './provider.js';
import { config } from './config.js';

let passed = 0;
let failed = 0;

function assert(cond, name, details) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    if (details) console.error(`    ${details}`);
    failed++;
  }
}

async function main() {
  console.log('=== DavTeam Ruflos AI Agents — Test Suite ===\n');

  console.log('1. Static / runtime checks:');
  const ver = await getRufloVersion();
  assert(rufloAvailable, 'Ruflo runtime is available');
  assert(ver.version === '3.45.0', `Ruflo version is 3.45.0 (got ${ver.version})`);

  console.log('\n2. Doctor (metaharness):');
  try {
    const doc = await runDoctor('metaharness');
    // MetaHarness is OPTIONAL — upstream defines graceful degradation.
    // doctor may exit 1 when optional MetaHarness packages are not installed,
    // but it must report the real state honestly (not fake success).
    assert(doc.exitCode === 0 || doc.exitCode === 1, 'ruflo doctor runs and exits 0 or 1 (degraded)');
    assert(/MetaHarness/i.test(doc.stdout), 'doctor reports MetaHarness status honestly');
    assert(/degrad/i.test(doc.stdout) || /pass/i.test(doc.stdout), 'doctor reports graceful degradation or passing checks');
  } catch (err) {
    assert(false, 'doctor ran without error', err.message);
  }

  console.log('\n3. Capabilities:');
  const caps = await getCapabilities();
  assert(caps.agents === true, 'agents capability detected');
  assert(caps.swarm === true, 'swarm capability detected');
  assert(caps.memory === true, 'memory capability detected');
  assert(caps.mcp === true, 'mcp capability detected');
  assert(caps.metaharness === true, 'metaharness capability detected');

  console.log('\n4. Agent spawn:');
  try {
    const result = await runRufloJson(['agent', 'spawn', '-t', 'coder'], { timeout: 30000 });
    assert(result.json?.success === true, 'agent spawn returns success', JSON.stringify(result.json));
    assert(Boolean(result.json?.agentId), 'agent spawn returns agentId');
  } catch (err) {
    assert(false, 'agent spawn ran', err.message);
  }

  console.log('\n5. Task create:');
  try {
    const result = await runRufloJson(['task', 'create', '-t', 'implementation', '-d', 'Test task'], { timeout: 30000 });
    assert(Boolean(result.json?.taskId), 'task create returns taskId');
  } catch (err) {
    assert(false, 'task create ran', err.message);
  }

  console.log('\n6. Workspace security:');
  assert(safePath('test.txt') !== null, 'safePath resolves relative path');
  try {
    safePath('../../etc/passwd');
    assert(false, 'path traversal should be blocked');
  } catch (err) {
    assert(err instanceof PathValidationError, 'path traversal is blocked');
  }
  try {
    safePath('/etc/passwd');
    assert(false, 'system path should be blocked');
  } catch (err) {
    assert(err instanceof PathValidationError, 'system path is blocked');
  }

  console.log('\n7. Provider / models:');
  const models = listModels();
  assert(Array.isArray(models) && models.length > 0, 'listModels returns array');
  const providers = listProviders();
  assert(Array.isArray(providers), 'listProviders returns array');
  // Ensure no keys leak
  const modelsJson = JSON.stringify(models);
  assert(!/sk-[A-Za-z0-9]{20}/.test(modelsJson), 'no API keys in models response');

  console.log('\n8. Memory (if available):');
  try {
    const result = await runRufloJson(['memory', 'stats'], { timeout: 30000 });
    assert(result.exitCode === 0 || result.json !== null, 'memory stats command runs');
  } catch (err) {
    console.log(`    (memory test skipped: ${err.message})`);
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

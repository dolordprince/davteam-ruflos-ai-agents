// E2E test: Real autonomous build with Playwright browser verification.
// This test exercises the FULL pipeline:
//   CREATE → BUILD → TEST → BROWSER (Playwright) → RUNTIME → FINAL → MEMORY
// Playwright must actually launch Chromium, open the app, inspect the page,
// interact with UI elements, detect console errors, verify responsive.
import { autonomousBuilder } from './autonomous-builder.js';
import { isPlaywrightAvailable } from './browser-inspector.js';
import { taskStore } from './task-store.js';
import { fileExists, readFile, deleteFile } from './file-ops.js';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_DIR = '/workspace/davteam-ruflos-ai-agents/workspace/e2e-playwright-test';
const TEST_PROMPT = 'Create a simple HTML counter app with increment and decrement buttons and a display. Use Vite. Include a basic test.';

let passed = 0;
let failed = 0;
const events = [];

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
  console.log('=== E2E: Real Autonomous Build with Playwright ===\n');

  // Pre-check: Playwright must be available
  console.log('0. Pre-checks:');
  const pwAvailable = await isPlaywrightAvailable();
  assert(pwAvailable, 'Playwright is available (isPlaywrightAvailable() = true)');
  if (!pwAvailable) {
    console.error('FATAL: Playwright not available — cannot run E2E test');
    process.exit(1);
  }

  // Clean up any previous test workspace
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}

  // Run the autonomous build
  console.log('\n1. Starting autonomous build...');
  const result = await autonomousBuilder.build({
    prompt: TEST_PROMPT,
    sessionId: 'e2e-playwright-test',
    onEvent: (event) => {
      events.push(event);
      // Log key events
      const keyTypes = [
        'task.created', 'planning.completed', 'build.started', 'build.completed',
        'test.started', 'test.passed', 'test.failed',
        'browser.test.started', 'browser.test.pass', 'browser.test.fail', 'browser.test.blocked',
        'browser.test.recheck', 'browser.screenshot',
        'runtime.inspection.started', 'runtime.inspection.pass', 'runtime.inspection.fail',
        'final.inspection.started', 'final.inspection.completed',
        'task.completed', 'task.failed',
        'error.detected', 'analysis.started', 'analysis.completed',
        'fix.started', 'fix.completed', 'fix.failed',
        'regression.started', 'regression.passed', 'regression.failed',
        'agent.interrupted',
      ];
      if (keyTypes.includes(event.type)) {
        console.log(`  [event] ${event.type}${event.status ? ` (${event.status})` : ''}${event.errors != null ? ` errors=${event.errors}` : ''}`);
      }
    },
  });

  // Collect evidence from events
  const eventTypes = events.map(e => e.type);
  const task = taskStore.getTask(result.taskId);

  console.log('\n2. Verifying pipeline stages:');

  // Task was created
  assert(result && result.taskId, 'Task was created with taskId');
  assert(task, 'Task exists in durable task store');

  // Planning happened
  assert(eventTypes.includes('planning.completed') || eventTypes.includes('planning.started'), 'Planning phase executed');

  // Build happened
  assert(eventTypes.some(t => t.startsWith('build.')), 'Build phase executed');

  // Browser inspection with Playwright
  console.log('\n3. Playwright browser verification:');
  assert(eventTypes.includes('browser.test.started'), 'Browser inspection started (Playwright launch)');

  const browserPassEvent = events.find(e => e.type === 'browser.test.pass');
  const browserFailEvent = events.find(e => e.type === 'browser.test.fail');
  const browserBlockedEvent = events.find(e => e.type === 'browser.test.blocked');

  assert(!browserBlockedEvent, 'Browser inspection was NOT BLOCKED (Playwright actually ran)');

  if (browserPassEvent) {
    assert(true, 'Browser inspection PASSED');
    assert(browserPassEvent.checks > 0 || browserPassEvent.errors === 0, `Browser checks passed (errors=${browserPassEvent.errors})`);
  } else if (browserFailEvent) {
    assert(false, `Browser inspection FAILED: ${browserFailEvent.errors} errors`);
  }

  // Screenshot was taken
  const screenshotEvent = events.find(e => e.type === 'browser.screenshot');
  assert(!!screenshotEvent, 'Screenshot was captured during browser inspection');

  // Runtime inspection
  console.log('\n4. Runtime inspection:');
  const runtimePassEvent = events.find(e => e.type === 'runtime.inspection.pass');
  const runtimeFailEvent = events.find(e => e.type === 'runtime.inspection.fail');
  assert(eventTypes.some(t => t.startsWith('runtime.inspection.')), 'Runtime inspection executed');
  if (runtimePassEvent) {
    assert(true, 'Runtime inspection PASSED');
  } else if (runtimeFailEvent) {
    assert(false, `Runtime inspection FAILED`);
  }

  // Final inspection
  console.log('\n5. Final inspection:');
  assert(eventTypes.includes('final.inspection.started'), 'Final inspection started');
  assert(eventTypes.includes('final.inspection.completed'), 'Final inspection completed');

  // Task outcome
  console.log('\n6. Task outcome:');
  const completedEvent = events.find(e => e.type === 'task.completed');
  const taskFailedEvent = events.find(e => e.type === 'task.failed');

  if (completedEvent) {
    assert(true, 'Task COMPLETED');
    assert(completedEvent.verified === true, 'Task verified = true');
    assert(completedEvent.finalInspection === 'PASS' || completedEvent.finalInspection === 'COMPLETED',
      `Final inspection status: ${completedEvent.finalInspection}`);
  } else if (taskFailedEvent) {
    assert(false, `Task FAILED: ${taskFailedEvent.error}`);
  }

  // Structured evidence
  console.log('\n7. Structured evidence:');
  assert(task?.browserResult, 'Browser result stored in task state');
  if (task?.browserResult) {
    assert(Array.isArray(task.browserResult.checks), `Browser checks array present (${task.browserResult.checks?.length} checks)`);
    assert(Array.isArray(task.browserResult.evidence), 'Browser evidence array present');
    assert(task.browserResult.status === 'PASS', `Browser result status = ${task.browserResult.status}`);
  }
  assert(task?.runtimeResult, 'Runtime result stored in task state');
  assert(task?.finalInspection, 'Final inspection result stored in task state');

  // Memory was written
  console.log('\n8. Memory/learning:');
  assert(task?.knowledgeStored || eventTypes.some(t => t.includes('memory') || t.includes('knowledge') || t.includes('learning')),
    'Memory/learning phase executed');

  // Cleanup
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}

  console.log(`\n=== E2E Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('E2E test crashed:', err);
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(1);
});

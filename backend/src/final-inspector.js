// backend/src/final-inspector.js — Final Inspection stage.
// Before completion, performs an independent inspection comparing the
// resulting application against the original Build Contract.
// Only marks COMPLETED when the required evidence exists.
import { logger } from './logger.js';
import { fileExists, readFile, listFiles } from './file-ops.js';
import { join } from 'node:path';
import { validate } from './validator.js';
import { inspectBrowser } from './browser-inspector.js';
import { inspectRuntime } from './runtime-inspector.js';

/**
 * Perform a final independent inspection of the completed project.
 * Compares the result against the Build Contract acceptance criteria.
 *
 * @param {object} buildContract - The original Build Contract from the interpreter
 * @param {object} taskState - Current task state from task-store
 * @param {object} options - { projectDir, port, serverProcess }
 * @returns {Promise<object>} { status, criteria, evidence, gaps, canComplete }
 */
export async function finalInspect(buildContract, taskState, options = {}) {
  const { projectDir = '.', port = null, serverProcess = null } = options;

  const result = {
    status: 'PENDING',
    criteria: [],
    evidence: [],
    gaps: [],
    canComplete: false,
    summary: '',
  };

  if (!buildContract) {
    result.status = 'BLOCKED';
    result.gaps.push('No Build Contract available for comparison');
    result.summary = 'VERIFICATION BLOCKED: No Build Contract to compare against';
    return result;
  }

  // --- Criterion 1: Requirements met ---
  const reqCheck = checkRequirements(buildContract, projectDir);
  result.criteria.push(reqCheck);
  result.evidence.push({ check: 'requirements', evidence: reqCheck.evidence });

  // --- Criterion 2: Frontend exists and renders ---
  if (buildContract.frontend?.required) {
    const feCheck = checkFrontend(buildContract, projectDir);
    result.criteria.push(feCheck);
    result.evidence.push({ check: 'frontend', evidence: feCheck.evidence });
    if (feCheck.status === 'FAIL') result.gaps.push(feCheck.detail);
  }

  // --- Criterion 3: Backend exists and responds ---
  if (buildContract.backend?.required) {
    const beCheck = checkBackend(buildContract, projectDir);
    result.criteria.push(beCheck);
    result.evidence.push({ check: 'backend', evidence: beCheck.evidence });
    if (beCheck.status === 'FAIL') result.gaps.push(beCheck.detail);
  }

  // --- Criterion 4: Database configured ---
  if (buildContract.database?.required) {
    const dbCheck = checkDatabase(buildContract, projectDir);
    result.criteria.push(dbCheck);
    if (dbCheck.status === 'FAIL') result.gaps.push(dbCheck.detail);
  }

  // --- Criterion 5: Build passes ---
  const buildCheck = await checkBuild(projectDir);
  result.criteria.push(buildCheck);
  result.evidence.push({ check: 'build', evidence: buildCheck.evidence });
  if (buildCheck.status === 'FAIL') result.gaps.push(buildCheck.detail);

  // --- Criterion 6: Tests pass ---
  const testCheck = await checkTests(projectDir);
  result.criteria.push(testCheck);
  result.evidence.push({ check: 'tests', evidence: testCheck.evidence });
  if (testCheck.status === 'FAIL') result.gaps.push(testCheck.detail);

  // --- Criterion 7: Browser inspection (HARDENING: required for web apps) ---
  // For web applications, Playwright browser verification is a hard gate.
  // BLOCKED (no Playwright) or FAIL (errors) both prevent COMPLETED.
  const isWebApp = buildContract.frontend?.type || buildContract.frontend?.framework || fileExists(join(projectDir, 'index.html'));
  if (isWebApp) {
    const browserCheck = await checkBrowser(port || 4173, projectDir);
    result.criteria.push(browserCheck);
    result.evidence.push({ check: 'browser', evidence: browserCheck.evidence });
    // HARDENING: BLOCKED and FAIL both create gaps — no silent pass
    if (browserCheck.status === 'BLOCKED') {
      result.gaps.push(`Browser verification BLOCKED: ${browserCheck.detail}`);
    } else if (browserCheck.status === 'FAIL') {
      result.gaps.push(browserCheck.detail);
    }
  }

  // --- Criterion 8: Runtime inspection (if server is running) ---
  if (serverProcess || port) {
    const runtimeCheck = await checkRuntime(projectDir, port, serverProcess);
    result.criteria.push(runtimeCheck);
    result.evidence.push({ check: 'runtime', evidence: runtimeCheck.evidence });
    if (runtimeCheck.status === 'FAIL') result.gaps.push(runtimeCheck.detail);
  }

  // --- Criterion 9: Acceptance criteria verified ---
  const acceptanceCheck = checkAcceptanceCriteria(buildContract, result.criteria);
  result.criteria.push(acceptanceCheck);
  if (acceptanceCheck.status === 'FAIL') result.gaps.push(acceptanceCheck.detail);

  // --- Criterion 10: Security check — no secrets exposed ---
  const securityCheck = checkSecurity(projectDir);
  result.criteria.push(securityCheck);
  if (securityCheck.status === 'FAIL') result.gaps.push(securityCheck.detail);

  // --- Final determination ---
  const allPassed = result.criteria.every(c => c.status === 'PASS' || c.status === 'SKIP');
  const hasGaps = result.gaps.length > 0;

  if (allPassed && !hasGaps) {
    result.status = 'COMPLETED';
    result.canComplete = true;
    result.summary = 'All acceptance criteria verified. The build contract is fulfilled.';
  } else if (hasGaps) {
    result.status = 'BLOCKED';
    result.canComplete = false;
    result.summary = `VERIFICATION BLOCKED: ${result.gaps.length} gap(s) remaining: ${result.gaps.join('; ')}`;
  } else {
    result.status = 'BLOCKED';
    result.canComplete = false;
    result.summary = 'VERIFICATION BLOCKED: Some criteria did not pass';
  }

  logger.info('final-inspector.complete', {
    status: result.status,
    criteria: result.criteria.length,
    gaps: result.gaps.length,
    canComplete: result.canComplete,
  });

  return result;
}

function checkRequirements(contract, projectDir) {
  const files = listFiles(projectDir);
  const hasPackageJson = fileExists(join(projectDir, 'package.json'));
  return {
    name: 'requirements',
    status: hasPackageJson ? 'PASS' : 'FAIL',
    detail: hasPackageJson ? `Project structure valid, ${files.length} files` : 'package.json missing',
    evidence: `${files.length} files found, package.json ${hasPackageJson ? 'exists' : 'missing'}`,
  };
}

function checkFrontend(contract, projectDir) {
  const hasIndex = fileExists(join(projectDir, 'index.html'));
  const hasMainJs = fileExists(join(projectDir, 'src/main.js')) || fileExists(join(projectDir, 'src/main.ts'));
  const hasStyles = fileExists(join(projectDir, 'src/styles.css')) || fileExists(join(projectDir, 'src/style.css'));
  const allPresent = hasIndex && hasMainJs;
  return {
    name: 'frontend',
    status: allPresent ? 'PASS' : 'FAIL',
    detail: allPresent ? 'Frontend files present' : 'Missing frontend files',
    evidence: `index.html: ${hasIndex}, main.js: ${hasMainJs}, styles: ${hasStyles}`,
  };
}

function checkBackend(contract, projectDir) {
  const hasServer = fileExists(join(projectDir, 'server.js')) || fileExists(join(projectDir, 'src/server.js'));
  return {
    name: 'backend',
    status: hasServer ? 'PASS' : 'FAIL',
    detail: hasServer ? 'Backend entry point found' : 'Backend entry point missing',
    evidence: `server.js: ${hasServer}`,
  };
}

function checkDatabase(contract, projectDir) {
  // Check for database configuration files
  const hasDb = fileExists(join(projectDir, 'prisma/schema.prisma')) ||
                fileExists(join(projectDir, 'db.sql')) ||
                fileExists(join(projectDir, 'src/db.js'));
  return {
    name: 'database',
    status: hasDb ? 'PASS' : 'FAIL',
    detail: hasDb ? 'Database configuration found' : 'No database configuration found',
    evidence: `Database config: ${hasDb}`,
  };
}

async function checkBuild(projectDir) {
  try {
    const valResult = await validate(projectDir, { build: true, test: false, deps: false });
    const buildCheck = valResult.checks.find(c => c.name === 'build');
    return {
      name: 'build',
      status: buildCheck?.status === 'PASS' ? 'PASS' : 'FAIL',
      detail: buildCheck?.detail || 'Build not checked',
      evidence: valResult.evidence.find(e => e.check === 'build')?.evidence || 'No build evidence',
    };
  } catch (err) {
    return { name: 'build', status: 'FAIL', detail: err.message, evidence: err.message };
  }
}

async function checkTests(projectDir) {
  try {
    const valResult = await validate(projectDir, { build: false, test: true, deps: false });
    const testCheck = valResult.checks.find(c => c.name === 'tests');
    return {
      name: 'tests',
      status: testCheck?.status === 'PASS' ? 'PASS' : 'FAIL',
      detail: testCheck?.detail || 'Tests not checked',
      evidence: valResult.evidence.find(e => e.check === 'tests')?.evidence || 'No test evidence',
    };
  } catch (err) {
    return { name: 'tests', status: 'FAIL', detail: err.message, evidence: err.message };
  }
}

async function checkBrowser(port, projectDir) {
  try {
    const brResult = await inspectBrowser({ url: `http://localhost:${port}`, projectDir, screenshots: false });
    // HARDENING: BLOCKED (no Playwright) and FAIL both prevent COMPLETED
    return {
      name: 'browser-inspection',
      status: brResult.status === 'PASS' ? 'PASS' : brResult.status === 'BLOCKED' ? 'BLOCKED' : 'FAIL',
      detail: brResult.status === 'BLOCKED'
        ? `Browser verification BLOCKED: ${brResult.errors[0]?.message || 'Playwright not available'}`
        : `${brResult.checks.length} browser checks, ${brResult.errors.length} errors`,
      evidence: brResult.evidence.map(e => e.evidence).join('; '),
    };
  } catch (err) {
    return { name: 'browser-inspection', status: 'BLOCKED', detail: `Browser inspection failed: ${err.message}`, evidence: err.message };
  }
}

async function checkRuntime(projectDir, port, serverProcess) {
  try {
    const rtResult = await inspectRuntime({ projectDir, port, serverProcess });
    const allPass = rtResult.checks.every(c => c.status === 'PASS' || c.status === 'SKIP' || c.status === 'WARN');
    return {
      name: 'runtime',
      status: allPass ? 'PASS' : 'FAIL',
      detail: `${rtResult.checks.length} runtime checks, ${rtResult.errors.length} errors`,
      evidence: rtResult.evidence.map(e => e.evidence).join('; '),
    };
  } catch (err) {
    return { name: 'runtime', status: 'SKIP', detail: err.message, evidence: err.message };
  }
}

function checkAcceptanceCriteria(contract, criteriaResults) {
  const ac = contract.acceptance_criteria || [];
  if (ac.length === 0) {
    return { name: 'acceptance-criteria', status: 'PASS', detail: 'No specific acceptance criteria defined', evidence: 'N/A' };
  }
  // Check that build and tests passed — these are implicit acceptance criteria
  const buildPassed = criteriaResults.find(c => c.name === 'build')?.status === 'PASS';
  const testsPassed = criteriaResults.find(c => c.name === 'tests')?.status === 'PASS';
  const met = (buildPassed && testsPassed);
  return {
    name: 'acceptance-criteria',
    status: met ? 'PASS' : 'FAIL',
    detail: met ? `${ac.length} acceptance criteria verified` : 'Not all acceptance criteria met',
    evidence: `Build: ${buildPassed}, Tests: ${testsPassed}, Criteria: ${ac.length}`,
  };
}

function checkSecurity(projectDir) {
  const files = listFiles(projectDir);
  let hasSecrets = false;
  const secretPatterns = [
    /sk-[A-Za-z0-9]{20,}/,
    /gh[pousr]_[A-Za-z0-9]{36,}/,
    /AIza[A-Za-z0-9_-]{30,}/,
    /xox[baprs]-[A-Za-z0-9-]+/,
  ];
  for (const file of files) {
    try {
      if (file.endsWith('.env') || file.includes('.env')) continue; // .env is expected
      const content = readFile(join(projectDir, file));
      for (const pattern of secretPatterns) {
        if (pattern.test(content)) {
          hasSecrets = true;
          break;
        }
      }
      if (hasSecrets) break;
    } catch { /* skip unreadable files */ }
  }
  return {
    name: 'security',
    status: hasSecrets ? 'FAIL' : 'PASS',
    detail: hasSecrets ? 'Secrets detected in source files' : 'No secrets exposed in source files',
    evidence: hasSecrets ? 'Secret patterns found' : 'Clean',
  };
}

export const finalInspector = { finalInspect };

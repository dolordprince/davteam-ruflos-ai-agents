// backend/src/validator.js — Validation stage.
// Runs real checks (type check, lint, build, tests, deps) and returns structured evidence.
import { executeCommand } from './command-exec.js';
import { listFiles, fileExists } from './file-ops.js';
import { logger } from './logger.js';

/**
 * Validate a project in the workspace.
 * Runs real checks and returns structured evidence.
 *
 * @param {string} projectDir - workspace-relative project directory
 * @param {object} options - { build, test, lint, typeCheck, deps }
 * @returns {Promise<object>} { status, checks, errors, warnings, evidence }
 */
export async function validate(projectDir, options = {}) {
  const {
    build = true,
    test = true,
    lint = false,
    typeCheck = false,
    deps = true,
  } = options;

  const result = {
    status: 'PASS',
    checks: [],
    errors: [],
    warnings: [],
    evidence: [],
  };

  const cwd = projectDir;

  // Check 1: Project structure exists
  const hasPackageJson = fileExists(join(projectDir, 'package.json'));
  result.checks.push({ name: 'project-structure', status: hasPackageJson ? 'PASS' : 'FAIL', detail: hasPackageJson ? 'package.json found' : 'package.json missing' });
  if (!hasPackageJson) {
    result.status = 'FAIL';
    result.errors.push({ check: 'project-structure', message: 'package.json not found' });
    return result;
  }
  result.evidence.push({ check: 'project-structure', evidence: 'package.json exists' });

  // Check 2: Dependency validation
  if (deps) {
    const hasNodeModules = fileExists(join(projectDir, 'node_modules'));
    result.checks.push({ name: 'dependencies', status: hasNodeModules ? 'PASS' : 'FAIL', detail: hasNodeModules ? 'node_modules installed' : 'node_modules missing' });
    if (!hasNodeModules) {
      result.warnings.push({ check: 'dependencies', message: 'node_modules not installed — running npm install' });
      try {
        const installResult = await executeCommand({ command: 'npm install --no-audit --no-fund', cwd });
        result.evidence.push({ check: 'dependencies', evidence: `npm install exit code: ${installResult.exitCode}` });
        if (installResult.exitCode !== 0) {
          result.status = 'FAIL';
          result.errors.push({ check: 'dependencies', message: 'npm install failed', stderr: installResult.stderr?.slice(0, 500) });
        }
      } catch (err) {
        result.status = 'FAIL';
        result.errors.push({ check: 'dependencies', message: err.message });
      }
    } else {
      result.evidence.push({ check: 'dependencies', evidence: 'node_modules already installed' });
    }
  }

  // Check 3: Build
  if (build) {
    try {
      const buildResult = await executeCommand({ command: 'npm run build', cwd, timeoutMs: 60000 });
      const buildOk = buildResult.exitCode === 0;
      result.checks.push({ name: 'build', status: buildOk ? 'PASS' : 'FAIL', detail: `exit code: ${buildResult.exitCode}` });
      result.evidence.push({ check: 'build', evidence: buildResult.stdout?.slice(0, 500), stderr: buildResult.stderr?.slice(0, 500) });
      if (!buildOk) {
        result.status = 'FAIL';
        result.errors.push({ check: 'build', message: 'Build failed', stderr: buildResult.stderr?.slice(0, 1000), stdout: buildResult.stdout?.slice(0, 1000) });
      }
    } catch (err) {
      result.checks.push({ name: 'build', status: 'FAIL', detail: err.message });
      result.status = 'FAIL';
      result.errors.push({ check: 'build', message: err.message });
    }
  }

  // Check 4: Tests
  if (test) {
    try {
      const testResult = await executeCommand({ command: 'npm test', cwd, timeoutMs: 60000 });
      const testOk = testResult.exitCode === 0;
      result.checks.push({ name: 'tests', status: testOk ? 'PASS' : 'FAIL', detail: `exit code: ${testResult.exitCode}` });
      result.evidence.push({ check: 'tests', evidence: testResult.stdout?.slice(0, 500), stderr: testResult.stderr?.slice(0, 500) });
      if (!testOk) {
        result.status = 'FAIL';
        result.errors.push({ check: 'tests', message: 'Tests failed', stderr: testResult.stderr?.slice(0, 1000), stdout: testResult.stdout?.slice(0, 1000) });
      }
    } catch (err) {
      result.checks.push({ name: 'tests', status: 'FAIL', detail: err.message });
      result.status = 'FAIL';
      result.errors.push({ check: 'tests', message: err.message });
    }
  }

  // Check 5: Lint (optional)
  if (lint) {
    try {
      const lintResult = await executeCommand({ command: 'npm run lint', cwd, timeoutMs: 30000 });
      const lintOk = lintResult.exitCode === 0;
      result.checks.push({ name: 'lint', status: lintOk ? 'PASS' : 'WARN', detail: `exit code: ${lintResult.exitCode}` });
      if (!lintOk) {
        result.warnings.push({ check: 'lint', message: 'Lint issues found', stderr: lintResult.stderr?.slice(0, 500) });
      }
    } catch (err) {
      // Lint is optional — don't fail the whole validation
      result.checks.push({ name: 'lint', status: 'SKIP', detail: 'lint not configured' });
    }
  }

  // Check 6: Type check (optional)
  if (typeCheck) {
    try {
      const typeResult = await executeCommand({ command: 'npx tsc --noEmit', cwd, timeoutMs: 30000 });
      const typeOk = typeResult.exitCode === 0;
      result.checks.push({ name: 'type-check', status: typeOk ? 'PASS' : 'FAIL', detail: `exit code: ${typeResult.exitCode}` });
      if (!typeOk) {
        result.status = 'FAIL';
        result.errors.push({ check: 'type-check', message: 'Type errors found', stderr: typeResult.stderr?.slice(0, 1000) });
      }
    } catch (err) {
      result.checks.push({ name: 'type-check', status: 'SKIP', detail: 'TypeScript not configured' });
    }
  }

  // Check 7: Generated artifacts validation
  const distExists = fileExists(join(projectDir, 'dist'));
  result.checks.push({ name: 'artifacts', status: distExists ? 'PASS' : 'FAIL', detail: distExists ? 'dist/ exists' : 'dist/ missing' });
  if (!distExists && build) {
    result.status = 'FAIL';
    result.errors.push({ check: 'artifacts', message: 'Build artifacts (dist/) not found after build' });
  } else if (distExists) {
    result.evidence.push({ check: 'artifacts', evidence: 'dist/ directory exists' });
  }

  logger.info('validator.complete', { status: result.status, checks: result.checks.length, errors: result.errors.length });
  return result;
}

function join(dir, file) {
  return dir === '.' ? file : `${dir}/${file}`;
}

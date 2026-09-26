// backend/src/error-analyzer.js — Error Analysis stage.
// When an error occurs, does NOT immediately let an agent start editing files.
// First collects evidence, determines root cause, and selects a repair strategy.
import { logger } from './logger.js';
import { runRufloJson } from './ruflo-runtime.js';
import { readFile, listFiles, fileExists } from './file-ops.js';

/**
 * Analyze an error and determine the root cause and repair strategy.
 *
 * @param {object} errorContext - { error, stackTrace, failingCommand, failingTest, browserEvidence, runtimeLogs, taskDefinition, buildContract, previousRepairAttempts }
 * @returns {Promise<object>} { rootCause, relevantFiles, evidence, repairStrategy, expectedBehavior, failedBehavior }
 */
export async function analyzeError(errorContext = {}) {
  const {
    error = '',
    stackTrace = '',
    failingCommand = '',
    failingTest = '',
    browserEvidence = null,
    runtimeLogs = '',
    taskDefinition = null,
    buildContract = null,
    previousRepairAttempts = [],
  } = errorContext;

  const analysis = {
    whatFailed: '',
    whyItFailed: '',
    rootCause: '',
    relevantFiles: [],
    evidence: [],
    repairStrategy: '',
    expectedBehavior: '',
    failedBehavior: '',
    previousAttempts: previousRepairAttempts.length,
    shouldChangeStrategy: false,
  };

  // Step 1: WHAT FAILED?
  analysis.whatFailed = determineWhatFailed(error, failingCommand, failingTest, browserEvidence);
  analysis.evidence.push({ source: 'error-message', value: error.slice(0, 500) });
  if (stackTrace) analysis.evidence.push({ source: 'stack-trace', value: stackTrace.slice(0, 500) });
  if (failingCommand) analysis.evidence.push({ source: 'failing-command', value: failingCommand });
  if (failingTest) analysis.evidence.push({ source: 'failing-test', value: failingTest });
  if (browserEvidence) analysis.evidence.push({ source: 'browser-evidence', value: browserEvidence });
  if (runtimeLogs) analysis.evidence.push({ source: 'runtime-logs', value: runtimeLogs.slice(0, 500) });

  // Step 2: WHY DID IT FAIL? + WHERE IS THE ROOT CAUSE?
  analysis.whyItFailed = determineWhyItFailed(error, failingCommand, analysis.whatFailed);
  analysis.rootCause = determineRootCause(error, stackTrace, failingCommand, analysis.whatFailed);

  // Step 3: WHICH FILES ARE ACTUALLY RELEVANT?
  analysis.relevantFiles = findRelevantFiles(error, stackTrace, failingCommand, analysis.rootCause);
  analysis.evidence.push({ source: 'relevant-files', value: analysis.relevantFiles.join(', ') });

  // Step 4: Search/retrieve context from Ruflo memory
  const memoryResults = await searchMemoryForError(analysis.rootCause, analysis.whatFailed);
  if (memoryResults.length > 0) {
    analysis.evidence.push({ source: 'memory-search', value: `${memoryResults.length} relevant patterns found` });
    analysis.evidence.push({ source: 'memory-patterns', value: memoryResults.slice(0, 3) });
  }

  // Step 5: Check previous repair attempts — never repeat the same strategy blindly
  if (previousRepairAttempts.length >= 2) {
    const sameStrategy = previousRepairAttempts.every(a => a.repairStrategy === previousRepairAttempts[0].repairStrategy);
    if (sameStrategy) {
      analysis.shouldChangeStrategy = true;
      analysis.repairStrategy = selectDifferentStrategy(analysis.whatFailed, analysis.rootCause, previousRepairAttempts);
      analysis.evidence.push({ source: 'strategy-change', value: `Same strategy failed ${previousRepairAttempts.length} times — switching approach` });
    } else {
      analysis.repairStrategy = selectRepairStrategy(analysis.whatFailed, analysis.rootCause, analysis.relevantFiles);
    }
  } else {
    analysis.repairStrategy = selectRepairStrategy(analysis.whatFailed, analysis.rootCause, analysis.relevantFiles);
  }

  // Step 6: Determine expected vs failed behavior
  analysis.expectedBehavior = determineExpectedBehavior(taskDefinition, buildContract, analysis.whatFailed);
  analysis.failedBehavior = error.slice(0, 200);

  logger.info('error-analyzer.complete', {
    whatFailed: analysis.whatFailed,
    rootCause: analysis.rootCause,
    relevantFiles: analysis.relevantFiles.length,
    repairStrategy: analysis.repairStrategy,
    shouldChangeStrategy: analysis.shouldChangeStrategy,
  });

  return analysis;
}

function determineWhatFailed(error, failingCommand, failingTest, browserEvidence) {
  const err = (error || '').toLowerCase();
  if (failingTest) return 'TEST_FAILURE';
  if (failingCommand && /build/.test(failingCommand)) return 'BUILD_FAILURE';
  if (failingCommand && /install/.test(failingCommand)) return 'INSTALL_FAILURE';
  if (browserEvidence) return 'BROWSER_FAILURE';
  if (/syntax|unexpected token|parse error/.test(err)) return 'SYNTAX_ERROR';
  if (/cannot find module|failed to resolve/.test(err)) return 'MISSING_DEPENDENCY';
  if (/type error|is not a function|is not defined/.test(err)) return 'TYPE_ERROR';
  if (/network|connection|timeout|econnrefused/.test(err)) return 'NETWORK_FAILURE';
  if (/import|export/.test(err)) return 'IMPORT_ERROR';
  return 'UNKNOWN_FAILURE';
}

function determineWhyItFailed(error, failingCommand, whatFailed) {
  const err = (error || '').toLowerCase();
  switch (whatFailed) {
    case 'BUILD_FAILURE':
      if (/cannot find module/.test(err)) return 'A required module is missing from package.json';
      if (/syntax|unexpected token/.test(err)) return 'There is a syntax error in the source code';
      if (/failed to resolve/.test(err)) return 'A dependency could not be resolved';
      if (/import/.test(err)) return 'An import statement is incorrect';
      return 'The build process encountered an error';
    case 'TEST_FAILURE':
      if (/assert|expect/.test(err)) return 'A test assertion failed';
      if (/timeout/.test(err)) return 'A test timed out';
      return 'A test case failed';
    case 'MISSING_DEPENDENCY':
      return 'A required package is not installed or not in package.json';
    case 'SYNTAX_ERROR':
      return 'There is a syntax error in the source code';
    case 'TYPE_ERROR':
      return 'A type mismatch occurred during execution';
    case 'BROWSER_FAILURE':
      return 'The application did not render correctly in the browser';
    case 'IMPORT_ERROR':
      return 'An import/export statement is incorrect';
    default:
      return 'An unexpected error occurred';
  }
}

function determineRootCause(error, stackTrace, failingCommand, whatFailed) {
  const err = error || '';

  // Try to extract file and line from stack trace or error
  const fileMatch = err.match(/(?:at\s+)?(\/[^\s:]+|src\/[^\s:]+):(\d+):(\d+)/);
  if (fileMatch) {
    return `Error in ${fileMatch[1]} at line ${fileMatch[2]}`;
  }

  // Try to extract from stack trace
  if (stackTrace) {
    const traceMatch = stackTrace.match(/at\s+(.+?):(\d+):(\d+)/);
    if (traceMatch) {
      return `Error in ${traceMatch[1]} at line ${traceMatch[2]}`;
    }
  }

  // Try to extract missing module
  const modMatch = err.match(/cannot find module ['"]?([^'"\s]+)['"]?|failed to resolve ['"]?([^'"\s]+)['"]?/i);
  if (modMatch) {
    return `Missing module: ${modMatch[1] || modMatch[2]}`;
  }

  // Try to extract syntax error location
  const syntaxMatch = err.match(/(.+?):(\d+):(\d+)/);
  if (syntaxMatch) {
    return `Error in ${syntaxMatch[1]} at line ${syntaxMatch[2]}`;
  }

  switch (whatFailed) {
    case 'BUILD_FAILURE': return 'Build configuration or source code error';
    case 'TEST_FAILURE': return 'Test assertion or implementation error';
    case 'MISSING_DEPENDENCY': return 'Missing npm package';
    case 'SYNTAX_ERROR': return 'Syntax error in source code';
    default: return err.slice(0, 200) || 'Unknown root cause';
  }
}

function findRelevantFiles(error, stackTrace, failingCommand, rootCause) {
  const files = new Set();
  const text = `${error}\n${stackTrace}\n${failingCommand}`;

  // Extract file paths from error/stack trace
  const matches = text.match(/(?:src\/[^\s:)]+|\.\/[^\s:)]+\.(?:js|ts|jsx|tsx|css|html|json))/g);
  if (matches) {
    for (const m of matches) files.add(m);
  }

  // Extract from root cause
  const rootFileMatch = rootCause.match(/(src\/[^\s:]+|\.\/[^\s:]+)/);
  if (rootFileMatch) files.add(rootFileMatch[1]);

  return Array.from(files).slice(0, 10);
}

async function searchMemoryForError(rootCause, whatFailed) {
  const results = [];
  try {
    const searchTerms = [whatFailed.toLowerCase(), rootCause.slice(0, 50)];
    for (const term of searchTerms) {
      try {
        const result = await runRufloJson(['memory', 'search', '-q', term], { timeout: 15000 });
        if (result.json?.results) {
          results.push(...result.json.results);
        }
      } catch {}
    }
  } catch {}
  return results;
}

function selectRepairStrategy(whatFailed, rootCause, relevantFiles) {
  switch (whatFailed) {
    case 'MISSING_DEPENDENCY':
      return 'ADD_DEPENDENCY';
    case 'SYNTAX_ERROR':
      return 'FIX_SYNTAX';
    case 'IMPORT_ERROR':
      return 'FIX_IMPORT';
    case 'TYPE_ERROR':
      return 'FIX_TYPE';
    case 'BUILD_FAILURE':
      if (rootCause.includes('Missing module')) return 'ADD_DEPENDENCY';
      if (rootCause.includes('Syntax error')) return 'FIX_SYNTAX';
      return 'FIX_SOURCE';
    case 'TEST_FAILURE':
      return 'FIX_TEST';
    case 'BROWSER_FAILURE':
      return 'FIX_BROWSER';
    default:
      return 'FIX_SOURCE';
  }
}

function selectDifferentStrategy(whatFailed, rootCause, previousAttempts) {
  // If we've tried the same strategy multiple times, try a different approach
  const tried = previousAttempts.map(a => a.repairStrategy);
  if (whatFailed === 'BUILD_FAILURE') {
    if (!tried.includes('REGENERATE_FILE')) return 'REGENERATE_FILE';
    if (!tried.includes('SIMPLIFY_CODE')) return 'SIMPLIFY_CODE';
  }
  if (whatFailed === 'TEST_FAILURE') {
    if (!tried.includes('SIMPLIFY_TEST')) return 'SIMPLIFY_TEST';
    if (!tried.includes('REGENERATE_TEST')) return 'REGENERATE_TEST';
  }
  return 'ESCALATE_TO_USER';
}

function determineExpectedBehavior(taskDefinition, buildContract, whatFailed) {
  if (taskDefinition?.acceptance_criteria) {
    return taskDefinition.acceptance_criteria.join('; ');
  }
  if (buildContract?.acceptance_criteria) {
    return buildContract.acceptance_criteria.join('; ');
  }
  switch (whatFailed) {
    case 'BUILD_FAILURE': return 'Build should complete successfully with exit code 0';
    case 'TEST_FAILURE': return 'All tests should pass';
    case 'BROWSER_FAILURE': return 'Application should render correctly in browser';
    default: return 'Operation should succeed without errors';
  }
}

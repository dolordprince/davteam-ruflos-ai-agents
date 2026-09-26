// backend/src/error-analyzer.js — Error Analysis stage.
// When an error occurs, does NOT immediately let an agent start editing files.
// First collects evidence, determines root cause, and selects a repair strategy.
//
// HARDENING: Two-layer analysis:
//   Layer 1: Deterministic rule-based analyzer (always runs first)
//   Layer 2: Model-assisted analysis (when deterministic analyzer cannot confidently
//            establish root cause, invokes configured Ruflo/model intelligence)
import { logger } from './logger.js';
import { runRufloJson } from './ruflo-runtime.js';
import { readFile, listFiles, fileExists } from './file-ops.js';
import { chatCompletion, ProviderError } from './provider.js';
import { config } from './config.js';

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

  // Step 7: HARDENING — Model-assisted analysis when deterministic analyzer is not confident
  // If the deterministic root cause is vague or the failure type is UNKNOWN_FAILURE,
  // invoke the configured model intelligence for a deeper analysis.
  const isConfident = analysis.whatFailed !== 'UNKNOWN_FAILURE' &&
                      analysis.rootCause &&
                      !analysis.rootCause.startsWith('Unknown') &&
                      analysis.repairStrategy !== 'FIX_SOURCE'; // FIX_SOURCE is the generic fallback

  if (!isConfident && config.modelApiKey) {
    analysis.analysisMethod = 'model-assisted';
    analysis.evidence.push({ source: 'analysis-method', value: 'Deterministic analysis not confident — invoking model-assisted analysis' });
    try {
      const modelAnalysis = await modelAssistedAnalysis({
        error,
        stackTrace,
        failingCommand,
        failingTest,
        browserEvidence,
        runtimeLogs,
        taskDefinition,
        buildContract,
        previousRepairAttempts,
        deterministicAnalysis: analysis,
        memoryResults,
      });
      if (modelAnalysis) {
        // Merge model analysis into our result — model takes priority for root cause
        analysis.whatFailed = modelAnalysis.failure_type || analysis.whatFailed;
        analysis.rootCause = modelAnalysis.root_cause || analysis.rootCause;
        analysis.repairStrategy = modelAnalysis.repair_strategy || analysis.repairStrategy;
        if (modelAnalysis.relevant_files?.length > 0) {
          analysis.relevantFiles = modelAnalysis.relevant_files;
        }
        analysis.confidence = modelAnalysis.confidence || 0;
        analysis.verificationPlan = modelAnalysis.verification_plan || [];
        analysis.evidence.push({ source: 'model-analysis', value: `confidence: ${analysis.confidence}, strategy: ${analysis.repairStrategy}` });
        logger.info('error-analyzer.model-assisted', {
          confidence: analysis.confidence,
          rootCause: analysis.rootCause,
          strategy: analysis.repairStrategy,
        });
      }
    } catch (err) {
      if (err instanceof ProviderError) {
        analysis.evidence.push({ source: 'model-analysis', value: `Model analysis failed: ${err.code} — falling back to deterministic` });
        logger.warn('error-analyzer.model.failed', { code: err.code, error: err.message });
      } else {
        analysis.evidence.push({ source: 'model-analysis', value: `Model analysis error: ${err.message}` });
        logger.warn('error-analyzer.model.error', { error: err.message });
      }
    }
  } else {
    analysis.analysisMethod = 'deterministic';
    analysis.confidence = isConfident ? 0.8 : 0.3;
  }

  logger.info('error-analyzer.complete', {
    whatFailed: analysis.whatFailed,
    rootCause: analysis.rootCause,
    relevantFiles: analysis.relevantFiles.length,
    repairStrategy: analysis.repairStrategy,
    shouldChangeStrategy: analysis.shouldChangeStrategy,
  });

  return analysis;
}

/**
 * HARDENING: Model-assisted error analysis.
 * When the deterministic analyzer cannot confidently establish root cause,
 * invoke the configured Ruflo/model intelligence with full context.
 *
 * Provides the model with:
 * - Build Contract
 * - current task
 * - exact error
 * - stack trace
 * - command output
 * - relevant files
 * - recent changes
 * - browser evidence
 * - runtime evidence
 * - previous repair attempts
 * - Ruflo memory results
 *
 * Returns structured analysis. Does NOT expose private chain-of-thought.
 * Stores concise conclusions and evidence only.
 */
async function modelAssistedAnalysis(context = {}) {
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
    deterministicAnalysis = {},
    memoryResults = [],
  } = context;

  // Build the prompt with full context
  const systemPrompt = `You are an expert software error analyst. Analyze the error and return structured JSON only.
Do not include chain-of-thought, explanations, or commentary — only the JSON result.

Return exactly this JSON structure:
{
  "failure_type": "BUILD_FAILURE|TEST_FAILURE|SYNTAX_ERROR|MISSING_DEPENDENCY|TYPE_ERROR|IMPORT_ERROR|BROWSER_FAILURE|NETWORK_FAILURE|UNKNOWN_FAILURE",
  "root_cause": "concise description of the actual root cause",
  "confidence": 0.0 to 1.0,
  "relevant_files": ["list of file paths that need modification"],
  "evidence": ["concise evidence items supporting the conclusion"],
  "repair_strategy": "ADD_DEPENDENCY|FIX_SYNTAX|FIX_IMPORT|FIX_TYPE|FIX_SOURCE|FIX_TEST|FIX_BROWSER|REGENERATE_FILE|SIMPLIFY_CODE|ESCALATE_TO_USER",
  "verification_plan": ["steps to verify the fix works"]
}`;

  // Assemble the user message with all available context
  const contextParts = [];

  if (buildContract) {
    contextParts.push(`BUILD CONTRACT:\n${JSON.stringify({
      goal: buildContract.goal,
      requirements: buildContract.requirements,
      acceptance_criteria: buildContract.acceptance_criteria,
      frontend: buildContract.frontend,
      backend: buildContract.backend,
    }, null, 2)}`);
  }

  if (taskDefinition) {
    contextParts.push(`CURRENT TASK:\n${JSON.stringify({
      task_id: taskDefinition.task_id,
      description: taskDefinition.description,
      agent_type: taskDefinition.agent_type,
      acceptance_criteria: taskDefinition.acceptance_criteria,
    }, null, 2)}`);
  }

  contextParts.push(`EXACT ERROR:\n${error.slice(0, 2000)}`);

  if (stackTrace) {
    contextParts.push(`STACK TRACE:\n${stackTrace.slice(0, 1000)}`);
  }

  if (failingCommand) {
    contextParts.push(`FAILING COMMAND:\n${failingCommand}`);
  }

  if (failingTest) {
    contextParts.push(`FAILING TEST:\n${failingTest}`);
  }

  if (browserEvidence) {
    contextParts.push(`BROWSER EVIDENCE:\n${JSON.stringify(browserEvidence).slice(0, 500)}`);
  }

  if (runtimeLogs) {
    contextParts.push(`RUNTIME LOGS:\n${runtimeLogs.slice(0, 500)}`);
  }

  if (deterministicAnalysis.relevantFiles?.length > 0) {
    contextParts.push(`RELEVANT FILES (from deterministic analysis):\n${deterministicAnalysis.relevantFiles.join(', ')}`);
  }

  if (previousRepairAttempts.length > 0) {
    contextParts.push(`PREVIOUS REPAIR ATTEMPTS:\n${JSON.stringify(previousRepairAttempts.map(a => ({
      strategy: a.strategy || a.repairStrategy,
      filesModified: a.filesModified,
      details: a.details,
      success: a.success,
    })), null, 2)}`);
  }

  if (memoryResults.length > 0) {
    contextParts.push(`RUFLO MEMORY RESULTS:\n${JSON.stringify(memoryResults.slice(0, 3)).slice(0, 500)}`);
  }

  contextParts.push(`DETERMINISTIC ANALYSIS (initial):\n${JSON.stringify({
    whatFailed: deterministicAnalysis.whatFailed,
    rootCause: deterministicAnalysis.rootCause,
    repairStrategy: deterministicAnalysis.repairStrategy,
  })}`);

  const userMessage = contextParts.join('\n\n---\n\n');

  const result = await chatCompletion({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  // Parse the JSON response — extract only conclusions, not chain-of-thought
  const content = result.content || '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn('error-analyzer.model.no-json', { content: content.slice(0, 200) });
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    // Validate the structure
    return {
      failure_type: parsed.failure_type || 'UNKNOWN_FAILURE',
      root_cause: String(parsed.root_cause || '').slice(0, 500),
      confidence: Math.min(1, Math.max(0, parseFloat(parsed.confidence) || 0)),
      relevant_files: Array.isArray(parsed.relevant_files) ? parsed.relevant_files.slice(0, 10) : [],
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.slice(0, 5) : [],
      repair_strategy: parsed.repair_strategy || 'FIX_SOURCE',
      verification_plan: Array.isArray(parsed.verification_plan) ? parsed.verification_plan.slice(0, 5) : [],
    };
  } catch (err) {
    logger.warn('error-analyzer.model.parse.failed', { error: err.message, content: content.slice(0, 200) });
    return null;
  }
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

// backend/src/osiri-personality.js — Osiri's conversational personality.
// Calm, intelligent, patient, warm, concise, natural.
// Feels like a thoughtful human technical partner, not a robotic CLI assistant.
import { logger } from './logger.js';

/**
 * Generate a natural conversational response based on the current task state.
 * This is NOT a chatbot — it reads real task state and responds from it.
 *
 * @param {string} userMessage - What the user said
 * @param {object} taskState - Current task state from task-store
 * @returns {string} Osiri's natural response
 */
export function respond(userMessage, taskState = {}) {
  const msg = (userMessage || '').toLowerCase().trim();
  const phase = taskState.phase || 'idle';
  const status = taskState.status || 'idle';

  // --- Status queries ---
  if (/what.*(doing|working|building)|status|progress|how.s.it.going/.test(msg)) {
    return statusQuery(phase, taskState);
  }

  // --- Failure queries ---
  if (/why.*fail|what.*error|show.*error|what.*wrong|what.*happened/.test(msg)) {
    return failureQuery(taskState);
  }

  // --- Pause/stop/resume ---
  if (/^stop$|^cancel$|^halt$/.test(msg) || /stop|cancel|halt/.test(msg)) {
    return "Got it. I'm stopping the current task. State is preserved so we can pick up where we left off.";
  }
  if (/^pause$/.test(msg) || /pause/.test(msg)) {
    return "Pausing now. The build state is saved — I'll hold here until you say continue.";
  }
  if (/^continue$|^resume$|^go$|^proceed$/.test(msg) || /continue|resume|proceed/.test(msg)) {
    return "Resuming from where we paused. Let me check the current state and pick back up.";
  }

  // --- File/log inspection ---
  if (/show.*file|view.*file|what.*files|list.*files/.test(msg)) {
    return fileQuery(taskState);
  }
  if (/show.*log|view.*log|server.*log/.test(msg)) {
    return logQuery(taskState);
  }
  if (/show.*test|view.*test|test.*result/.test(msg)) {
    return testQuery(taskState);
  }
  if (/show.*browser|browser.*result|browser.*test/.test(msg)) {
    return browserQuery(taskState);
  }

  // --- Modification requests ---
  if (/change|modify|update|different|use.*instead|switch/.test(msg)) {
    return "Understood. I'll adjust the approach based on what you've described. Let me update the plan and continue from there.";
  }

  // --- Approach change ---
  if (/different.*approach|other.*way|try.*again|new.*strategy/.test(msg)) {
    return "I'll switch strategies. The current approach wasn't working, so I'm pulling the evidence from the last attempt and trying a different angle.";
  }

  // --- Memory queries ---
  if (/memory|remember|learned|experience|past.*project/.test(msg)) {
    return memoryQuery(taskState);
  }

  // --- Greeting ---
  if (/^hi$|^hello$|^hey$|^good.*(morning|afternoon|evening)/.test(msg)) {
    return "Hi. I'm Osiri. Tell me what you'd like to build, and I'll handle the planning, implementation, and verification. You can check on progress or ask questions any time.";
  }

  // --- Build request (new task) ---
  if (/build|create|make|generate|deploy/.test(msg) && taskState.status === 'idle') {
    return "Got it. I'll check the existing workspace before changing anything, then plan the build from your description.";
  }

  // --- Default: acknowledge and contextualize ---
  if (status === 'RUNNING' || status === 'PLANNING' || status === 'VERIFYING') {
    return `I'm currently in the ${phase} phase. ${phaseDetail(phase)} You can ask me what I'm doing, or say "pause" if you'd like to step in.`;
  }

  // --- Completion ---
  if (status === 'COMPLETED') {
    return "Everything required by the build contract has now passed verification. Let me know if you'd like to build something else or adjust what we have.";
  }

  if (status === 'FAILED') {
    return `The build didn't complete. ${taskState.error ? `The issue was: ${taskState.error}` : 'I have the details if you want to see them.'} I can try a different approach if you'd like.`;
  }

  return "I'm here. Tell me what you'd like to build, or ask me about the current task state.";
}

function statusQuery(phase, taskState) {
  const details = {
    'planning': "I'm analyzing your request and figuring out the project structure — what files we need, what dependencies, and what order to build in.",
    'memory-retrieval': "I'm checking past build experiences to see if there's anything relevant I can learn from before starting.",
    'agent-selection': "I'm determining which agents are best suited for this task — coder, tester, architect, depending on complexity.",
    'executing': `I'm creating the project files. ${taskState.filesCreated?.length || 0} files written so far.`,
    'installing': "I'm installing dependencies. This may take a moment.",
    'building': "I'm running the build to check that everything compiles correctly.",
    'testing': "I'm running the test suite to verify the implementation works.",
    'fixing-build': "The build failed. I'm analyzing the error to find the root cause before attempting a fix.",
    'fixing-test': "A test failed. I'm looking at the failure to understand what went wrong.",
    'verifying': "I'm doing a final verification — checking that all files are in place and the build is solid.",
    'browser-inspection': "I'm running the application through a real browser to verify it renders and behaves correctly.",
    'error-analysis': "I'm collecting evidence from the failure to understand the root cause before trying to fix it.",
  };
  return details[phase] || `I'm working on the ${phase} phase of your build.`;
}

function failureQuery(taskState) {
  if (!taskState.error && !taskState.buildResult?.stderr) {
    return "I don't have a recorded error for this task yet. If something just failed, I may still be collecting the details.";
  }
  const err = taskState.error || taskState.buildResult?.stderr?.slice(0, 300) || 'Unknown error';
  const rootCause = taskState.errorAnalysis?.rootCause;
  if (rootCause) {
    return `I found the problem. ${rootCause}. The error was: ${err.slice(0, 200)}`;
  }
  return `The error was: ${err.slice(0, 300)}`;
}

function fileQuery(taskState) {
  const files = taskState.filesCreated || [];
  if (files.length === 0) return "No files have been created yet for this task.";
  return `Here are the files created so far: ${files.join(', ')}`;
}

function logQuery(taskState) {
  const logs = taskState.buildResult?.stderr || taskState.testResult?.stderr;
  if (!logs) return "I don't have server logs for this task yet.";
  return `Here are the recent logs:\n${logs.slice(0, 500)}`;
}

function testQuery(taskState) {
  if (!taskState.testResult) return "No tests have been run yet for this task.";
  const passed = taskState.testResult.exitCode === 0;
  return `Tests ${passed ? 'passed' : 'failed'}. Exit code: ${taskState.testResult.exitCode}.${passed ? '' : ` Output: ${(taskState.testResult.stderr || taskState.testResult.stdout || '').slice(0, 300)}`}`;
}

function browserQuery(taskState) {
  if (!taskState.browserResult) return "No browser inspection has been run yet for this task.";
  const br = taskState.browserResult;
  return `Browser inspection ${br.status === 'PASS' ? 'passed' : br.status === 'SKIP' ? 'was skipped (Playwright not available)' : 'found issues'}. ${br.errors?.length ? `Errors: ${br.errors.map(e => e.message).join('; ')}` : 'No errors detected.'}`;
}

function memoryQuery(taskState) {
  if (taskState.memoryPatterns > 0) {
    return `I retrieved ${taskState.memoryPatterns} relevant patterns from past builds before starting this task. I'll store what I learn here for future use too.`;
  }
  return "I check past build experiences before starting each task and store new learnings after completion. No relevant patterns were found for this particular request yet.";
}

function phaseDetail(phase) {
  const details = {
    'planning': 'Figuring out the project structure.',
    'executing': 'Writing the project files.',
    'building': 'Compiling and checking the build.',
    'testing': 'Running tests.',
    'verifying': 'Final checks before completion.',
  };
  return details[phase] || '';
}

/**
 * Generate a brief progress update (for SSE stream, not in response to a user message).
 * Short — meant to be spoken or displayed, not a full log.
 */
export function progressUpdate(phase, detail = {}) {
  const updates = {
    'INTERPRETING': "I'm understanding your request and pulling out the requirements.",
    'PLANNING': "I'm breaking this down into tasks — what needs to be built and in what order.",
    'TASK_SPLIT': "I've decomposed the build into individual tasks with dependencies.",
    'EXECUTING': `Creating project files. ${detail.filesCount || 0} written so far.`,
    'BUILDING': "Running the build to check everything compiles.",
    'TESTING': "Running the test suite.",
    'ERROR_DETECTED': "I found an error. I'm going to inspect it before changing anything.",
    'ANALYSIS_STARTED': "I'm collecting evidence and finding the root cause.",
    'FIX_STARTED': "I'm applying the smallest correction that should fix it.",
    'FIX_COMPLETED': "Fix applied. Rebuilding to verify.",
    'BROWSER_TEST_STARTED': "I'm checking the app in a real browser now.",
    'BROWSER_TEST_PASSED': "Browser inspection passed — the app renders and works correctly.",
    'BROWSER_TEST_FAILED': "Browser inspection found issues. I'm analyzing them.",
    'COMPLETED': "Everything required by the build contract has passed verification.",
    'FAILED': "The build couldn't be completed. I have the details if you need them.",
    'PAUSED': "Paused. State is preserved — say continue when you're ready.",
    'ESCALATING': "I've tried multiple approaches and none worked. I need your input on this one.",
  };
  return updates[phase] || null;
}

export const osiriPersonality = { respond, progressUpdate };

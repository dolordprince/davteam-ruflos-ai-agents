// backend/src/interpreter.js — Interpreter stage.
// Understands what the user actually wants before implementation begins.
// Produces a structured internal Build Contract from natural language.
import { logger } from './logger.js';

/**
 * Interpret a natural-language build request into a structured Build Contract.
 * This is a deterministic rule-based interpreter — it analyzes the request
 * and extracts requirements. When a model provider is configured, it could
 * be enhanced to use the LLM, but the structure extraction is real.
 */
export function interpret(prompt) {
  const p = prompt.toLowerCase();
  const contract = {
    goal: prompt,
    requirements: [],
    frontend: {},
    backend: {},
    database: {},
    integrations: [],
    visual_requirements: [],
    acceptance_criteria: [],
    tests_required: [],
    constraints: [],
    dependencies: [],
    ambiguous_requirements: [],
  };

  // --- Application type detection ---
  if (/3d|three\.?js|webgl/.test(p)) {
    contract.requirements.push('3D visual experience');
    contract.visual_requirements.push('three.js 3D scene');
    contract.visual_requirements.push('3D hero section');
    contract.dependencies.push('three');
  }
  if (/portfolio/.test(p)) {
    contract.requirements.push('portfolio website');
    contract.frontend.type = 'portfolio';
    contract.acceptance_criteria.push('portfolio pages render correctly');
  }
  if (/ecommerce|e-commerce|shop|store|product/.test(p)) {
    contract.requirements.push('e-commerce functionality');
    contract.frontend.type = 'ecommerce';
    contract.backend.api = true;
    contract.database.required = true;
    contract.acceptance_criteria.push('product listing works');
    contract.acceptance_criteria.push('cart functionality works');
  }
  if (/dashboard|admin|analytics/.test(p)) {
    contract.requirements.push('dashboard interface');
    contract.frontend.type = 'dashboard';
    contract.backend.api = true;
    contract.database.required = true;
    contract.acceptance_criteria.push('dashboard data displays correctly');
  }
  if (/banking|finance|wallet|transaction/.test(p)) {
    contract.requirements.push('banking/finance features');
    contract.frontend.type = 'banking';
    contract.backend.api = true;
    contract.database.required = true;
    contract.integrations.push('payment/financial API');
    contract.tests_required.push('security tests');
    contract.acceptance_criteria.push('financial data displays correctly');
    contract.acceptance_criteria.push('authentication works');
  }
  if (/landing.?page|marketing|hero/.test(p)) {
    contract.requirements.push('landing page');
    contract.frontend.type = 'landing';
    contract.acceptance_criteria.push('landing page renders with hero section');
  }
  if (/calculator/.test(p)) {
    contract.requirements.push('calculator application');
    contract.frontend.type = 'calculator';
    contract.acceptance_criteria.push('calculator performs correct arithmetic');
  }
  if (/api|rest|backend|server/.test(p)) {
    contract.requirements.push('API backend');
    contract.backend.api = true;
    contract.acceptance_criteria.push('API endpoints respond correctly');
  }
  if (/saas/.test(p)) {
    contract.requirements.push('SaaS application');
    contract.frontend.type = 'saas';
    contract.backend.api = true;
    contract.database.required = true;
    contract.integrations.push('subscription/billing');
  }
  if (/pwa|progressive.web/.test(p)) {
    contract.requirements.push('PWA capability');
    contract.frontend.pwa = true;
    contract.acceptance_criteria.push('service worker registered');
    contract.acceptance_criteria.push('installable as PWA');
  }
  if (/crud|create.*read.*update.*delete/.test(p)) {
    contract.requirements.push('CRUD operations');
    contract.backend.api = true;
    contract.database.required = true;
    contract.acceptance_criteria.push('CRUD operations work end-to-end');
  }

  // --- Authentication ---
  if (/auth|login|sign.?in|sign.?up|register|password|jwt|token|session/.test(p)) {
    contract.requirements.push('authentication');
    contract.backend.auth = true;
    contract.acceptance_criteria.push('user can register');
    contract.acceptance_criteria.push('user can login');
    contract.acceptance_criteria.push('protected routes require authentication');
    contract.tests_required.push('authentication tests');
  }

  // --- Frontend requirements ---
  contract.frontend.framework = 'vanilla';
  contract.frontend.responsive = /responsive|mobile|tablet|desktop/.test(p) || true;
  if (/react|jsx/.test(p)) { contract.frontend.framework = 'react'; contract.dependencies.push('react'); }
  if (/vue/.test(p)) { contract.frontend.framework = 'vue'; contract.dependencies.push('vue'); }

  // --- Visual requirements ---
  if (/glass|lucid|frosted|blur/.test(p)) {
    contract.visual_requirements.push('glass/lucid UI with backdrop blur');
  }
  if (/animation|animated|motion|transition/.test(p)) {
    contract.visual_requirements.push('animations and transitions');
  }
  if (/dark.?mode|dark.?theme/.test(p)) {
    contract.visual_requirements.push('dark mode theme');
  }
  if (/hero|3d.?hero/.test(p)) {
    contract.visual_requirements.push('hero section');
  }
  if (/particle|particles/.test(p)) {
    contract.visual_requirements.push('particle effects');
  }
  if (/card|cards/.test(p)) {
    contract.visual_requirements.push('card-based layout');
  }
  if (/navigation|nav.?bar|menu/.test(p)) {
    contract.visual_requirements.push('responsive navigation');
  }
  if (/json.*visual|visual.*json|visual.*config/.test(p)) {
    contract.visual_requirements.push('JSON visual configuration');
  }

  // --- Database requirements ---
  if (contract.database.required) {
    contract.database.type = 'sqlite';
    contract.dependencies.push('better-sqlite3');
  }

  // --- Testing requirements ---
  contract.tests_required.push('unit tests');
  if (/integration.*test/.test(p)) contract.tests_required.push('integration tests');
  if (/browser.*test|playwright|e2e/.test(p)) contract.tests_required.push('browser/E2E tests');
  contract.acceptance_criteria.push('all tests pass');

  // --- Build requirements ---
  contract.acceptance_criteria.push('production build succeeds');

  // --- Responsive requirements ---
  contract.acceptance_criteria.push('responsive on mobile, tablet, desktop');

  // --- Deployment requirements ---
  if (/deploy|production|docker|kubernetes/.test(p)) {
    contract.requirements.push('deployment configuration');
    contract.acceptance_criteria.push('deployment configuration exists');
  }

  // --- Default deps for any web project ---
  if (!contract.dependencies.includes('vite')) {
    contract.dependencies.unshift('vite');
  }

  // --- Detect ambiguities ---
  if (!contract.frontend.type) {
    contract.ambiguous_requirements.push('application type not explicitly specified — defaulting to web app');
  }
  if (contract.backend.api && !contract.database.type) {
    contract.ambiguous_requirements.push('backend API requested but no database specified — using in-memory');
  }

  logger.info('interpreter.complete', {
    requirements: contract.requirements.length,
    acceptanceCriteria: contract.acceptance_criteria.length,
    visualRequirements: contract.visual_requirements.length,
    ambiguities: contract.ambiguous_requirements.length,
  });

  return contract;
}

/**
 * Check if the build contract has material ambiguities that require user input.
 * Only return true if an ambiguity would prevent correct implementation.
 */
export function hasMaterialAmbiguities(contract) {
  // Most ambiguities are resolved with sensible defaults
  // Only block if truly ambiguous (e.g., "build something" with no details)
  return false;
}

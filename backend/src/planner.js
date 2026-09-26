// backend/src/planner.js — Planner + Task Decomposer stage.
// Breaks the Build Contract into executable tasks with dependencies, agent types, and acceptance criteria.
import { logger } from './logger.js';

/**
 * Decompose a Build Contract into a sequence of executable tasks.
 * Each task has: task_id, description, agent_type, dependencies, files/scope,
 * inputs, outputs, acceptance_criteria, validation_required, priority, status.
 */
export function decompose(contract) {
  const tasks = [];
  let id = 0;
  const nextId = () => `task-${String(++id).padStart(3, '0')}`;

  // TASK 001: Architecture
  tasks.push({
    task_id: nextId(),
    description: 'Define project structure, directory layout, and base configuration',
    agent_type: 'architect',
    dependencies: [],
    files: ['package.json', 'vite.config.js', 'index.html', '.gitignore'],
    inputs: { contract },
    outputs: { projectStructure: 'determined' },
    acceptance_criteria: ['project structure created', 'package.json valid'],
    validation_required: true,
    priority: 1,
    status: 'pending',
  });

  // TASK 002: Frontend UI
  const frontendFiles = ['index.html', 'src/main.js', 'src/styles.css'];
  tasks.push({
    task_id: nextId(),
    description: 'Implement frontend UI components, layout, and responsive design',
    agent_type: 'frontend',
    dependencies: ['task-001'],
    files: frontendFiles,
    inputs: { contract, projectStructure: 'from architect' },
    outputs: { frontend: 'implemented' },
    acceptance_criteria: [
      'pages render correctly',
      'responsive on mobile/tablet/desktop',
      ...(contract.frontend.auth ? ['login/register forms exist'] : []),
    ],
    validation_required: true,
    priority: 2,
    status: 'pending',
  });

  // TASK 003: Backend API (if required)
  if (contract.backend.api) {
    tasks.push({
      task_id: nextId(),
      description: 'Implement backend API endpoints and server logic',
      agent_type: 'backend',
      dependencies: ['task-001'],
      files: ['server.js', 'src/api/'],
      inputs: { contract, projectStructure: 'from architect' },
      outputs: { backend: 'implemented', endpoints: [] },
      acceptance_criteria: ['API endpoints respond', 'error handling works'],
      validation_required: true,
      priority: 2,
      status: 'pending',
    });
  }

  // TASK 004: Database (if required)
  if (contract.database.required) {
    tasks.push({
      task_id: nextId(),
      description: 'Implement database schema, models, and persistence layer',
      agent_type: 'database',
      dependencies: ['task-001'],
      files: ['src/db/', 'schema.sql'],
      inputs: { contract, projectStructure: 'from architect' },
      outputs: { database: 'implemented', schema: 'defined' },
      acceptance_criteria: ['database initializes', 'CRUD operations work'],
      validation_required: true,
      priority: 2,
      status: 'pending',
    });
  }

  // TASK 005: Authentication (if required)
  if (contract.backend.auth) {
    tasks.push({
      task_id: nextId(),
      description: 'Implement authentication: register, login, session/token management',
      agent_type: 'backend',
      dependencies: ['task-003', 'task-004'].filter(d => tasks.find(t => t.task_id === d)),
      files: ['src/auth/', 'src/middleware/'],
      inputs: { contract, backend: 'from backend agent' },
      outputs: { auth: 'implemented' },
      acceptance_criteria: ['user can register', 'user can login', 'protected routes work'],
      validation_required: true,
      priority: 3,
      status: 'pending',
    });
  }

  // TASK 006: Visual system (if visual requirements exist)
  if (contract.visual_requirements.length > 0) {
    const visualFiles = ['visual-spec.json'];
    if (contract.visual_requirements.some(v => v.includes('three.js'))) {
      visualFiles.push('src/scene.js');
    }
    if (contract.visual_requirements.some(v => v.includes('glass'))) {
      visualFiles.push('src/effects.js');
    }
    tasks.push({
      task_id: nextId(),
      description: 'Implement visual system: JSON visual spec, effects, 3D scenes, glass UI',
      agent_type: 'visual',
      dependencies: ['task-002'],
      files: visualFiles,
      inputs: { contract, visualRequirements: contract.visual_requirements, frontend: 'from frontend agent' },
      outputs: { visualSpec: 'generated', effects: 'implemented' },
      acceptance_criteria: ['visual spec is valid JSON', 'visual effects render', '3D scene loads if applicable'],
      validation_required: true,
      priority: 3,
      status: 'pending',
    });
  }

  // TASK 007: Integrations (if any)
  for (const integration of contract.integrations) {
    tasks.push({
      task_id: nextId(),
      description: `Implement integration: ${integration}`,
      agent_type: 'backend',
      dependencies: ['task-003'].filter(d => tasks.find(t => t.task_id === d)),
      files: ['src/integrations/'],
      inputs: { contract, integration },
      outputs: { integration: 'implemented' },
      acceptance_criteria: [`integration with ${integration} works`],
      validation_required: true,
      priority: 3,
      status: 'pending',
    });
  }

  // TASK 008: Tests
  tasks.push({
    task_id: nextId(),
    description: 'Create unit and integration tests for all implemented features',
    agent_type: 'tester',
    dependencies: tasks.map(t => t.task_id).slice(0, -1), // depends on all previous tasks
    files: ['test/'],
    inputs: { contract, acceptanceCriteria: contract.acceptance_criteria },
    outputs: { tests: 'written', testResults: null },
    acceptance_criteria: ['all tests pass', 'test coverage adequate'],
    validation_required: true,
    priority: 4,
    status: 'pending',
  });

  // TASK 009: Browser inspection (for web applications)
  if (contract.frontend.type || contract.frontend.framework) {
    tasks.push({
      task_id: nextId(),
      description: 'Run Playwright browser inspection on the running application',
      agent_type: 'browser',
      dependencies: [tasks[tasks.length - 1].task_id],
      files: [],
      inputs: { contract, app: 'built and running' },
      outputs: { browserResults: null },
      acceptance_criteria: ['application starts', 'pages render', 'no console errors'],
      validation_required: true,
      priority: 5,
      status: 'pending',
    });
  }

  // TASK 010: Final inspection
  tasks.push({
    task_id: nextId(),
    description: 'Final independent inspection: compare result against Build Contract',
    agent_type: 'inspector',
    dependencies: tasks.map(t => t.task_id),
    files: [],
    inputs: { contract, allOutputs: 'from all agents' },
    outputs: { finalInspection: null, verdict: null },
    acceptance_criteria: contract.acceptance_criteria,
    validation_required: true,
    priority: 6,
    status: 'pending',
  });

  logger.info('planner.complete', { taskCount: tasks.length });
  return tasks;
}

/**
 * Get the execution order of tasks respecting dependencies.
 */
export function getExecutionOrder(tasks) {
  const order = [];
  const completed = new Set();
  const remaining = [...tasks];

  while (remaining.length > 0) {
    const ready = remaining.filter(t =>
      t.dependencies.every(d => completed.has(d))
    );
    if (ready.length === 0) {
      // Circular dependency or missing dep — add remaining in order
      order.push(...remaining);
      break;
    }
    for (const task of ready) {
      order.push(task);
      completed.add(task.task_id);
      remaining.splice(remaining.indexOf(task), 1);
    }
  }

  return order;
}

// Embedded configuration profiles — bundled as string constants so they ship with
// any distribution format (tsc, Bun compile, npm package).
//
// If you edit the YAML files in templates/profiles/, regenerate this module
// or update the strings below.

export interface ProfileMeta {
  /** Short human-readable description for --list-presets. */
  description: string;
  /** Full YAML config template. */
  yaml: string;
}

export const EMBEDDED_PROFILES: Record<string, ProfileMeta> = {
  fullstack: {
    description: 'Full-stack development with frontend, backend, QA, SRE, and security agents',
    yaml: `# AgentHive Profile: Full-Stack Development
# A comprehensive setup for full-stack projects with frontend, backend, QA, SRE, and security agents.

defaults:
  poll: 60
  budget: 2.00
  daily_max: 20.00
  model: sonnet
  skip_permissions: true
  notifications: false
  notify_on:
    - DONE
    - BLOCKER

agents:
  sre:
    description: "Site Reliability Engineer"
    agent: sre
  frontend:
    description: "Frontend Developer"
    agent: frontend
    poll: 90
  backend:
    description: "Backend Engineer"
    agent: backend
  qa:
    description: "Quality Analyst"
    agent: qa
    poll: 90
  security:
    description: "Security Engineer"
    agent: appsec

hooks:
  safety:
    - destructive-guard
  coordination:
    - check-chat
`,
  },

  'security-audit': {
    description: 'Security audit with higher budgets for thorough analysis',
    yaml: `# AgentHive Profile: Security Audit
# Focused on security analysis with dedicated security, QA, and SRE agents.
# Higher budgets for thorough analysis and slower polling for deep work.

defaults:
  poll: 120
  budget: 5.00
  daily_max: 40.00
  model: sonnet
  skip_permissions: true
  notifications: true
  notify_on:
    - DONE
    - BLOCKER
    - WARN

agents:
  security:
    description: "Security Engineer — lead auditor"
    agent: appsec
    budget: 8.00
    poll: 90
  backend:
    description: "Backend Engineer — assists with code review"
    agent: backend
  qa:
    description: "Quality Analyst — regression testing"
    agent: qa
  sre:
    description: "Site Reliability Engineer — infra and config review"
    agent: sre

hooks:
  safety:
    - destructive-guard
  coordination:
    - check-chat
`,
  },

  refactor: {
    description: 'Large-scale refactoring with backend, QA, and SRE agents',
    yaml: `# AgentHive Profile: Refactoring
# Optimized for large-scale codebase refactoring with backend, QA, and SRE agents.
# Higher budgets for complex multi-file changes, QA runs frequently to catch regressions.

defaults:
  poll: 60
  budget: 3.00
  daily_max: 30.00
  model: sonnet
  skip_permissions: true
  notifications: false
  notify_on:
    - DONE
    - BLOCKER

agents:
  backend:
    description: "Backend Engineer — primary refactoring agent"
    agent: backend
    budget: 5.00
  qa:
    description: "Quality Analyst — continuous regression testing"
    agent: qa
    poll: 45
  sre:
    description: "Site Reliability Engineer — build and CI verification"
    agent: sre

hooks:
  safety:
    - destructive-guard
  coordination:
    - check-chat
`,
  },

  solo: {
    description: 'Single backend agent for solo projects or quick tasks',
    yaml: `# AgentHive Profile: Solo Developer
# Minimal setup with a single backend agent — ideal for solo projects or quick tasks.
# Lower budget caps and faster polling for tight iteration loops.

defaults:
  poll: 45
  budget: 2.00
  daily_max: 15.00
  model: sonnet
  skip_permissions: true
  notifications: false
  notify_on:
    - DONE
    - BLOCKER

agents:
  backend:
    description: "Backend Engineer"
    agent: backend

hooks:
  safety:
    - destructive-guard
  coordination:
    - check-chat
`,
  },

  review: {
    description: 'Code review with security, QA, and backend agents',
    yaml: `# AgentHive Profile: Code Review
# Setup for thorough code review with security, QA, and backend agents.
# Lower budgets per task (reviews are shorter), higher polling frequency.

defaults:
  poll: 90
  budget: 1.50
  daily_max: 15.00
  model: sonnet
  skip_permissions: true
  notifications: true
  notify_on:
    - DONE
    - BLOCKER
    - WARN

agents:
  security:
    description: "Security Engineer — vulnerability scanning"
    agent: appsec
  qa:
    description: "Quality Analyst — test coverage and correctness"
    agent: qa
  backend:
    description: "Backend Engineer — code quality and architecture review"
    agent: backend
    budget: 1.00

hooks:
  safety:
    - destructive-guard
  coordination:
    - check-chat
`,
  },

  'backend-only': {
    description: 'Backend-focused with SRE, backend, QA, and security agents',
    yaml: `# AgentHive Profile: Backend Only
# Backend-focused setup without frontend — ideal for APIs, services, and CLI tools.

defaults:
  poll: 60
  budget: 2.00
  daily_max: 20.00
  model: sonnet
  skip_permissions: true
  notifications: false
  notify_on:
    - DONE
    - BLOCKER

agents:
  sre:
    description: "Site Reliability Engineer"
    agent: sre
  backend:
    description: "Backend Engineer"
    agent: backend
  qa:
    description: "Quality Analyst"
    agent: qa
    poll: 90
  security:
    description: "Security Engineer"
    agent: appsec

hooks:
  safety:
    - destructive-guard
  coordination:
    - check-chat
`,
  },

  minimal: {
    description: 'Minimal setup with backend and QA agents',
    yaml: `# AgentHive Profile: Minimal
# Lightweight two-agent setup for small projects.

defaults:
  poll: 60
  budget: 2.00
  daily_max: 20.00
  model: sonnet
  skip_permissions: true
  notifications: false
  notify_on:
    - DONE
    - BLOCKER

agents:
  backend:
    description: "Backend Engineer"
    agent: backend
  qa:
    description: "Quality Analyst"
    agent: qa
    poll: 90

hooks:
  safety:
    - destructive-guard
  coordination:
    - check-chat
`,
  },
};

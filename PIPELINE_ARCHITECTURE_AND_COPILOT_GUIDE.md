# Dynamics 365 UI Automation Pipeline — Architecture & AI Maintenance Guide

This document records the architectural design, core invariants, and operational guidelines for the Dynamics 365 UI Automation Azure DevOps pipeline. It also provides specific prompt contexts and rules for using AI coding tools (e.g., GitHub Copilot, Claude, ChatGPT) when extending or optimizing this codebase in the future.

---

## 1. System Overview & Architecture

### The Core Problem Solved
In Microsoft Dynamics 365 UI automation, service accounts are assigned security roles dynamically at test startup. When multiple Playwright test scenarios share the same service account concurrently with *different* required roles, the role assignments conflict mid-execution, causing test failures.

### The Solution: Pure Persona Bucketing & Dynamic Matrix Execution
This pipeline groups tests **strictly by persona/role** (`@persona:RoleName`), across all applications in the monorepo.
- **1 Persona = 1 Azure DevOps Agent Job = 1 Dedicated Service Account**.
- Tests inside a persona job run with **N Playwright workers** in parallel safely (because all workers share the exact same role).
- If more persona buckets exist than available service accounts, Azure DevOps's job queue **naturally throttles and queues** the extra jobs until an account becomes free.

```
                  ┌─────────────────────────────────────────┐
                  │ Manual Trigger (Environment & Tag Filter)│
                  └────────────────────┬────────────────────┘
                                       │
                                       ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ STAGE 1: Discover (1 Agent Job, ~10s execution)                          │
 │  • Reads root package.json "workspaces"                                   │
 │  • Parses Gherkin .feature files (no npm / no bddgen required)           │
 │  • Validates @persona:XXX tag on all matched scenarios                    │
 │  • Groups scenarios by unique persona into compact matrix JSON           │
 └─────────────────────────────────────┬────────────────────────────────────┘
                                       │
                                       ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ STAGE 2: Test Execution (Dynamic Matrix, Up to 10 Parallel Agent Jobs)   │
 │                                                                          │
 │ ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐ │
 │ │ Job 1: AdminUser     │ │ Job 2: SalesAgent    │ │ Job 3: FinanceUser   │ │
 │ │ Account: auto01      │ │ Account: auto02      │ │ Account: auto03      │ │
 │ │ 4 Browser Workers    │ │ 4 Browser Workers    │ │ 4 Browser Workers    │ │
 │ └──────────────────────┘ └──────────────────────┘ └──────────────────────┘ │
 └─────────────────────────────────────┬────────────────────────────────────┘
                                       │
                                       ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ STAGE 3: Report (1 Agent Job, ~10s execution)                            │
 │  • Downloads test result artifacts from all jobs                         │
 │  • Merges JUnit XML reports into Azure DevOps Tests tab                  │
 └─────────────────────────────────────┴────────────────────────────────────┘
```

---

## 2. Component Inventory

| File | Primary Responsibility |
|---|---|
| [`azure-pipelines.yml`](file:///Users/hari/Documents/Workspace/Antigravity/Dynamics-ui-automation-pipeline/azure-pipelines.yml) | Orchestrates the 3 stages, exposes manual UI trigger parameters, manages dynamic matrix expansion, handles secret env injection. |
| [`scripts/discover-personas.js`](file:///Users/hari/Documents/Workspace/Antigravity/Dynamics-ui-automation-pipeline/scripts/discover-personas.js) | Fast, zero-dependency Node.js script. Reads `package.json` workspaces, parses `.feature` files, validates persona tags, and emits single-line JSON matrix. |
| [`scripts/assign-account.sh`](file:///Users/hari/Documents/Workspace/Antigravity/Dynamics-ui-automation-pipeline/scripts/assign-account.sh) | Reads UI account toggles, parses `SERVICE_ACCOUNT_CATALOG_JSON` using `jq`, applies modulo math (`SLOT % COUNT`) for wrap-around account assignment, emits secret job vars (`TEST_USERNAME`, `TEST_PASSWORD`). |
| [`playwright.config.base.ts`](file:///Users/hari/Documents/Workspace/Antigravity/Dynamics-ui-automation-pipeline/playwright.config.base.ts) | Monorepo base Playwright config. Configures workers, retries, reporters (JUnit XML + HTML), timeouts, and exports `getServiceAccountCredentials()`. |
| [`package.json`](file:///Users/hari/Documents/Workspace/Antigravity/Dynamics-ui-automation-pipeline/package.json) | Monorepo root. Defines `workspaces: ["apps/*", "packages/*"]` used by `discover-personas.js` as the single source of truth. |

---

## 3. Strict System Invariants (Rules That Must Never Be Broken)

When modifying this repository, maintain these architectural constraints:

1. **Zero-Dependency Discovery**: `scripts/discover-personas.js` MUST use Node.js built-in APIs only (`fs`, `path`). Do NOT add `npm ci`, `bddgen`, or external NPM packages to Stage 1. This keeps discovery under 10 seconds.
2. **No Hardcoded App Paths**: Never hardcode app directories in pipeline YAML or scripts. Discovery MUST read `package.json` `workspaces`.
3. **Secret Masking & Arguments**: Pass credentials ONLY via task `env:` blocks. NEVER pass passwords or sensitive JSON strings as script CLI arguments (which get logged by the OS).
4. **Tag Validation Safety Net**: Every scenario matched by a filter tag MUST have a `@persona:XXX` tag. If missing, Stage 1 MUST fail immediately before any browsers launch.
5. **Deterministic Slot Mapping**: Account assignment MUST use alphabetical sorting of keys and modulo math (`SLOT % AVAILABLE_COUNT`) to ensure safe wrap-around reuse without role collisions.

---

## 4. AI Tool Guide (GitHub Copilot / Cursor / Claude)

When using AI tools to enhance or maintain this repo, feed the AI assistant the following contextual rules and prompt patterns.

### Prompt Context Rule (System Prompt Add-on)
> *Copy-paste this snippet into your AI workspace settings or custom instructions (.github/copilot-instructions.md):*

```markdown
This repository is a Playwright BDD TypeScript monorepo for Dynamics 365 UI automation.
Key Invariants:
1. Tests are grouped into Azure DevOps dynamic matrix jobs by @persona:XXX tags.
2. Root package.json "workspaces" is the single source of truth for app discovery.
3. Discover stage (scripts/discover-personas.js) uses Node.js built-in modules ONLY (no npm packages).
4. Service accounts are dynamically assigned per slot via scripts/assign-account.sh using modulo arithmetic on SERVICE_ACCOUNT_CATALOG_JSON.
5. Credentials must NEVER be logged or passed as CLI arguments; always use env: blocks with issecret=true.
```

---

### Common Prompt Templates for AI Assistants

#### Template 1: Adding a New Feature or Persona Tag
```text
I want to add a new scenario to apps/sales-hub/tests/features/orders.feature for a "CustomerService" role.
Following our repository rules:
1. What tag format should I use on the Scenario?
2. Do I need to update azure-pipelines.yml or discover-personas.js? (Hint: check workspace discovery rules).
3. What changes are needed in Azure DevOps Variable Group SERVICE_ACCOUNT_CATALOG_JSON if a new service account is added?
```

#### Template 2: Optimizing Playwright Performance
```text
Review playwright.config.base.ts and suggest optimizations for Dynamics 365 UI automation.
Keep in mind:
- Azure DevOps Microsoft-hosted agents have 2 vCPUs / 7 GB RAM.
- Retries must stay at 1 for CI.
- Credentials must be read via getServiceAccountCredentials().
- Do not break the JUnit or HTML reporter structure.
```

#### Template 3: Migrating Secret Management to Azure Key Vault
```text
We want to update scripts/assign-account.sh to fetch credentials from Azure Key Vault instead of the Variable Group JSON string.
Requirements:
- Preserve the modulo assignment logic (SLOT % AVAILABLE_COUNT).
- Ensure task output variables still use task.setvariable with issecret=true.
- Provide the updated bash script while maintaining zero log leaks.
```

---

## 5. Maintenance Checklist for Developers

- [ ] **Adding a new app**: Create `apps/my-app/` with `playwright.config.ts`. Ensure `apps/*` is in root `package.json` workspaces. No pipeline edits required.
- [ ] **Adding a new shared library**: Create `packages/my-lib/`. It will be automatically included in `npm ci` at repo root and excluded from test discovery (because it lacks `playwright.config.ts`).
- [ ] **Rotating a service account password**: Update `SERVICE_ACCOUNT_CATALOG_JSON` in Azure DevOps Variable Group `dynamics365-service-accounts`. No code edits required.
- [ ] **Adding a new account to the pool**: Add key `"auto08"` to `SERVICE_ACCOUNT_CATALOG_JSON` and add `- name: use_auto08` to `azure-pipelines.yml` parameters.

# Dynamics 365 UI Automation Pipeline

Persona-aware, parallel Playwright BDD test pipeline for Microsoft Dynamics 365 apps.

---

## Repository Structure

```
.
├── azure-pipelines.yml            ← Single monolithic pipeline definition
├── playwright.config.base.ts      ← Shared base config all apps extend
├── scripts/
│   ├── discover-personas.js       ← Stage 1: parse feature files, emit persona matrix
│   └── assign-account.sh          ← Stage 2: resolve service account by slot index
├── templates/
│   └── playwright.config.template.ts  ← Copy this into each new app
├── apps/
│   ├── address-management/        ← Individual D365 app (own package.json)
│   ├── sales-hub/
│   └── billing/
├── package.json                   ← Root (minimal — scripts runner only)
└── .gitignore
```

---

## How the Pipeline Works

### Three-stage architecture

```
Stage 1 — Discover (single job)
  Parses feature files in the selected app directory.
  Filters scenarios by the comma-separated tags you provide (OR logic).
  Validates every matched scenario has a @persona:XXX tag → fails early with
  a clear list of violating scenarios if any are missing.
  Emits a compact JSON matrix: one entry per unique persona.

Stage 2 — Test Execution (dynamic matrix, 1 job per persona bucket)
  Azure DevOps spawns a separate agent job for each persona.
  Each job:
    1. Installs app dependencies & Playwright browsers.
    2. Generates playwright-bdd spec files (bddgen) for the persona.
    3. Resolves a service account from the JSON catalog by slot index.
    4. Runs: npx playwright test --grep "@persona:<PERSONA>"
       All tests within the bucket run in parallel (PLAYWRIGHT_WORKERS workers).
       All workers share the same service account → no role-conflict.
    5. Publishes JUnit XML + HTML report + traces as pipeline artifacts.

Stage 3 — Report (always runs)
  Downloads all per-persona artifacts.
  Merges JUnit XMLs → combined result in the Azure DevOps Tests tab.
  Prints a run summary to the job log.
```

### Back-pressure / queuing

- Azure DevOps job queue is the natural throttle.
- `maxParallelJobs` (default: 5) caps how many persona buckets run simultaneously.
- Excess buckets wait in queue until an agent slot frees — no custom locking needed.
- Service account slot `N` is deterministically assigned to matrix leg `N`
  (alphabetically sorted account keys), so no two concurrent jobs ever use the
  same account.

---

## One-time Setup

### 1. Variable Group

In **Azure DevOps → Pipelines → Library**, create a Variable Group named
`dynamics365-service-accounts` with these entries:

| Name | Value | Secret? |
|---|---|---|
| `SERVICE_ACCOUNT_CATALOG_JSON` | `{"auto01":{"username":"svc_auto01@org.com","password":"..."},"auto02":{"username":"svc_auto02@org.com","password":"..."}}` | 🔒 Yes |
| `DYNAMICS_URL_DEV` | `https://your-org.crm.dynamics.com/dev` | No |
| `DYNAMICS_URL_STAGING` | `https://your-org.crm.dynamics.com/staging` | No |
| `DYNAMICS_URL_UAT` | `https://your-org.crm.dynamics.com/uat` | No |

> **Important**: Click the 🔒 padlock icon on `SERVICE_ACCOUNT_CATALOG_JSON` to
> mark it as a secret. Azure DevOps will encrypt it at rest and mask its literal
> value in all log output.

Add account entries in order (auto01, auto02, …). The pipeline assigns slot 0 →
first alphabetical key, slot 1 → second, etc. Keep key names consistent.

### 2. Link the pipeline

In Azure DevOps → Pipelines → New Pipeline, point to `azure-pipelines.yml` in
this repository.

### 3. Authorise the Variable Group

On the first run, Azure DevOps will ask you to authorise the pipeline to use the
Variable Group. Approve it. Subsequent runs are automatic.

---

## Running the Pipeline

1. Go to **Azure DevOps → Pipelines → [your pipeline] → Run pipeline**.
2. Fill in the parameters:

| Parameter | Example | Notes |
|---|---|---|
| **App Path** | `apps/address-management` | Relative path to the D365 app |
| **Filter Tags** | `@AddressModule,@OrderModule` | Comma-separated, OR logic |
| **Environment** | `dev` | `dev` / `staging` / `uat` |
| **Max Parallel Jobs** | `5` | Cap concurrent persona buckets |
| **Playwright Workers** | `4` | Workers per persona bucket |

3. Click **Run**.

---

## Feature File Tag Convention

Every scenario that participates in the pipeline **must** have a `@persona:XXX` tag.
The `@persona:` prefix is required exactly as shown.

```gherkin
@AddressModule @persona:AddressValidation
Scenario: Create a new shipping address
  Given I am logged in as the address validation user
  When I navigate to the address form
  ...

@AddressModule @persona:AdminUser
Scenario: Delete an existing address
  Given I am logged in as an admin
  ...
```

Scenario Outline examples inherit tags from the parent scenario:

```gherkin
@OrderModule @persona:SalesAgent
Scenario Outline: Process order for <region>
  ...
  Examples:
    | region  |
    | UK      |
    | US      |
```

### Adding a new persona

1. Add `@persona:MyNewPersona` to the relevant scenarios in your feature files.
2. Ensure a service account capable of being assigned the `MyNewPersona` role is
   listed in `SERVICE_ACCOUNT_CATALOG_JSON`. Add a new `autoNN` entry if needed.
3. No pipeline changes required — the matrix expands automatically.

---

## Adding a New D365 App

1. Create the app directory, e.g. `apps/my-new-app/`.
2. Copy `templates/playwright.config.template.ts` → `apps/my-new-app/playwright.config.ts`.
3. Create `apps/my-new-app/package.json` with `playwright-bdd` and `@playwright/test` as dependencies.
4. Add feature files under `apps/my-new-app/tests/features/`.
5. Run the pipeline with `appPath = apps/my-new-app`.

---

## Local Development

```bash
# Set credentials in your shell (never commit these)
export DYNAMICS_URL=https://your-org.crm.dynamics.com/dev
export TEST_USERNAME=svc_auto01@org.com
export TEST_PASSWORD=your-password
export PERSONA_FILTER=AddressValidation

# In the app directory:
cd apps/address-management

# Install dependencies
npm ci

# Generate playwright-bdd spec files
npx bddgen

# Run tests locally
npx playwright test --grep "@persona:AddressValidation"

# Open the HTML report
npx playwright show-report
```

### Test the discovery script locally

```bash
# From the repo root:
APP_PATH=apps/address-management \
FILTER_TAGS="@AddressModule,@OrderModule" \
node scripts/discover-personas.js
```

### Test the account assignment script locally

```bash
export SERVICE_ACCOUNT_CATALOG_JSON='{"auto01":{"username":"u1","password":"p1"},"auto02":{"username":"u2","password":"p2"}}'
SLOT=0 bash scripts/assign-account.sh
SLOT=1 bash scripts/assign-account.sh
```

---

## Security Notes

| Risk | Mitigation |
|---|---|
| Credentials in logs | `issecret=true` on all extracted credentials; `env:` block injection |
| Credentials in YAML | Never hardcoded — Variable Group only |
| Cross-job credential leakage | Each job receives exactly one account's credentials |
| Plaintext in test code | Use `getServiceAccountCredentials()` from base config; never log the result |
| Credential in test report | Don't `console.log` or print `process.env.TEST_*` in tests |
| `.env` files | `.gitignore` excludes all `.env*` files |

---

## Troubleshooting

**"No personas found matching tags"**
→ Check your `filterTags` parameter matches tags used in the feature files.
→ Run `discover-personas.js` locally to verify.

**"Slot N exceeds available service accounts"**
→ Add more `autoNN` entries to `SERVICE_ACCOUNT_CATALOG_JSON` in the Variable Group.

**"Missing @persona tag" failure in Stage 1**
→ Add `@persona:XXX` to the listed scenarios before re-running.

**Jobs queue instead of running in parallel**
→ Your org may have fewer than `maxParallelJobs` licensed MS-hosted parallel jobs.
→ Check: Azure DevOps → Org Settings → Pipelines → Parallel jobs.

**`bddgen` fails with "no step definitions found"**
→ Ensure `npm ci` ran successfully and that step definition paths in
   `playwright.config.ts` match your actual `tests/steps/` file layout.

import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig }       from 'playwright-bdd';
import os                          from 'os';
import fs                          from 'fs';
import path                        from 'path';

/**
 * playwright.config.base.ts
 *
 * Shared base Playwright configuration for Dynamics 365 app projects in the monorepo.
 * 
 * Features:
 *   - Automatic per-app runConfig.json loading for customizable app defaults
 *   - Auto-worker calculation based on agent vCPU capacity (vCPUs * 1.5)
 *   - Dynamic browser resolution (chromium, firefox, webkit, all)
 *   - Reporters for JUnit XML, Blob Report (for Stage 3 merging), Allure, and terminal list
 */

export interface RunConfigJson {
  headless?: boolean;
  retries?: number;
  testTimeout?: number;
  expectTimeout?: number;
  actionTimeout?: number;
  navigationTimeout?: number;
}

export interface AppConfigOverrides {
  additionalProjects?: ReturnType<typeof defineConfig>['projects'];
  testTimeout?: number;
  expectTimeout?: number;
  retries?: number;
  useOptions?: Parameters<typeof defineConfig>[0]['use'];
}

/**
 * Reads runConfig.json from the active app project directory if present.
 */
function loadRunConfig(): RunConfigJson {
  const configPath = path.join(process.cwd(), 'runConfig.json');
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      if (process.env.CI !== 'true') {
        process.stderr.write(`⚙️  Loaded app runConfig.json from ${configPath}\n`);
      }
      return JSON.parse(raw);
    } catch (e) {
      if (process.env.CI !== 'true') {
        process.stderr.write(`⚠️ Failed to parse runConfig.json at ${configPath}, using default settings.\n`);
      }
    }
  }
  return {};
}

/**
 * Resolves the optimal number of parallel Playwright workers.
 * Respects PLAYWRIGHT_WORKERS env var if > 0; otherwise auto-calculates (vCPUs * 1.5).
 */
function resolveWorkerCount(): number {
  const envVal = process.env.PLAYWRIGHT_WORKERS;
  const userWorkers = envVal ? parseInt(envVal, 10) : 0;

  if (userWorkers > 0) {
    return userWorkers;
  }

  const vCpus = os.cpus().length;
  const autoWorkers = Math.max(2, Math.floor(vCpus * 1.5));
  if (process.env.CI !== 'true') {
    process.stderr.write(`⚡ [Auto Workers] Host machine has ${vCpus} vCPU(s) → Spawning ${autoWorkers} parallel browser workers.\n`);
  }
  return autoWorkers;
}

/**
 * Resolves Playwright projects based on BROWSER_NAME env var (chromium, firefox, webkit, all).
 */
function resolveProjects(overrideProjects?: ReturnType<typeof defineConfig>['projects']) {
  if (overrideProjects && overrideProjects.length > 0) {
    return overrideProjects;
  }

  const browser = (process.env.BROWSER_NAME || 'chromium').toLowerCase();

  switch (browser) {
    case 'firefox':
      return [{ name: 'firefox', use: { ...devices['Desktop Firefox'] } }];
    case 'webkit':
      return [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }];
    case 'all':
      return [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
      ];
    case 'chromium':
    default:
      return [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }];
  }
}

/**
 * Creates a fully configured Playwright config for a D365 app.
 */
export function createBaseConfig(
  bddConfig: ReturnType<typeof defineBddConfig>,
  overrides: AppConfigOverrides = {},
) {
  const isCI = process.env.CI === 'true';
  const baseURL = process.env.DYNAMICS_URL;
  const runConfig = loadRunConfig();

  return defineConfig({
    testDir: bddConfig,
    fullyParallel: true,
    workers: resolveWorkerCount(),

    // Priority: App override -> runConfig.json -> Default (90s)
    timeout: overrides.testTimeout ?? runConfig.testTimeout ?? 90_000,
    expect: { timeout: overrides.expectTimeout ?? runConfig.expectTimeout ?? 10_000 },
    retries: overrides.retries ?? runConfig.retries ?? (isCI ? 1 : 0),

    reporter: [
      ['list'],
      ['junit', { outputFile: 'test-results/junit/results.xml' }],
      ['blob',  { outputDir: 'blob-report' }],
      ['allure-playwright', { outputFolder: 'allure-results' }],
    ],

    use: {
      baseURL,
      headless: overrides.useOptions?.headless ?? runConfig.headless ?? true,
      screenshot: 'only-on-failure',
      video: 'on-first-retry',
      trace: 'on-first-retry',
      actionTimeout: overrides.useOptions?.actionTimeout ?? runConfig.actionTimeout ?? 15_000,
      navigationTimeout: overrides.useOptions?.navigationTimeout ?? runConfig.navigationTimeout ?? 30_000,
      ...overrides.useOptions,
    },

    projects: resolveProjects(overrides.additionalProjects),
    outputDir: 'test-results',
  });
}

/**
 * Utility function to read service account credentials injected by claim-account.sh.
 */
export function getServiceAccountCredentials(): { username: string; password: string } {
  const username = process.env.TEST_USERNAME;
  const password = process.env.TEST_PASSWORD;

  if (!username || !password) {
    throw new Error(
      'TEST_USERNAME or TEST_PASSWORD environment variable is not set.\n' +
      'In pipeline runs, these are injected by claim-account.sh.'
    );
  }

  return { username, password };
}

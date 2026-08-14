#!/usr/bin/env node
/**
 * parse-test-list.js
 *
 * Workspace-Aware Playwright AST Discovery Script for Monorepos
 *
 * How it works:
 * 1. Reads root package.json "workspaces" field to find all app packages under apps/*.
 * 2. Filters to apps containing a playwright.config.ts file.
 * 3. Runs `npx playwright test --config apps/<app>/playwright.config.ts --list --reporter=json` for each app.
 * 4. Extracts Playwright's actual manifest JSON safely ignoring any dotenv or logger output.
 * 5. Evaluates FILTER_TAGS env var using AND/OR tag logic:
 *      - Comma (,) = OR logic (e.g. "@SalesModule, @BillingModule")
 *      - Space ( ) = AND logic (e.g. "@SalesModule @Smoke")
 * 6. Groups matched scenarios by @persona:RoleName tag and emits Azure DevOps personaMatrix output JSON.
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const REPO_ROOT     = process.cwd();
const ROOT_PKG_PATH = path.join(REPO_ROOT, 'package.json');
const FILTER_TAGS   = process.env.FILTER_TAGS || 'all';

if (!fs.existsSync(ROOT_PKG_PATH)) {
  console.error(`##[error] Root package.json not found at: ${ROOT_PKG_PATH}`);
  process.exit(1);
}

const rootPkg       = JSON.parse(fs.readFileSync(ROOT_PKG_PATH, 'utf8'));
const rawWorkspaces = rootPkg.workspaces || [];
const workspacePatterns = Array.isArray(rawWorkspaces) ? rawWorkspaces : (rawWorkspaces.packages || []);

// Resolve workspace directories from package.json patterns
function resolveWorkspaceDirs(root, patterns) {
  const dirs = new Set();
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const base = path.join(root, pattern.slice(0, -2));
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.add(path.join(base, entry.name));
      }
    } else {
      const full = path.join(root, pattern);
      if (fs.existsSync(full)) dirs.add(full);
    }
  }
  return [...dirs];
}

const allWorkspaces = resolveWorkspaceDirs(REPO_ROOT, workspacePatterns);
// Filter workspaces to test apps containing a playwright.config.ts
const testApps = allWorkspaces.filter(dir => fs.existsSync(path.join(dir, 'playwright.config.ts')));

if (testApps.length === 0) {
  console.error('##[error] No test app workspaces found containing a playwright.config.ts file.');
  process.exit(1);
}

console.log(`🔍 Discovered ${testApps.length} test app workspace(s): [${testApps.map(d => path.basename(d)).join(', ')}]`);

/** Finds and returns Playwright's actual test manifest JSON, ignoring any dotenv or log objects */
function extractPlaywrightJson(stdout) {
  let startIdx = 0;
  while ((startIdx = stdout.indexOf('{', startIdx)) !== -1) {
    let endIdx = stdout.lastIndexOf('}');
    while (endIdx > startIdx) {
      const candidate = stdout.slice(startIdx, endIdx + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && (parsed.config || parsed.suites)) {
          return candidate; // Found Playwright's actual test manifest!
        }
      } catch (e) {
        // Not valid JSON in this slice, try next brace
      }
      endIdx = stdout.lastIndexOf('}', endIdx - 1);
    }
    startIdx++;
  }
  throw new Error(`Could not locate Playwright manifest in stdout. Raw output:\n${stdout.slice(0, 300)}...`);
}

// Execute Playwright AST --list --reporter=json per app workspace
const allDiscovered = [];

for (const appDir of testApps) {
  const appName = path.basename(appDir);
  const configPath = path.relative(REPO_ROOT, path.join(appDir, 'playwright.config.ts'));

  console.log(`   Scanning app '${appName}' using config '${configPath}'...`);

  try {
    const rawStdout = execSync(`npx playwright test --config "${configPath}" --list --reporter=json`, {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const cleanJson = extractPlaywrightJson(rawStdout);
    const manifest  = JSON.parse(cleanJson);
    const appTests  = collectTests(manifest.suites || [], appName);
    allDiscovered.push(...appTests);
  } catch (err) {
    console.warn(`⚠️ Warning: Failed to parse test manifest for app '${appName}':`, err.message);
  }
}

// Collect tests from Playwright suite tree recursively
function collectTests(suites, appName, acc = []) {
  for (const suite of suites) {
    if (suite.specs) {
      for (const spec of suite.specs) {
        for (const test of spec.tests || []) {
          acc.push({
            appName,
            title: spec.title,
            file: spec.file,
            tags: spec.tags || test.tags || [],
          });
        }
      }
    }
    if (suite.suites) {
      collectTests(suite.suites, appName, acc);
    }
  }
  return acc;
}

// Parse tag expression into OR groups of AND conditions
function parseTagExpression(rawFilter) {
  if (!rawFilter || !rawFilter.trim() || rawFilter.trim().toLowerCase() === 'all') return [];

  const orParts = rawFilter.split(',').map(p => p.trim()).filter(Boolean);
  return orParts.map(orPart => {
    return orPart
      .split(/\s+/)
      .map(t => t.trim().replace(/^@/, ''))
      .filter(Boolean);
  });
}

const orGroups = parseTagExpression(FILTER_TAGS);
const filterAll = orGroups.length === 0;

function matchesFilter(testTags) {
  if (filterAll) return true;
  const cleanTags = testTags.map(t => t.replace(/^@/, ''));
  
  return orGroups.some(andGroup => 
    andGroup.every(requiredTag => cleanTags.some(t => t.toLowerCase() === requiredTag.toLowerCase()))
  );
}

const matchedTests = [];
const missingPersonaTests = [];

for (const test of allDiscovered) {
  if (!matchesFilter(test.tags)) continue;

  const personaTag = test.tags.map(t => t.replace(/^@/, '')).find(t => /^persona:.+/i.test(t));

  if (!personaTag) {
    missingPersonaTests.push(`  [${test.appName}] ${test.file}: "${test.title}"`);
    continue;
  }

  const personaName = personaTag.replace(/^persona:/i, '').trim();
  matchedTests.push({
    persona: personaName,
    appName: test.appName,
    title: test.title,
    file: test.file,
  });
}

if (missingPersonaTests.length > 0) {
  console.error('\n##[error] The following matched tests are missing a @persona:RoleName tag:');
  missingPersonaTests.forEach(t => console.error(t));
  console.error('\nEvery scenario must include a @persona:RoleName tag (e.g. @persona:SalesManager).');
  process.exit(1);
}

if (matchedTests.length === 0) {
  console.error(`\n##[error] No tests found matching tag expression: "${FILTER_TAGS}"`);
  process.exit(1);
}

// Group strictly by unique Persona name
const uniquePersonas = [...new Set(matchedTests.map(t => t.persona))].sort();

console.log(`\n✅ Matched ${matchedTests.length} test(s) across ${uniquePersonas.length} unique persona bucket(s):\n`);
uniquePersonas.forEach((persona, idx) => {
  const count = matchedTests.filter(t => t.persona === persona).length;
  const apps = [...new Set(matchedTests.filter(t => t.persona === persona).map(t => t.appName))].join(', ');
  console.log(`  [${idx}] @persona:${persona.padEnd(25)} (${count} test(s) in: ${apps})`);
});

// Build Azure DevOps dynamic matrix JSON
const matrixObj = {};
uniquePersonas.forEach(persona => {
  const legKey = `persona__${persona}`.replace(/[^a-zA-Z0-9_]/g, '_');
  matrixObj[legKey] = { PERSONA: persona };
});

const matrixJson = JSON.stringify(matrixObj);

console.log('\n--- Emitting Azure DevOps matrix variable ---');
process.stdout.write(`##vso[task.setvariable variable=personaMatrix;isOutput=true]${matrixJson}\n`);
console.log('✅ personaMatrix emitted successfully.');

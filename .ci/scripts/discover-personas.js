#!/usr/bin/env node
/**
 * discover-personas.js
 *
 * PURE PERSONA BUCKETING (1 Job per Persona across ALL Apps)
 * ─────────────────────────────────────────────────────────
 * Reads the monorepo root package.json "workspaces" field to find all D365 apps.
 * Scans feature files for scenarios matching FILTER_TAGS (OR logic).
 *
 * Groups scenarios STRICTLY BY @persona:XXX tag across all apps:
 *   If @persona:AdminUser exists in apps/address-management AND apps/cashplan,
 *   they are combined into a SINGLE job (Slot 0 -> auto01).
 *
 * Environment variables:
 *   FILTER_TAGS — Comma-separated Cucumber tags (e.g. "@Address,@CashPlan")
 *
 * Output:
 *   personaMatrix — compact JSON emitted to Azure DevOps stdout
 *                   Payload per leg: { "PERSONA": "AdminUser", "SLOT": "0" }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const REPO_ROOT     = process.cwd();
const ROOT_PKG_PATH = path.join(REPO_ROOT, 'package.json');
const FILTER_TAGS   = process.env.FILTER_TAGS || '';

if (!fs.existsSync(ROOT_PKG_PATH)) {
  fail(`Root package.json not found at: ${ROOT_PKG_PATH}`);
}

const rootPkg       = JSON.parse(fs.readFileSync(ROOT_PKG_PATH, 'utf8'));
const rawWorkspaces = rootPkg.workspaces;

if (!rawWorkspaces) {
  fail('No "workspaces" field found in package.json. Add: "workspaces": ["apps/*", "packages/*"]');
}

const workspacePatterns = Array.isArray(rawWorkspaces) ? rawWorkspaces : (rawWorkspaces.packages || []);
const allWorkspaceDirs  = resolveWorkspacePatterns(REPO_ROOT, workspacePatterns);

// Filter workspaces to test apps (must contain playwright.config.ts)
const testApps = allWorkspaceDirs.filter(dir => fs.existsSync(path.join(dir, 'playwright.config.ts')));

if (testApps.length === 0) {
  fail(`No test apps found with a playwright.config.ts file in workspaces.`);
}

// Parse filter tags (OR logic)
const filterTags = FILTER_TAGS
  .split(',')
  .map(t => t.trim().replace(/^@/, ''))
  .filter(Boolean);

const filterAll = filterTags.length === 0;

// Scan all feature files across all test apps
const allMatched              = []; // { persona, appName, appRelPath, title }
const missingPersonaScenarios = [];
let   totalFeatureFiles       = 0;

for (const appDir of testApps) {
  const appName     = path.basename(appDir);
  const appRelPath  = path.relative(REPO_ROOT, appDir);
  const featuresDir = path.join(appDir, 'tests', 'features');

  if (!fs.existsSync(featuresDir)) continue;

  const featureFiles = findFiles(featuresDir, '.feature');
  totalFeatureFiles += featureFiles.length;

  for (const filePath of featureFiles) {
    const scenarios = parseFeatureFile(fs.readFileSync(filePath, 'utf8'), filePath);

    for (const scenario of scenarios) {
      const matchesFilter = filterAll || filterTags.some(ft => scenario.tags.includes(ft));
      if (!matchesFilter) continue;

      const personaTag = scenario.tags.find(t => /^persona:.+/.test(t));

      if (!personaTag) {
        missingPersonaScenarios.push(
          `  [${appName}] ${path.relative(REPO_ROOT, filePath)}:${scenario.line}  "${scenario.title}"`
        );
        continue;
      }

      allMatched.push({
        persona: personaTag.replace('persona:', '').trim(),
        appName,
        appRelPath,
        title: scenario.title,
      });
    }
  }
}

// Validation: Ensure all matched scenarios have a @persona tag
if (missingPersonaScenarios.length > 0) {
  console.error('\n##[error]The following matched scenarios are missing a @persona:XXX tag:');
  missingPersonaScenarios.forEach(s => console.error(s));
  console.error('\nPlease add a @persona:XXX tag to these scenarios before running the pipeline.');
  process.exit(1);
}

if (allMatched.length === 0) {
  fail(`No scenarios found matching tags "${FILTER_TAGS}" across ${testApps.length} test app(s).`);
}

// ─── Group STRICTLY by unique Persona ─────────────────────────────────────────

const uniquePersonas = [...new Set(allMatched.map(s => s.persona))].sort();

console.log(`\n✅ Found ${allMatched.length} matching scenario(s) across ${uniquePersonas.length} unique persona bucket(s):\n`);

console.log(`  ${'SLOT'.padEnd(6)} ${'PERSONA'.padEnd(30)} ${'APPS INVOLVED'}`);
console.log(`  ${'─'.repeat(6)} ${'─'.repeat(30)} ${'─'.repeat(35)}`);

uniquePersonas.forEach((persona, slot) => {
  const personaScenarios = allMatched.filter(s => s.persona === persona);
  const appsInvolved     = [...new Set(personaScenarios.map(s => s.appName))].join(', ');
  console.log(`  [${String(slot).padEnd(4)}] @persona:${persona.padEnd(21)} (${personaScenarios.length} test(s) in: ${appsInvolved})`);
});

// ─── Build compact single-line matrix JSON for Azure DevOps ──────────────────

const matrixParts = uniquePersonas.map((persona, slot) => {
  const legKey = `persona__${persona}`.replace(/[^a-zA-Z0-9_]/g, '_');
  return `"${legKey}":{"PERSONA":"${persona}","SLOT":"${slot}"}`;
});

const matrixJson = '{' + matrixParts.join(',') + '}';

console.log('\n--- Emitting Azure DevOps pipeline variable ---');
process.stdout.write(`##vso[task.setvariable variable=personaMatrix;isOutput=true]${matrixJson}\n`);
console.log('✅ personaMatrix set successfully.');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveWorkspacePatterns(root, patterns) {
  const resolved = new Set();
  for (const pattern of patterns) {
    if (pattern.startsWith('_')) continue;
    if (pattern.endsWith('/*')) {
      const basePath = path.join(root, pattern.slice(0, -2));
      if (!fs.existsSync(basePath)) continue;
      for (const entry of fs.readdirSync(basePath, { withFileTypes: true })) {
        if (entry.isDirectory()) resolved.add(path.join(basePath, entry.name));
      }
    } else {
      const fullPath = path.join(root, pattern);
      if (fs.existsSync(fullPath)) resolved.add(fullPath);
    }
  }
  return [...resolved];
}

function findFiles(dir, ext) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findFiles(full, ext));
    else if (entry.name.endsWith(ext)) results.push(full);
  }
  return results;
}

function parseFeatureFile(content, filePath) {
  const lines     = content.split(/\r?\n/);
  const scenarios = [];
  let featureTags = [];
  let pendingTags = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('@')) {
      const tags = line.match(/@[\w:./-]+/g) || [];
      pendingTags.push(...tags.map(t => t.slice(1)));
      continue;
    }

    if (/^Feature\s*:/i.test(line)) {
      featureTags = [...pendingTags];
      pendingTags = [];
      continue;
    }

    if (/^Background\s*:/i.test(line)) {
      pendingTags = [];
      continue;
    }

    if (/^Scenario(\s+Outline)?\s*:/i.test(line)) {
      scenarios.push({
        title: line.replace(/^Scenario(\s+Outline)?\s*:\s*/i, '').trim(),
        tags:  [...featureTags, ...pendingTags],
        line:  i + 1,
      });
      pendingTags = [];
      continue;
    }

    pendingTags = [];
  }
  return scenarios;
}

function fail(msg) {
  console.error(`\n##[error]${msg}`);
  process.exit(1);
}

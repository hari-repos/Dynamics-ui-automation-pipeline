#!/usr/bin/env node
/**
 * cleanup-stale-locks.js
 *
 * Runs in Stage 1 of new pipeline builds.
 * Queries Azure DevOps REST API for all active/running Build IDs.
 * Inspects Git lock branches (refs/heads/locks/env-*-autoXX-build-12345).
 * Safely deletes lock branches belonging to completed or cancelled builds only.
 * Ongoing/active builds are NEVER touched.
 */

'use strict';

const { execSync } = require('child_process');
const https        = require('https');
const http         = require('http');

const collectionUri = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
const project       = process.env.SYSTEM_TEAMPROJECT;
const token         = process.env.SYSTEM_ACCESSTOKEN;

console.log('============================================================');
console.log(' 🧹 Safe Stale Lock Cleanup Initialization');
console.log('============================================================');

if (!collectionUri || !project || !token) {
  console.log('⚠️  System collection URI, project, or token not provided. Skipping active build API check.');
  process.exit(0);
}

// 1. Fetch remote lock branches via git
try {
  execSync('git fetch origin --prune', { stdio: 'pipe' });
} catch (e) {
  console.log('⚠️  git fetch failed. Skipping stale lock cleanup.');
  process.exit(0);
}

let remoteBranches = [];
try {
  const output = execSync('git branch -r', { encoding: 'utf8' });
  remoteBranches = output
    .split('\n')
    .map(b => b.trim())
    .filter(b => b.includes('origin/locks/'));
} catch (e) {
  console.log('No lock branches found.');
  process.exit(0);
}

if (remoteBranches.length === 0) {
  console.log('✅ No existing lock branches found in repository.');
  process.exit(0);
}

console.log(`Found ${remoteBranches.length} remote lock branch(es) to inspect.`);

// 2. Query Azure DevOps REST API for in-progress Build IDs
const apiUrl = `${collectionUri.replace(/\/$/, '')}/${encodeURIComponent(project)}/_apis/build/builds?statusFilter=inProgress&api-version=7.0`;

getJson(apiUrl, token)
  .then(res => {
    const activeBuilds = (res.value || []).map(b => String(b.id));
    console.log(`Active / Running Build IDs in Azure DevOps: [${activeBuilds.join(', ')}]`);

    let cleaned = 0;

    for (const remoteBranch of remoteBranches) {
      // Branch format: origin/locks/env-dev-auto01-build-12345
      const match = remoteBranch.match(/locks\/.*-build-(\d+)$/);
      if (!match) continue;

      const buildId = match[1];

      if (activeBuilds.includes(buildId)) {
        console.log(` 🔒 Branch '${remoteBranch}' belongs to active Build #${buildId} -> KEEPING INTACT.`);
      } else {
        const branchName = remoteBranch.replace('origin/', '');
        console.log(` 🧹 Branch '${remoteBranch}' belongs to finished/cancelled Build #${buildId} -> DELETING...`);
        try {
          execSync(`git push origin --delete ${branchName}`, { stdio: 'pipe' });
          cleaned++;
        } catch (err) {
          console.error(`Failed to delete branch ${branchName}:`, err.message);
        }
      }
    }

    console.log(`✅ Stale lock cleanup complete. Deleted ${cleaned} orphaned lock branch(es).`);
  })
  .catch(err => {
    console.warn('⚠️ Could not query Azure DevOps Build API. Skipping automatic cleanup:', err.message);
  });

function getJson(urlStr, bearerToken) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const client = urlObj.protocol === 'https:' ? https : http;
    const req = client.get(urlObj, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Accept': 'application/json',
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`API returned status ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
  });
}

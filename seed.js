#!/usr/bin/env node
/**
 * Seed tool_versions from the storefront catalog/community.yaml.
 *
 * Usage:
 *   node seed.js
 *
 * Reads the multi-doc YAML, extracts spec.versions[] from each CommunityTool,
 * and POSTs each version row to the OCTools Stats API.
 */

const fs = require('fs');
const yaml = require('js-yaml');

const API = process.env.OCTOOLS_API || 'https://api.octools.net';
const TOKEN = process.env.ADMIN_TOKEN || 'oct-admin-2026-seed';
const CATALOG_PATH = process.env.CATALOG_PATH || '/home/cjanisze/Projects/oct-storefront/catalog/community.yaml';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log(`Reading catalog from: ${CATALOG_PATH}`);
  const raw = fs.readFileSync(CATALOG_PATH, 'utf-8');

  const docs = yaml.loadAll(raw);
  let total = 0;
  let success = 0;
  let failed = 0;

  for (const doc of docs) {
    if (!doc || doc.kind !== 'CommunityTool') continue;

    const toolId = doc.metadata?.name;
    const versions = doc.spec?.versions || [];

    if (!toolId || versions.length === 0) {
      console.log(`  Skipping ${toolId || '(unnamed)'}: no versions`);
      continue;
    }

    console.log(`\nTool: ${toolId} (${versions.length} version rows)`);

    for (const v of versions) {
      total++;
      const payload = {
        toolId,
        version: v.version,
        channel: v.channel || 'stable',
        openshift: Array.isArray(v.openshift) ? v.openshift[0] : v.openshift,
        image: v.image,
        gitRef: v.gitRef || null,
        deployUrl: v.deployUrl || null,
      };

      // Throttle to avoid rate limiting (20 req/min)
      if (total > 1) await sleep(200);

      try {
        const res = await fetch(`${API}/v1/versions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${TOKEN}`,
          },
          body: JSON.stringify(payload),
        });

        const body = await res.json();
        if (res.ok) {
          success++;
          console.log(`  ✓ ${payload.version} ocp${payload.openshift}`);
        } else {
          failed++;
          console.error(`  ✗ ${payload.version} ocp${payload.openshift}: ${body.error || res.statusText}`);
        }
      } catch (err) {
        failed++;
        console.error(`  ✗ ${payload.version} ocp${payload.openshift}: ${err.message}`);
      }
    }
  }

  console.log(`\nDone. Total: ${total}, Success: ${success}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

#!/usr/bin/env node
/**
 * Seed tool_versions from the storefront catalog/community.yaml.
 *
 * Usage:
 *   ADMIN_TOKEN=... CATALOG_PATH=<storefront>/catalog/community.yaml node seed.js
 *   TOOL=oct-my-tool node seed.js     # only that tool's rows (one release)
 *   DRY_RUN=1 node seed.js            # print the rows, write nothing
 *
 * Reads the multi-doc YAML, extracts spec.versions[] from each CommunityTool,
 * and POSTs each version row to the OCTools Stats API.
 */

const fs = require('fs');
const yaml = require('js-yaml');

const API = process.env.OCTOOLS_API || 'https://api.octools.net';
const TOKEN = process.env.ADMIN_TOKEN || 'oct-admin-2026-seed';
const CATALOG_PATH = process.env.CATALOG_PATH || '/home/cjanisze/Projects/oct-storefront/catalog/community.yaml';

const ONLY_TOOL = process.env.TOOL || '';
const DRY_RUN = !!process.env.DRY_RUN;

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
    const category = doc.spec?.category || null;
    const description = doc.spec?.description || null;
    const displayName = doc.spec?.displayName || null;
    const href = doc.spec?.href || null;
    const icon = doc.spec?.icon || null;
    const git = doc.spec?.git || null;

    if (ONLY_TOOL && toolId !== ONLY_TOOL) continue;
    if (!toolId || versions.length === 0) {
      console.log(`  Skipping ${toolId || '(unnamed)'}: no versions`);
      continue;
    }

    console.log(`\nTool: ${toolId} (${versions.length} version rows, category: ${category || 'none'})`);

    // The API stores one row per OpenShift minor (openshift is a string), so a
    // catalog row listing several minors fans out into several rows.
    const rows = versions.flatMap(v => (Array.isArray(v.openshift) ? v.openshift : [v.openshift]).map(o => ({ ...v, openshift: o })));

    for (const v of rows) {
      total++;
      const payload = {
        toolId,
        version: v.version,
        channel: v.channel || 'stable',
        openshift: String(v.openshift),
        image: v.image,
        gitRef: v.gitRef || null,
        deployUrl: v.deployUrl || null,
        category,
        description,
        displayName,
        href,
        icon,
        git,
      };

      if (DRY_RUN) {
        console.log(`  (dry run) ${JSON.stringify({ toolId, version: payload.version, openshift: payload.openshift, image: payload.image, gitRef: payload.gitRef })}`);
        continue;
      }

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

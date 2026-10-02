#!/usr/bin/env node
// Validates version.json, the update manifest every shipped app reads (backlog E1).
//
//   node scripts/validate-manifest.mjs [path] [--check-urls]
//
// Exit code 1 on any error. Warnings print but do not fail. No dependencies, so CI needs nothing
// beyond Node. The rules come from the version contract spec, section 3.7 Rule 3.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+$/;
const DESKTOP_PLATFORMS = ['windows', 'macos', 'linux'];

/** Shape of every platform entry: required keys and which one holds the store link. */
const ENTRIES = [
  { path: ['android_client'], urlKey: 'store_url' },
  ...DESKTOP_PLATFORMS.map((os) => ({ path: ['desktop', os], urlKey: 'update_url' })),
];

export function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Checks the manifest's structure and version ordering. Pure, so it is unit-tested directly.
 * @returns {{errors: string[], warnings: string[], urls: string[]}}
 */
export function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  const urls = [];

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { errors: ['the manifest must be a JSON object'], warnings, urls };
  }

  for (const { path, urlKey } of ENTRIES) {
    const name = path.join('.');
    const entry = path.reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), manifest);
    if (entry === undefined) {
      errors.push(`${name} is missing`);
      continue;
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${name} must be an object`);
      continue;
    }

    const versions = {};
    for (const key of ['latest_version', 'critical_below_version']) {
      const value = entry[key];
      if (typeof value !== 'string') {
        errors.push(`${name}.${key} is missing or not a string`);
      } else if (!SEMVER.test(value)) {
        errors.push(`${name}.${key} "${value}" is not a version of the form X.Y.Z`);
      } else {
        versions[key] = value;
      }
    }

    const url = entry[urlKey];
    if (typeof url !== 'string' || !/^https:\/\/\S+$/.test(url)) {
      errors.push(`${name}.${urlKey} must be an https:// URL`);
    } else {
      urls.push(url);
    }

    const { latest_version: latest, critical_below_version: critical } = versions;
    if (latest && critical) {
      const order = compareSemver(critical, latest);
      if (order > 0) {
        errors.push(
          `${name}: critical_below_version ${critical} is above latest_version ${latest} — ` +
            'every user would be told to install a version that does not exist'
        );
      } else if (order === 0) {
        // The September 2026 lockout: equal values make the dismissible branch unreachable, so
        // everyone not on exactly the latest version gets the blocking dialog.
        warnings.push(
          `${name}: critical_below_version equals latest_version (${latest}) — EVERY user not on ` +
            'exactly this version gets the blocking update dialog. Intended only for an emergency.'
        );
      }
    }
  }

  return { errors, warnings, urls };
}

/** HEAD each URL (falling back to GET, which some stores require); 4xx/5xx or no answer fails. */
export async function checkUrls(urls, fetchImpl = fetch) {
  const errors = [];
  for (const url of [...new Set(urls)]) {
    try {
      let response = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
      if (response.status === 405 || response.status === 403) {
        response = await fetchImpl(url, { method: 'GET', redirect: 'follow' });
      }
      if (response.status >= 400) errors.push(`${url} answered HTTP ${response.status}`);
    } catch (error) {
      errors.push(`${url} could not be reached: ${error.message}`);
    }
  }
  return errors;
}

async function main(argv) {
  const checkUrlsFlag = argv.includes('--check-urls');
  const path = argv.find((arg) => !arg.startsWith('--')) ?? 'version.json';

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    console.error(`ERROR: ${path} is not readable JSON: ${error.message}`);
    return 1;
  }

  const { errors, warnings, urls } = validateManifest(manifest);
  if (checkUrlsFlag) errors.push(...(await checkUrls(urls)));

  for (const warning of warnings) console.warn(`WARNING: ${warning}`);
  for (const error of errors) console.error(`ERROR: ${error}`);
  if (errors.length === 0) console.log(`${path} is valid${warnings.length ? ' (with warnings)' : ''}.`);
  return errors.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}

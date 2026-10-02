// node --test scripts/validate-manifest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkUrls, compareSemver, validateManifest } from './validate-manifest.mjs';

/** A valid manifest; each test breaks one thing. */
function manifest() {
  return {
    desktop: {
      windows: { latest_version: '2.1.2', critical_below_version: '2.1.0', update_url: 'https://apps.microsoft.com/detail/9P2Z8FNQ4NL6' },
      macos: { latest_version: '2.1.0', critical_below_version: '2.0.2', update_url: 'https://www.pcremotecontroller.com/#cta' },
      linux: { latest_version: '2.1.0', critical_below_version: '2.0.2', update_url: 'https://www.pcremotecontroller.com/#cta' },
    },
    android_client: {
      latest_version: '2.0.4',
      critical_below_version: '2.0.0',
      store_url: 'https://play.google.com/store/apps/details?id=com.aslanov.chloros.remotecontroller',
    },
  };
}

test('a correct manifest passes without warnings', () => {
  assert.deepEqual(validateManifest(manifest()), {
    errors: [],
    warnings: [],
    urls: [
      'https://play.google.com/store/apps/details?id=com.aslanov.chloros.remotecontroller',
      'https://apps.microsoft.com/detail/9P2Z8FNQ4NL6',
      'https://www.pcremotecontroller.com/#cta',
      'https://www.pcremotecontroller.com/#cta',
    ],
  });
});

test('the committed version.json passes', async () => {
  const committed = JSON.parse(await readFile(new URL('../version.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateManifest(committed).errors, []);
});

test('the September 2026 lockout manifest is flagged loudly', () => {
  // The exact values that bricked the app: latest == critical == 2.0.3.
  const m = manifest();
  m.android_client.latest_version = '2.0.3';
  m.android_client.critical_below_version = '2.0.3';
  const { errors, warnings } = validateManifest(m);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /android_client: critical_below_version equals latest_version \(2\.0\.3\)/);
  assert.match(warnings[0], /EVERY user/);
});

test('critical above latest is an error', () => {
  const m = manifest();
  m.desktop.windows.critical_below_version = '2.2.0';
  assert.match(validateManifest(m).errors.join('\n'), /desktop\.windows: critical_below_version 2\.2\.0 is above latest_version 2\.1\.2/);
});

test('ordering is numeric, not alphabetical', () => {
  const m = manifest();
  m.android_client.latest_version = '2.10.0';
  m.android_client.critical_below_version = '2.9.0';
  assert.deepEqual(validateManifest(m).errors, []);
  assert.equal(compareSemver('2.10.0', '2.9.0'), 1);
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.2.3', '1.3.0'), -1);
});

for (const bad of ['2.1', 'v2.1.0', '2.1.0-beta', '2.1.0 ', '', 'latest']) {
  test(`version ${JSON.stringify(bad)} is rejected`, () => {
    const m = manifest();
    m.android_client.latest_version = bad;
    assert.match(validateManifest(m).errors.join('\n'), /android_client\.latest_version .* is not a version of the form X\.Y\.Z/);
  });
}

test('a version that is not a string is rejected', () => {
  const m = manifest();
  m.android_client.critical_below_version = 200;
  assert.match(validateManifest(m).errors.join('\n'), /android_client\.critical_below_version is missing or not a string/);
});

for (const [path, label] of [
  [['android_client'], 'android_client'],
  [['desktop', 'windows'], 'desktop.windows'],
  [['desktop', 'macos'], 'desktop.macos'],
  [['desktop', 'linux'], 'desktop.linux'],
]) {
  test(`a missing ${label} is an error`, () => {
    const m = manifest();
    const parent = path.length === 1 ? m : m[path[0]];
    delete parent[path[path.length - 1]];
    assert.ok(validateManifest(m).errors.includes(`${label} is missing`));
  });
}

test('a missing desktop block reports every platform', () => {
  const m = manifest();
  delete m.desktop;
  const { errors } = validateManifest(m);
  for (const os of ['windows', 'macos', 'linux']) assert.ok(errors.includes(`desktop.${os} is missing`));
});

for (const [entry, key] of [
  ['android_client', 'latest_version'],
  ['android_client', 'critical_below_version'],
  ['android_client', 'store_url'],
]) {
  test(`android_client without ${key} is an error`, () => {
    const m = manifest();
    delete m[entry][key];
    assert.ok(validateManifest(m).errors.length > 0);
  });
}

test('the desktop uses update_url and Android uses store_url — not interchangeable', () => {
  // Each client reads exactly one key name; the wrong one would silently disable the update link.
  const m = manifest();
  m.android_client.update_url = m.android_client.store_url;
  delete m.android_client.store_url;
  assert.match(validateManifest(m).errors.join('\n'), /android_client\.store_url must be an https:\/\/ URL/);
});

for (const url of ['http://play.google.com/x', 'play.google.com', 'https://', 'https://has space']) {
  test(`url ${JSON.stringify(url)} is rejected`, () => {
    const m = manifest();
    m.desktop.windows.update_url = url;
    assert.match(validateManifest(m).errors.join('\n'), /desktop\.windows\.update_url must be an https:\/\/ URL/);
  });
}

for (const value of [null, [], 'text', 3]) {
  test(`a manifest of ${JSON.stringify(value)} is rejected`, () => {
    assert.deepEqual(validateManifest(value).errors, ['the manifest must be a JSON object']);
  });
}

test('unknown extra keys are allowed (old clients ignore them; future fields need this)', () => {
  const m = manifest();
  m.android_client.release_notes = 'whatever';
  m.extra_top_level = true;
  assert.deepEqual(validateManifest(m).errors, []);
});

// --- URL checks, with a fake fetch so the tests never touch the network ---

function fakeFetch(statuses) {
  const calls = [];
  const impl = async (url, { method }) => {
    calls.push(`${method} ${url}`);
    const status = statuses[`${method} ${url}`] ?? statuses[url];
    if (status instanceof Error) throw status;
    return { status };
  };
  return { impl, calls };
}

test('reachable URLs pass, each checked once', async () => {
  const { impl, calls } = fakeFetch({ 'https://a': 200, 'https://b': 301 });
  assert.deepEqual(await checkUrls(['https://a', 'https://b', 'https://a'], impl), []);
  assert.deepEqual(calls, ['HEAD https://a', 'HEAD https://b']);
});

test('a 404 or a network failure fails', async () => {
  const { impl } = fakeFetch({ 'https://gone': 404, 'https://down': new Error('ENOTFOUND') });
  assert.deepEqual(await checkUrls(['https://gone', 'https://down'], impl), [
    'https://gone answered HTTP 404',
    'https://down could not be reached: ENOTFOUND',
  ]);
});

test('a store that refuses HEAD is retried with GET', async () => {
  const { impl, calls } = fakeFetch({ 'HEAD https://store': 405, 'GET https://store': 200 });
  assert.deepEqual(await checkUrls(['https://store'], impl), []);
  assert.deepEqual(calls, ['HEAD https://store', 'GET https://store']);
});

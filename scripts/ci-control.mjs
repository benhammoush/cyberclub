/**
 * Run fixed repository-owned CI operations without executing candidate delivery code.
 * @file
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifact, deliveryRecord } from './ci-artifact.mjs';

/**
 * Validate this static application's bounded public CI configuration.
 * @param config - Parsed repository configuration.
 * @returns Validated configuration.
 */
export function configuration(config) {
  assert.deepEqual(
    Object.keys(config).sort(),
    [
      'schemaVersion',
      'profile',
      'nodeVersion',
      'integration',
      'legacyChecks',
      'deploymentVariables',
      'buildEnvironment',
    ].sort(),
  );
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.profile, 'web');
  assert.equal(config.nodeVersion, '24.21.0');
  assert.equal(config.integration, false);
  assert.deepEqual(config.legacyChecks, []);
  assert.deepEqual(config.deploymentVariables, [
    'VERCEL_TEAM_ID',
    'VERCEL_DEV_PROJECT_ID',
    'VERCEL_PRODUCTION_PROJECT_ID',
  ]);
  // This showcase has no public environment-specific build inputs.
  assert.deepEqual(config.buildEnvironment, { dev: {}, production: {} });
  return config;
}

/**
 * Validate control inputs or deploy already-tested bytes through trusted control code.
 * @param command - Fixed validate or deploy operation.
 */
export function control(command) {
  const config = configuration(
    JSON.parse(readFileSync('control/.github/ci-cd.json', 'utf8')),
  );
  if (command === 'validate') return;
  assert.equal(command, 'deploy');
  assert.ok(
    process.env.VERCEL_TOKEN?.trim(),
    'Missing environment credential VERCEL_TOKEN',
  );
  artifact('verify');
  const variables = JSON.parse(process.env.CI_CONFIGURATION);
  const env = { ...process.env };
  for (const name of config.deploymentVariables) {
    assert.equal(typeof variables[name], 'string', `Missing ${name}`);
    assert.ok(variables[name].length > 0, `Missing ${name}`);
    env[name] = variables[name];
  }
  try {
    execFileSync(process.execPath, [resolve('control/scripts/ci-deploy.mjs')], {
      cwd: 'candidate',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 900_000,
    });
  } catch {
    throw new Error(
      'Delivery stopped; inspect retained evidence and provider state before a fresh authorized dispatch',
    );
  }
  deliveryRecord(
    JSON.parse(readFileSync('candidate/delivery-record.json', 'utf8')),
    env.CI_SOURCE_SHA,
    env.CI_ENVIRONMENT,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  control(process.argv[2]);

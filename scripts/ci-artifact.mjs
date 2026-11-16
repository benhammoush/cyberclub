/**
 * Bind tested regular-file artifacts and delivery records to exact identities.
 * @file
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SHA, DIGEST } from './ci-source.mjs';

/**
 * Hash exact bytes, sizes and paths in a bounded regular-file tree.
 * @param root - Built output directory.
 * @returns Deterministic SHA-256 digest.
 */
export function digest(root) {
  const hash = createHash('sha256');
  let total = 0;
  /**
   * Traverse sorted paths without following symbolic links.
   * @param directory - Current directory.
   * @param prefix - Relative path prefix.
   */
  function walk(directory, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      assert.ok(!info.isSymbolicLink(), 'Artifact symlinks are forbidden');
      if (info.isDirectory()) walk(path, `${prefix}${name}/`);
      else {
        assert.ok(info.isFile());
        total += info.size;
        assert.ok(total <= 500_000_000, 'Artifact exceeds transport bound');
        hash.update(`${prefix}${name}\0${info.size}\0`);
        hash.update(readFileSync(path));
      }
    }
  }
  walk(root);
  assert.ok(total > 0, 'Build output is empty');
  return hash.digest('hex');
}

/**
 * Validate retained delivery evidence; smoke success is not human acceptance.
 * @param record - Parsed delivery record.
 * @param sha - Exact requested source SHA.
 * @param environment - Required delivery environment.
 * @returns The validated record.
 */
export function deliveryRecord(record, sha, environment) {
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.sourceSha, sha);
  assert.match(record.sourceSha, SHA);
  assert.equal(record.environment, environment);
  assert.match(record.artifactDigest, DIGEST);
  assert.match(record.configurationDigest, DIGEST);
  assert.match(String(record.workflowRunId), /^\d+$/);
  assert.equal(typeof record.deploymentId, 'string');
  assert.ok(record.deploymentId.length > 0);
  assert.ok(
    record.previousDeploymentId === null ||
      (typeof record.previousDeploymentId === 'string' &&
        record.previousDeploymentId.length > 0),
  );
  assert.equal(record.status, 'smoke-verified-not-user-accepted');
  return record;
}

/**
 * Prepare or verify an exact tested-artifact manifest.
 * @param mode - Prepare after tests, or verify before delivery.
 * @param env - Selected source and environment.
 * @returns Artifact identity manifest.
 */
export function artifact(mode, env = process.env) {
  assert.match(env.CI_SOURCE_SHA ?? '', SHA);
  assert.ok(['dev', 'production'].includes(env.CI_ENVIRONMENT));
  if (mode === 'prepare') {
    assert.equal(
      execFileSync('git', ['-C', 'candidate', 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      env.CI_SOURCE_SHA,
    );
    assert.equal(
      execFileSync(
        'git',
        ['-C', 'candidate', 'status', '--porcelain', '--untracked-files=no'],
        { encoding: 'utf8' },
      ).trim(),
      '',
      'Tracked source changed during checks',
    );
  } else assert.equal(mode, 'verify');
  const current = {
    schemaVersion: 1,
    sourceSha: env.CI_SOURCE_SHA,
    environment: env.CI_ENVIRONMENT,
    artifactDigest: digest('candidate/dist'),
  };
  if (mode === 'prepare')
    writeFileSync('candidate/ci-build.json', `${JSON.stringify(current)}\n`);
  else
    assert.deepEqual(
      JSON.parse(readFileSync('candidate/ci-build.json', 'utf8')),
      current,
    );
  return current;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  artifact(process.argv[2]);

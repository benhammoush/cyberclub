/**
 * Reject unsafe release contexts before candidate code or delivery credentials.
 * @file
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SHA = /^[a-f0-9]{40}$/;
export const DIGEST = /^[a-f0-9]{64}$/;

/**
 * Validate event, repository and target independently of Git history.
 * @param env - Runner context, without provider credentials.
 */
export function releaseContext(env) {
  assert.equal(env.GITHUB_REPOSITORY, 'benhammoush/cyberclub');
  assert.ok(['dev', 'production'].includes(env.CI_ENVIRONMENT));
  assert.match(env.CI_SOURCE_SHA ?? '', SHA);
  assert.ok(
    ['push', 'pull_request', 'workflow_dispatch'].includes(
      env.GITHUB_EVENT_NAME,
    ),
  );
  if (env.GITHUB_EVENT_NAME !== 'pull_request')
    assert.equal(env.GITHUB_REF, 'refs/heads/main');
  if (env.CI_ENVIRONMENT === 'production') {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    assert.equal(
      env.GITHUB_RUN_ATTEMPT,
      '1',
      'Use a fresh production dispatch after inspecting failures',
    );
    assert.equal(
      env.GITHUB_WORKFLOW_REF,
      `${env.GITHUB_REPOSITORY}/.github/workflows/verify-and-deploy-prod.yml@refs/heads/main`,
    );
  }
}

/**
 * Require trusted-main ancestry and reject superseded automatic dev sources.
 * @param env - Runner context and selected source identity.
 */
export function source(env = process.env) {
  releaseContext(env);
  if (env.GITHUB_EVENT_NAME !== 'pull_request') {
    execFileSync(
      'git',
      [
        '-C',
        'control',
        'merge-base',
        '--is-ancestor',
        env.CI_SOURCE_SHA,
        'origin/main',
      ],
      { stdio: 'pipe' },
    );
    if (env.GITHUB_EVENT_NAME === 'push') {
      const main = execFileSync(
        'git',
        ['-C', 'control', 'rev-parse', 'origin/main'],
        { encoding: 'utf8' },
      ).trim();
      assert.equal(
        env.CI_SOURCE_SHA,
        main,
        'Automatic dev source was superseded',
      );
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  source();

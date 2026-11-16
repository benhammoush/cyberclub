/**
 * Exercise local release guards and reject unsafe workflow/evidence mutations.
 * @file
 */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  artifact,
  digest,
  deliveryRecord,
} from '../../scripts/ci-artifact.mjs';
import { configuration } from '../../scripts/ci-control.mjs';
import { devEvidence } from '../../scripts/ci-dev-evidence.mjs';
import { releaseContext } from '../../scripts/ci-source.mjs';
import {
  browserHost,
  ubuntuMirror,
  aptNetworkPolicy,
} from '../../scripts/ci-browser-host.mjs';
import {
  readWorkflows,
  workflow,
  workflowContract,
} from '../../scripts/ci-workflows.mjs';

const sha = 'a'.repeat(40);
const repository = 'benhammoush/cyberclub';

/**
 * Create representative successful same-repository dev evidence.
 * @returns Isolated runner, run and record fixtures.
 */
function evidenceFixture() {
  return {
    env: {
      CI_SOURCE_SHA: sha,
      GITHUB_REPOSITORY: repository,
      GH_TOKEN: 'fixture-token',
    },
    run: {
      id: 123,
      conclusion: 'success',
      head_branch: 'main',
      path: '.github/workflows/verify-and-deploy-dev.yml',
      event: 'push',
      head_repository: { full_name: repository },
    },
    record: {
      schemaVersion: 1,
      sourceSha: sha,
      environment: 'dev',
      artifactDigest: 'b'.repeat(64),
      configurationDigest: 'c'.repeat(64),
      workflowRunId: '123',
      deploymentId: 'dpl_test',
      previousDeploymentId: null,
      status: 'smoke-verified-not-user-accepted',
    },
  };
}

test('repository-owned workflows preserve the complete trust and delivery contract', () => {
  assert.doesNotThrow(() => workflowContract(readWorkflows()));
  assert.throws(() => workflow('jobs: {}\njobs: {}'));
  assert.throws(() => workflow('a: &a {}\njobs: *a'));
});

test('workflow mutations cannot remove checks, gates, evidence or local ownership', () => {
  const documents = readWorkflows();
  for (const mutate of [
    (docs) => {
      docs['verify-pr.yml'].on = { pull_request_target: null };
    },
    (docs) => {
      docs['verify-pr.yml'].jobs.verify.environment = 'production';
    },
    (docs) => {
      docs['verify-pr.yml'].jobs.verify_result.if = 'success()';
    },
    (docs) => {
      docs['verify-and-deploy-dev.yml'].jobs.verify.uses =
        'someone/shared@main';
    },
    (docs) => {
      docs['verify-and-deploy-prod.yml'].jobs.deploy_production.needs = [];
    },
    (docs) => {
      delete docs['deploy.yml'].jobs.deploy.environment;
    },
    (docs) => {
      docs['deploy.yml'].jobs.deploy.concurrency['cancel-in-progress'] = true;
    },
    (docs) => {
      docs['deploy.yml'].jobs.deploy.steps[0].with.ref =
        '${{ inputs.source_sha }}';
    },
    (docs) => {
      docs['deploy.yml'].jobs.deploy.steps[0].with.repository =
        'someone/automation';
    },
    (docs) => {
      docs['deploy.yml'].jobs.deploy.steps.splice(4, 1);
    },
    (docs) => {
      docs['deploy.yml'].jobs.deploy.steps.at(-1).if = 'success()';
    },
    (docs) => {
      const download = docs['deploy.yml'].jobs.deploy.steps.find((step) =>
        step.uses?.startsWith('actions/download-artifact@'),
      );
      download.with['run-id'] = 456;
    },
    (docs) => {
      docs['verify.yml'].jobs.verify.steps[0].uses = 'actions/checkout@main';
    },
    (docs) => {
      const job = docs['verify.yml'].jobs.verify;
      job.steps = job.steps.filter((step) => step.run !== 'npm run ci:browser');
    },
    (docs) => {
      docs['weekly-vuln-audit.yml'].jobs.audit.steps.at(-1).if = 'success()';
    },
  ]) {
    const invalid = structuredClone(documents);
    mutate(invalid);
    assert.throws(() => workflowContract(invalid));
  }
});

test('configuration rejects shared coupling, unknown variables and public secret inputs', () => {
  const config = JSON.parse(readFileSync('.github/ci-cd.json', 'utf8'));
  assert.equal(configuration(config), config);
  for (const change of [
    { automationSha: sha },
    { profile: 'worker' },
    { nodeVersion: 'latest' },
    { deploymentVariables: ['PATH'] },
    { integration: true },
    { buildEnvironment: { dev: { VITE_TOKEN: 'secret' }, production: {} } },
  ])
    assert.throws(() => configuration({ ...config, ...change }));
});

test('release context rejects old repositories, invalid sources and unsafe production events', () => {
  const env = {
    GITHUB_REPOSITORY: repository,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    CI_ENVIRONMENT: 'production',
    CI_SOURCE_SHA: sha,
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/verify-and-deploy-prod.yml@refs/heads/main`,
  };
  assert.doesNotThrow(() => releaseContext(env));
  for (const change of [
    { GITHUB_REPOSITORY: 'benhammoush/dripperz' },
    { CI_SOURCE_SHA: 'main' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_WORKFLOW_REF: 'untrusted' },
    { CI_ENVIRONMENT: 'staging' },
  ])
    assert.throws(() => releaseContext({ ...env, ...change }));
});

test('production needs exact-source successful same-repository unexpired dev evidence', async () => {
  const fixture = evidenceFixture();
  /**
   * Serve one isolated evidence lookup without external requests.
   * @param patch - Run, record or artifact mutations.
   * @returns Guard result for the requested fixture.
   */
  async function lookup(patch = {}) {
    return devEvidence(
      fixture.env,
      async (path) =>
        path.includes('/artifacts')
          ? {
              artifacts: [
                {
                  name: 'delivery-record-dev',
                  expired: false,
                  ...patch.artifact,
                },
              ],
            }
          : { workflow_runs: [{ ...fixture.run, ...patch.run }] },
      async () => ({ ...fixture.record, ...patch.record }),
    );
  }
  assert.deepEqual(await lookup(), fixture.record);
  for (const patch of [
    { run: { conclusion: 'failure' } },
    { run: { head_branch: 'feature' } },
    { run: { event: 'pull_request' } },
    { run: { head_repository: { full_name: 'benhammoush/dripperz' } } },
    { run: { path: '.github/workflows/verify-pr.yml' } },
    { run: { path: '.github/workflows/verify-and-deploy-prod.yml' } },
    { artifact: { expired: true } },
    { artifact: { name: 'build-only' } },
    { record: { sourceSha: 'd'.repeat(40) } },
    { record: { workflowRunId: '999' } },
    { record: { configurationDigest: 'invalid' } },
    { record: { artifactDigest: 'invalid' } },
    { record: { status: 'mutation-requested' } },
    { record: { environment: 'production' } },
  ])
    await assert.rejects(lookup(patch));
  await assert.rejects(
    devEvidence(fixture.env, async () => ({ workflow_runs: [] })),
  );
  await assert.rejects(devEvidence({ ...fixture.env, GH_TOKEN: '' }));
  await assert.rejects(
    devEvidence({ ...fixture.env, GITHUB_REPOSITORY: 'benhammoush/dripperz' }),
  );
  assert.throws(() =>
    deliveryRecord({ ...fixture.record, deploymentId: null }, sha, 'dev'),
  );
});

test('artifact identity rejects changed bytes and malformed manifests', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cyberclub-artifact-'));
  const previous = process.cwd();
  try {
    mkdirSync(join(directory, 'candidate/dist'), { recursive: true });
    writeFileSync(join(directory, 'candidate/dist/index.html'), 'tested bytes');
    const before = digest(join(directory, 'candidate/dist'));
    writeFileSync(
      join(directory, 'candidate/ci-build.json'),
      JSON.stringify({
        schemaVersion: 1,
        sourceSha: sha,
        environment: 'dev',
        artifactDigest: before,
      }),
    );
    process.chdir(directory);
    const env = { CI_SOURCE_SHA: sha, CI_ENVIRONMENT: 'dev' };
    assert.equal(artifact('verify', env).artifactDigest, before);
    writeFileSync('candidate/dist/index.html', 'changed bytes');
    assert.throws(() => artifact('verify', env));
    assert.throws(() => artifact('verify', { ...env, CI_SOURCE_SHA: 'main' }));
    assert.throws(() =>
      artifact('verify', { ...env, CI_ENVIRONMENT: 'staging' }),
    );
  } finally {
    process.chdir(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('browser preparation preserves signatures and bounds mirror network operations', () => {
  const root = mkdtempSync(join(tmpdir(), 'cyberclub-browser-host-'));
  try {
    mkdirSync(join(root, 'etc/apt/sources.list.d'), { recursive: true });
    mkdirSync(join(root, 'etc/apt/apt.conf.d'), { recursive: true });
    writeFileSync(
      join(root, 'etc/os-release'),
      'ID=ubuntu\nVERSION_ID="24.04"\n',
    );
    const source =
      'URIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n';
    writeFileSync(join(root, 'etc/apt/sources.list.d/ubuntu.sources'), source);
    writeFileSync(
      join(root, 'etc/apt/apt-mirrors.txt'),
      'http://azure.archive.ubuntu.com/ubuntu/\n',
    );
    browserHost(root);
    assert.equal(
      readFileSync(join(root, 'etc/apt/sources.list.d/ubuntu.sources'), 'utf8'),
      source,
    );
    assert.equal(
      readFileSync(join(root, 'etc/apt/apt-mirrors.txt'), 'utf8'),
      'https://archive.ubuntu.com/ubuntu/\n',
    );
    assert.equal(
      readFileSync(
        join(root, 'etc/apt/apt.conf.d/80-cyberclub-network'),
        'utf8',
      ),
      aptNetworkPolicy,
    );
    assert.equal(
      ubuntuMirror('https://security.ubuntu.com/ubuntu'),
      'https://security.ubuntu.com/ubuntu',
    );
    writeFileSync(join(root, 'etc/os-release'), 'ID=debian\nVERSION_ID="12"\n');
    assert.throws(() => browserHost(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Guard repository-owned verification, delivery and audit trust boundaries.
 * @file
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { configuration } from './ci-control.mjs';

const actions = new Set([
  'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
  'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
]);

/**
 * Parse YAML without aliases or duplicate keys.
 * @param text - One workflow document.
 * @returns Parsed workflow object.
 */
export function workflow(text) {
  return parse(text, { uniqueKeys: true, maxAliasCount: 0 });
}

/**
 * Validate all fixed workflow boundaries, including privileged step ordering.
 * @param documents - Workflows keyed by canonical filename.
 */
export function workflowContract(documents) {
  assert.deepEqual(
    Object.keys(documents).sort(),
    [
      'deploy.yml',
      'verify.yml',
      'verify-pr.yml',
      'verify-and-deploy-dev.yml',
      'verify-and-deploy-prod.yml',
      'weekly-vuln-audit.yml',
    ].sort(),
  );
  for (const doc of Object.values(documents)) {
    assert.ok(
      !doc.concurrency || doc.concurrency['cancel-in-progress'] === false,
    );
    for (const [id, job] of Object.entries(doc.jobs)) {
      assert.match(id, /^[a-z][a-z0-9_]*$/);
      if (job.uses)
        assert.ok(
          [
            './.github/workflows/verify.yml',
            './.github/workflows/deploy.yml',
          ].includes(job.uses),
        );
      else assert.equal(job['runs-on'], 'ubuntu-24.04');
      assert.notEqual(job.secrets, 'inherit');
      for (const step of job.steps ?? []) {
        if (step.id) assert.match(step.id, /^[a-z][a-z0-9_]*$/);
        if (step.uses)
          assert.ok(actions.has(step.uses), 'Unreviewed Action reference');
        assert.ok(
          !step.with?.repository,
          'Cross-repository checkout is forbidden',
        );
        if (step.uses?.startsWith('actions/checkout@'))
          assert.equal(step.with['persist-credentials'], false);
      }
    }
  }
  const pr = documents['verify-pr.yml'];
  const dev = documents['verify-and-deploy-dev.yml'];
  const prod = documents['verify-and-deploy-prod.yml'];
  assert.equal(pr.name, 'Verify PR');
  assert.deepEqual(pr.on, { pull_request: null });
  assert.deepEqual(pr.permissions, { contents: 'read', actions: 'read' });
  assert.ok(!JSON.stringify(pr).includes('secrets'));
  assert.ok(Object.values(pr.jobs).every((job) => !job.environment));
  assert.equal(pr.jobs.verify.with.source_sha, '${{ github.sha }}');
  assert.deepEqual(pr.jobs.verify_result, {
    name: 'Verify',
    needs: 'verify',
    if: 'always()',
    'runs-on': 'ubuntu-24.04',
    steps: [
      {
        name: 'Require successful PR checks',
        run: 'test "$VERIFY_RESULT" = success',
        env: { VERIFY_RESULT: '${{ needs.verify.result }}' },
      },
    ],
  });
  assert.equal(dev.name, 'Verify and deploy to dev');
  assert.deepEqual(Object.keys(dev.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(dev.on.push.branches, ['main']);
  assert.equal(prod.name, 'Verify and deploy to prod');
  assert.deepEqual(Object.keys(prod.on), ['workflow_dispatch']);
  for (const doc of [dev, prod]) {
    assert.equal(doc.on.workflow_dispatch.inputs.sha.type, 'string');
    assert.equal(doc.on.workflow_dispatch.inputs.sha.required, true);
  }
  for (const [job, file, target, source] of [
    [pr.jobs.verify, 'verify', 'dev', '${{ github.sha }}'],
    [dev.jobs.verify, 'verify', 'dev', '${{ inputs.sha || github.sha }}'],
    [dev.jobs.deploy_dev, 'deploy', 'dev', '${{ inputs.sha || github.sha }}'],
    [prod.jobs.verify_release, 'verify', 'production', '${{ inputs.sha }}'],
    [prod.jobs.deploy_production, 'deploy', 'production', '${{ inputs.sha }}'],
  ]) {
    assert.equal(job.uses, `./.github/workflows/${file}.yml`);
    assert.deepEqual(job.with, { source_sha: source, environment: target });
    assert.ok(!job.secrets);
  }
  assert.equal(dev.jobs.deploy_dev.needs, 'verify');
  assert.equal(prod.jobs.deploy_production.needs, 'verify_release');
  assert.equal(
    dev.jobs.deploy_dev.if,
    "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
  );
  assert.equal(
    prod.jobs.deploy_production.if,
    "github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'",
  );
  const verify = documents['verify.yml'];
  const deploy = documents['deploy.yml'];
  for (const doc of [verify, deploy]) {
    assert.deepEqual(doc.permissions, { contents: 'read', actions: 'read' });
    assert.deepEqual(Object.keys(doc.on), ['workflow_call']);
    assert.deepEqual(Object.keys(doc.on.workflow_call.inputs).sort(), [
      'environment',
      'source_sha',
    ]);
    assert.ok(!doc.on.workflow_call.secrets);
  }
  const checks = verify.jobs.verify;
  assert.ok(!checks.environment);
  assert.ok(!JSON.stringify(checks).includes('secrets.'));
  assert.equal(checks['timeout-minutes'], 40);
  const steps = checks.steps;
  const runs = steps.map((step) => step.run).filter(Boolean);
  assert.deepEqual(runs, [
    'node control/scripts/ci-control.mjs validate',
    'node control/scripts/ci-source.mjs',
    'node control/scripts/ci-dev-evidence.mjs',
    'npm ci',
    'sudo "$(command -v node)" control/scripts/ci-browser-host.mjs',
    'npx --no-install playwright install --with-deps chromium firefox webkit',
    'npm run ci:quality',
    'npm run ci:browser',
    'npm run ci:prepare',
    'node control/scripts/ci-artifact.mjs prepare',
  ]);
  const evidence = steps.find((step) => step.run === runs[2]);
  assert.equal(evidence.if, "inputs.environment == 'production'");
  const controlCheckout = steps[0];
  assert.equal(controlCheckout.with.ref, '${{ github.workflow_sha }}');
  assert.equal(controlCheckout.with.path, 'control');
  assert.equal(controlCheckout.with['fetch-depth'], 0);
  const mutation = deploy.jobs.deploy;
  assert.equal(mutation.environment, '${{ inputs.environment }}');
  assert.deepEqual(mutation.concurrency, {
    group: 'deploy-${{ github.repository }}-${{ inputs.environment }}',
    'cancel-in-progress': false,
  });
  assert.equal(
    mutation.if,
    "github.repository == 'benhammoush/cyberclub' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
  );
  assert.deepEqual(mutation.steps[0].with, controlCheckout.with);
  const checkouts = mutation.steps.filter((step) =>
    step.uses?.startsWith('actions/checkout@'),
  );
  assert.equal(checkouts.length, 1);
  const download = mutation.steps.find((step) =>
    step.uses?.startsWith('actions/download-artifact@'),
  );
  assert.deepEqual(download.with, {
    name: 'build-${{ inputs.source_sha }}-${{ inputs.environment }}',
    path: 'candidate',
  });
  assert.deepEqual(
    mutation.steps.filter((step) => step.run).map((step) => step.run),
    [
      'node control/scripts/ci-control.mjs validate',
      'node control/scripts/ci-source.mjs',
      'node control/scripts/ci-dev-evidence.mjs',
      'node control/scripts/ci-artifact.mjs verify',
      'node control/scripts/ci-control.mjs deploy',
    ],
  );
  const recheck = mutation.steps.find(
    (step) => step.run === 'node control/scripts/ci-dev-evidence.mjs',
  );
  assert.equal(recheck.if, "inputs.environment == 'production'");
  const privileged = mutation.steps.find(
    (step) => step.run === 'node control/scripts/ci-control.mjs deploy',
  );
  assert.deepEqual(privileged.env, {
    CI_CONFIGURATION: '${{ toJSON(vars) }}',
    GH_TOKEN: '${{ github.token }}',
    VERCEL_TOKEN: '${{ secrets.VERCEL_TOKEN }}',
  });
  const credentialSteps = mutation.steps.filter((step) =>
    JSON.stringify(step).includes('secrets.'),
  );
  assert.equal(credentialSteps.length, 1);
  assert.equal(mutation.steps.at(-1).if, 'always()');
  assert.equal(
    mutation.steps.at(-1).with.path,
    'candidate/delivery-record.json',
  );
  const audit = documents['weekly-vuln-audit.yml'];
  assert.deepEqual(audit.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(audit.on).sort(), [
    'schedule',
    'workflow_dispatch',
  ]);
  assert.ok(!JSON.stringify(audit).includes('secrets.'));
  assert.ok(!audit.jobs.audit.environment);
  assert.equal(
    audit.jobs.audit.if,
    "github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')",
  );
  const auditRuns = audit.jobs.audit.steps.filter((step) => step.run);
  assert.deepEqual(
    auditRuns.map((step) => step.run),
    [
      'npm ci --ignore-scripts --no-audit --no-fund',
      'npm audit --include=dev --include=optional --include=peer --audit-level=info',
      'npm audit --omit=dev --include=optional --include=peer --audit-level=info',
    ],
  );
  assert.equal(
    auditRuns.at(-1).if,
    "${{ !cancelled() && steps.install.outcome == 'success' }}",
  );
}

/**
 * Read the current repository's configuration and canonical workflow documents.
 * @param root - Application checkout root.
 * @returns Parsed workflows for conformance and mutation tests.
 */
export function readWorkflows(root = '.') {
  configuration(
    JSON.parse(readFileSync(join(root, '.github/ci-cd.json'), 'utf8')),
  );
  const directory = join(root, '.github/workflows');
  return Object.fromEntries(
    readdirSync(directory).map((name) => [
      name,
      workflow(readFileSync(join(directory, name), 'utf8')),
    ]),
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  workflowContract(readWorkflows());

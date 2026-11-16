/**
 * Require retained, successful same-repository dev delivery before production.
 * @file
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deliveryRecord } from './ci-artifact.mjs';
import { SHA } from './ci-source.mjs';

/**
 * Read repository evidence without forwarding credentials to redirects.
 * @param path - Repository-relative API path.
 * @param env - Repository and ephemeral token context.
 * @returns Parsed GitHub response.
 */
async function github(path, env) {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`,
    {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.ok(response.ok, 'GitHub evidence read failed');
  return response.json();
}

/**
 * Download one named record and remove its isolated temporary directory.
 * @param run - Eligible GitHub run metadata.
 * @param env - Repository and ephemeral token context.
 * @returns Parsed delivery record.
 */
function download(run, env) {
  const directory = mkdtempSync(join(tmpdir(), 'cyberclub-evidence-'));
  try {
    execFileSync(
      'gh',
      [
        'run',
        'download',
        String(run.id),
        '--repo',
        env.GITHUB_REPOSITORY,
        '--name',
        'delivery-record-dev',
        '--dir',
        directory,
      ],
      { env, stdio: 'pipe', timeout: 60_000 },
    );
    return JSON.parse(
      readFileSync(join(directory, 'delivery-record.json'), 'utf8'),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Find exact-source evidence among the newest 500 successful main runs.
 * @param env - Requested candidate and repository context.
 * @param read - Metadata reader, injectable for negative tests.
 * @param readRecord - Artifact reader, injectable for negative tests.
 * @returns Validated successful dev record.
 */
export async function devEvidence(
  env = process.env,
  read = github,
  readRecord = download,
) {
  assert.match(env.CI_SOURCE_SHA ?? '', SHA);
  assert.equal(env.GITHUB_REPOSITORY, 'benhammoush/cyberclub');
  assert.ok(env.GH_TOKEN);
  for (let page = 1; page <= 5; page++) {
    const { workflow_runs: runs } = await read(
      `/actions/runs?branch=main&status=success&per_page=100&page=${page}`,
      env,
    );
    for (const run of runs) {
      if (
        run.conclusion !== 'success' ||
        run.head_branch !== 'main' ||
        run.path !== '.github/workflows/verify-and-deploy-dev.yml' ||
        !['push', 'workflow_dispatch'].includes(run.event) ||
        run.head_repository?.full_name?.toLowerCase() !==
          env.GITHUB_REPOSITORY.toLowerCase()
      )
        continue;
      const { artifacts } = await read(
        `/actions/runs/${run.id}/artifacts?per_page=100`,
        env,
      );
      if (
        !artifacts.some(
          (entry) => entry.name === 'delivery-record-dev' && !entry.expired,
        )
      )
        continue;
      const record = await readRecord(run, env);
      if (record.sourceSha !== env.CI_SOURCE_SHA) continue;
      deliveryRecord(record, env.CI_SOURCE_SHA, 'dev');
      assert.equal(String(record.workflowRunId), String(run.id));
      if (env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          env.GITHUB_STEP_SUMMARY,
          `\nDev evidence run: ${run.id}\nSource: ${record.sourceSha}\nOwner acceptance, configuration and recovery review remain required.\n`,
        );
      return record;
    }
    if (runs.length < 100) break;
  }
  throw new Error(
    'No retained successful dev delivery for this SHA; revalidate in cyberclub dev',
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  await devEvidence();

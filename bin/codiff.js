#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { parseArguments, resolvePullRequestUrl } from './arguments.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const run = () => {
  const parsedArguments = parseArguments(process.argv.slice(2));
  const { commitRef, pullRequestNumber, requestedPath, walkthrough } = parsedArguments;
  let { pullRequestUrl } = parsedArguments;

  if (!pullRequestUrl && pullRequestNumber != null) {
    try {
      pullRequestUrl = resolvePullRequestUrl(requestedPath, pullRequestNumber);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  if (!existsSync(resolve(root, 'dist/index.html')) && !process.env.ELECTRON_RENDERER_URL) {
    console.error('Codiff has not been built yet. Run `pnpm build` first.');
    process.exit(1);
  }

  const child = spawn(electron, [root], {
    detached: true,
    env: {
      ...process.env,
      CODIFF_COMMIT_REF: commitRef ?? '',
      CODIFF_PULL_REQUEST_URL: pullRequestUrl ?? '',
      CODIFF_REPOSITORY_PATH: requestedPath,
      CODIFF_WALKTHROUGH: walkthrough ? '1' : '',
    },
    stdio: 'ignore',
  });

  child.unref();
};

run();

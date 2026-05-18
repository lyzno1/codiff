#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { parseArguments } from './arguments.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const run = () => {
  const { commitRef, requestedPath, walkthrough } = parseArguments(process.argv.slice(2));

  if (!existsSync(resolve(root, 'dist/index.html')) && !process.env.ELECTRON_RENDERER_URL) {
    console.error('Codiff has not been built yet. Run `pnpm build` first.');
    process.exit(1);
  }

  const child = spawn(electron, [root], {
    env: {
      ...process.env,
      CODIFF_COMMIT_REF: commitRef ?? '',
      CODIFF_REPOSITORY_PATH: requestedPath,
      CODIFF_WALKTHROUGH: walkthrough ? '1' : '',
    },
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
};

run();

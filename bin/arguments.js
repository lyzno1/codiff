import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const commitHashPattern = /^[0-9a-f]{4,64}$/i;

const isCommitHashArgument = (arg) => commitHashPattern.test(arg) && !existsSync(resolve(arg));

export const parseArguments = (args) => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      commit: {
        type: 'string',
      },
      walkthrough: {
        short: 'w',
        type: 'boolean',
      },
    },
    strict: false,
  });

  let commitRef = typeof values.commit === 'string' ? values.commit : null;
  let requestedPath = null;

  for (const arg of positionals) {
    if (!commitRef && isCommitHashArgument(arg)) {
      commitRef = arg;
    } else if (requestedPath == null) {
      requestedPath = arg;
    }
  }

  return {
    commitRef,
    requestedPath: resolve(requestedPath ?? process.cwd()),
    walkthrough: values.walkthrough === true,
  };
};

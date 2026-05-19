// @ts-check

const {
  fileSort,
  getFingerprint,
  git,
  normalizeStatus,
  readGitFile,
  summarizeContent,
} = require('./common.cjs');

/**
 * @typedef {import('../../src/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../src/types.ts').RepositoryState} RepositoryState
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 */

/** @param {string} raw @returns {Array<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>} */
const parseCommitNameStatus = (raw) => {
  const parts = raw.split('\0').filter(Boolean);
  /** @type {Array<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>} */
  const files = [];

  for (let index = 0; index < parts.length; ) {
    const statusCode = parts[index++];
    const statusType = statusCode[0];

    if (statusType === 'R' || statusType === 'C') {
      const oldPath = parts[index++];
      const path = parts[index++];
      files.push({
        oldPath,
        path,
        status: 'renamed',
      });
    } else {
      const path = parts[index++];
      files.push({
        path,
        status: normalizeStatus(statusType),
      });
    }
  }

  return files.sort(fileSort);
};

/** @param {string} path */
const createEmptyFileContent = (path) => ({
  binary: false,
  file: {
    cacheKey: `empty:${path}`,
    contents: '',
    name: path,
  },
});

/** @param {string} repoRoot @param {string} commit @returns {Promise<Array<string>>} */
const readCommitParents = async (repoRoot, commit) => {
  const raw = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', commit])).trim();
  return raw ? raw.split(' ').slice(1) : [];
};

/** @param {string} repoRoot @param {string} commit @param {string | undefined} firstParent */
const readCommitNameStatus = async (repoRoot, commit, firstParent) =>
  parseCommitNameStatus(
    await git(
      repoRoot,
      firstParent
        ? ['diff', '--name-status', '-r', '-z', '-M', firstParent, commit]
        : ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--root', '-M', commit],
    ),
  );

/** @param {string} repoRoot @param {string} commit @param {string | undefined} firstParent @param {string} path */
const readCommitPatch = (repoRoot, commit, firstParent, path) =>
  git(
    repoRoot,
    firstParent
      ? ['diff', '--patch', '--no-ext-diff', '--find-renames', firstParent, commit, '--', path]
      : ['show', '--format=', '--patch', '--no-ext-diff', '--find-renames', commit, '--', path],
  );

/** @param {string} launchPath @param {string} ref @returns {Promise<RepositoryState>} */
const readCommitState = async (launchPath, ref) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const commit = (await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  const [firstParent] = await readCommitParents(repoRoot, commit);
  const status = await readCommitNameStatus(repoRoot, commit, firstParent);
  /** @type {Array<ChangedFile>} */
  const files = [];

  for (const item of status) {
    const oldFile = firstParent
      ? await readGitFile(repoRoot, firstParent, item.oldPath || item.path, { force: true })
      : createEmptyFileContent(item.oldPath || item.path);
    const newFile = await readGitFile(repoRoot, commit, item.path, { force: true });
    const summary = summarizeContent(oldFile, newFile);
    const patch =
      summary.loadState === 'ready'
        ? await readCommitPatch(repoRoot, commit, firstParent, item.path)
        : '';

    files.push({
      fingerprint: getFingerprint(
        `${commit}\n${item.status}\n${item.oldPath || ''}\n${summary.loadState || 'ready'}\n${
          summary.summary?.reason || ''
        }\n${summary.summary?.fingerprint || ''}\n${patch}\n${oldFile.file?.contents || ''}\n${
          newFile.file?.contents || ''
        }`,
      ),
      oldPath: item.oldPath,
      path: item.path,
      sections: [
        {
          binary: summary.binary || /Binary files .* differ/.test(patch),
          id: `${item.path}:${commit}`,
          kind: 'commit',
          loadState: summary.loadState,
          newFile: newFile.file,
          oldFile: oldFile.file,
          patch,
          summary: summary.summary,
        },
      ],
      status: item.status,
    });
  }

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: {
      ref: commit,
      type: 'commit',
    },
  };
};

/** @param {string} launchPath @param {ReviewSource} [source] @returns {Promise<RepositoryState>} */
const readRepositoryState = async (launchPath, source = { type: 'working-tree' }) =>
  source.type === 'pull-request'
    ? readPullRequestState(launchPath, source)
    : source.type === 'commit'
      ? readCommitState(launchPath, source.ref)
      : readWorkingTreeState(launchPath);

/** @param {string} launchPath @param {number} [limit] */
const listRepositoryHistory = async (launchPath, limit = 200) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  try {
    await git(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    return {
      entries: [],
      root: repoRoot,
    };
  }

  const raw = await git(repoRoot, [
    'log',
    `--max-count=${limit}`,
    '--format=%H%x1f%P%x1f%ct%x1f%s%x1e',
  ]);
  const entries = [];

  for (const record of raw.split('\x1e')) {
    const [ref, parents, committedAt, subject] = record.trim().split('\x1f');
    if (!ref || !committedAt || subject == null) {
      continue;
    }

    entries.push({
      committedAt: Number(committedAt) * 1000,
      parents: parents ? parents.split(' ') : [],
      ref,
      subject,
    });
  }

  return {
    entries,
    root: repoRoot,
  };
};

module.exports = {
  listRepositoryHistory,
  parseCommitNameStatus,
  readCommitState,
};

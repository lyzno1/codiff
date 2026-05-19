// @ts-check

const { promises: fs } = require('node:fs');
const { join } = require('node:path');
const {
  createSection,
  createSummary,
  fileSort,
  generatedDirectoryPathspecExcludes,
  generatedDirectoryPathspecs,
  getFingerprint,
  getGravatarHash,
  git,
  MAX_UNTRACKED_INITIAL_ITEMS,
  parseStatus,
  readFileStat,
  validateRepositoryPath,
} = require('./common.cjs');

/**
 * @typedef {import('../../src/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../src/types.ts').DiffSection} DiffSection
 * @typedef {import('../../src/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../../src/types.ts').RepositoryState} RepositoryState
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 */

/** @param {string} repoRoot @returns {Promise<Array<StatusItem>>} */
const listUntrackedItems = async (repoRoot) => {
  const rawFiles = await git(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    '.',
    ...generatedDirectoryPathspecExcludes,
  ]);
  const paths = rawFiles.split('\0').filter(Boolean).sort();
  /** @type {Array<StatusItem>} */
  const items = paths.slice(0, MAX_UNTRACKED_INITIAL_ITEMS).map((path) => ({
    path,
    staged: false,
    status: 'untracked',
    unstaged: true,
    untracked: true,
  }));

  if (paths.length > MAX_UNTRACKED_INITIAL_ITEMS) {
    const omitted = paths.length - MAX_UNTRACKED_INITIAL_ITEMS;
    items.push({
      directory: true,
      path: `Untracked files not shown (${omitted} more)`,
      staged: false,
      status: 'untracked',
      summary: createSummary(`${omitted} untracked files are not shown.`, {
        canLoad: false,
        fileCount: omitted,
        loadState: 'directory',
      }),
      unstaged: true,
      untracked: true,
    });
  }

  const rawDirectories = await git(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--directory',
    '-z',
    '--',
    ...generatedDirectoryPathspecs,
  ]);

  for (const path of rawDirectories.split('\0').filter(Boolean)) {
    items.push({
      directory: true,
      path: path.endsWith('/') ? path.slice(0, -1) : path,
      staged: false,
      status: 'untracked',
      unstaged: true,
      untracked: true,
    });
  }

  const unique = new Map();
  for (const item of items) {
    unique.set(item.path, item);
  }

  return [...unique.values()].sort(fileSort);
};

/** @param {string} launchPath @returns {Promise<RepositoryState>} */
const readWorkingTreeState = async (launchPath) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const [trackedStatus, untrackedItems] = await Promise.all([
    git(repoRoot, ['status', '--porcelain=v1', '-z', '-uno']),
    listUntrackedItems(repoRoot),
  ]);
  const status = [...parseStatus(trackedStatus), ...untrackedItems].sort(fileSort);
  /** @type {Array<ChangedFile>} */
  const files = [];

  for (const item of status) {
    /** @type {Array<DiffSection>} */
    const sections = [];

    if (item.staged) {
      sections.push(await createSection(repoRoot, item, 'staged'));
    }

    if (item.unstaged) {
      sections.push(await createSection(repoRoot, item, 'unstaged'));
    }

    const fingerprint = getFingerprint(
      `${item.status}\n${item.oldPath || ''}\n${sections
        .map(
          (section) =>
            `${section.loadState || 'ready'}\n${section.binary ? 'binary' : 'text'}\n${
              section.patch
            }\n${section.summary?.reason || ''}\n${section.summary?.fingerprint || ''}\n${
              section.oldFile?.contents || ''
            }\n${section.newFile?.contents || ''}`,
        )
        .join('\n')}`,
    );

    files.push({
      fingerprint,
      oldPath: item.oldPath,
      path: item.path,
      sections,
      status: item.status,
    });
  }

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: {
      type: 'working-tree',
    },
  };
};

/** @param {string} repoRoot @param {string} path @returns {Promise<StatusItem>} */
const getStatusItemForPath = async (repoRoot, path) => {
  const trackedStatus = parseStatus(
    await git(repoRoot, ['status', '--porcelain=v1', '-z', '-uno']),
  );
  const trackedItem = trackedStatus.find((item) => item.path === path);
  if (trackedItem) {
    return trackedItem;
  }

  const stat = await readFileStat(repoRoot, path);
  return {
    directory: Boolean(stat?.isDirectory()),
    path,
    staged: false,
    status: 'untracked',
    unstaged: true,
    untracked: true,
  };
};

/** @param {string} launchPath @param {DiffSectionContentRequest} request */
const readDiffSectionContent = async (launchPath, request) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const path = validateRepositoryPath(request.path);
  if (request.kind === 'commit' || request.source?.type === 'commit') {
    throw new Error('Lazy loading commit diffs is not supported.');
  }

  const item = await getStatusItemForPath(repoRoot, path);
  return createSection(repoRoot, item, /** @type {WorkingTreeSectionKind} */ (request.kind), {
    force: request.force,
  });
};

/** @param {string} repoRoot @param {string} path */
const readWorkingTreePathSignature = async (repoRoot, path) => {
  try {
    const absolutePath = join(repoRoot, path);
    const stat = await fs.lstat(absolutePath);

    if (stat.isDirectory()) {
      return `${path}\0directory\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}`;
    }

    if (stat.isSymbolicLink()) {
      return `${path}\0symlink\0${stat.mode}\0${await fs.readlink(absolutePath)}`;
    }

    if (!stat.isFile()) {
      return `${path}\0other\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}`;
    }

    const content =
      stat.size <= 64 * 1024 * 1024
        ? getFingerprint(await fs.readFile(absolutePath))
        : `${stat.size}\0${stat.mtimeMs}`;

    return `${path}\0file\0${stat.mode}\0${stat.size}\0${content}`;
  } catch {
    return `${path}\0missing`;
  }
};

/** @param {string} repoRoot */
const readWorkingTreeChangeSignatures = async (repoRoot) => {
  const status = parseStatus(await git(repoRoot, ['status', '--porcelain=v1', '-z', '-uall']));
  const signatures = new Map();

  for (const item of status) {
    if (
      item.oldPath &&
      item.oldPath !== item.path &&
      !(await readFileStat(repoRoot, item.oldPath))
    ) {
      signatures.set(item.oldPath, `${item.oldPath}\0missing`);
    }

    signatures.set(item.path, await readWorkingTreePathSignature(repoRoot, item.path));
  }

  return [...signatures.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, signature]) => signature)
    .join('\0');
};

/** @param {string} repoRoot @param {ReadonlyArray<string>} args */
const gitOrEmpty = async (repoRoot, args) => {
  try {
    return await git(repoRoot, args);
  } catch {
    return '';
  }
};

/** @param {string} launchPath */
const readGitIdentity = async (launchPath) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const [name, email] = await Promise.all([
    gitOrEmpty(repoRoot, ['config', '--get', 'user.name']),
    gitOrEmpty(repoRoot, ['config', '--get', 'user.email']),
  ]);
  const trimmedEmail = email.trim();

  return {
    email: trimmedEmail,
    gravatarUrl: trimmedEmail
      ? `https://www.gravatar.com/avatar/${getGravatarHash(trimmedEmail)}?s=80&d=identicon`
      : undefined,
    name: name.trim(),
  };
};

/** @param {string} launchPath */
const readRepositoryChangeSignature = async (launchPath) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const [head, workingTree] = await Promise.all([
    gitOrEmpty(repoRoot, ['rev-parse', '--verify', 'HEAD']),
    readWorkingTreeChangeSignatures(repoRoot),
  ]);

  return {
    root: repoRoot,
    signature: getFingerprint([head, workingTree].join('\0')),
  };
};

module.exports = {
  getStatusItemForPath,
  listUntrackedItems,
  readDiffSectionContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readWorkingTreeState,
};

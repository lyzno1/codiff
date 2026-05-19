// @ts-check

const { execFile } = require('node:child_process');
const { promises: fs } = require('node:fs');
const { createHash } = require('node:crypto');
const { isAbsolute, join, normalize, sep } = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

/**
 * @typedef {import('../src/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../src/types.ts').DiffSection} DiffSection
 * @typedef {import('../src/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../src/types.ts').GitFileStatus} GitFileStatus
 * @typedef {import('../src/types.ts').PullRequestReviewComment} PullRequestReviewComment
 * @typedef {import('../src/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../src/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../src/types.ts').SubmitPullRequestCommentRequest} SubmitPullRequestCommentRequest
 * @typedef {import('../src/types.ts').SubmitPullRequestReviewRequest} SubmitPullRequestReviewRequest
 * @typedef {'staged' | 'unstaged'} WorkingTreeSectionKind
 * @typedef {{cacheKey: string; contents: string; name: string}} TextFile
 * @typedef {{reason: string; canLoad?: boolean; fileCount?: number; fingerprint?: string; limit?: number; loadState?: DiffSection['loadState']; size?: number}} DiffSummary
 * @typedef {{binary: boolean; file?: TextFile; fingerprint?: string; loadState?: DiffSection['loadState']; summary?: DiffSummary}} FileContentResult
 * @typedef {{
 *   directory?: boolean;
 *   oldPath?: string;
 *   path: string;
 *   staged: boolean;
 *   status: GitFileStatus;
 *   summary?: DiffSummary;
 *   unstaged: boolean;
 *   untracked: boolean;
 * }} StatusItem
 * @typedef {{force?: boolean}} ReadFileOptions
 * @typedef {{number: number; owner: string; repo: string; url: string}} PullRequestReference
 * @typedef {{owner: string; repo: string}} GitHubRemote
 * @typedef {{filename: string; patch?: string; previous_filename?: string; status: string}} GitHubPullRequestFile
 * @typedef {{head?: {sha?: string}; title?: string}} GitHubPullRequestMetadata
 * @typedef {{[key: string]: any}} GitHubReviewComment
 */

/** @param {string | Buffer} value */
const getFingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** @param {string} email */
const getGravatarHash = (email) =>
  createHash('md5').update(email.trim().toLowerCase()).digest('hex');

/**
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {{encoding?: BufferEncoding}} [options]
 * @returns {Promise<string>}
 */
const git = async (repoPath, args, options = {}) => {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: options.encoding || 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
};

/** @param {string} repoPath @param {ReadonlyArray<string>} args @returns {Promise<Buffer>} */
const gitBuffer = async (repoPath, args) => {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
};

const EAGER_TEXT_FILE_LIMIT = 256 * 1024;
const MANUAL_TEXT_FILE_LIMIT = 2 * 1024 * 1024;
const MAX_UNTRACKED_INITIAL_ITEMS = 1000;
const GENERATED_DIRECTORY_NAMES = new Set([
  '.cache',
  '.next',
  '.parcel-cache',
  '.pnpm-store',
  '.turbo',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

const generatedDirectoryPathspecExcludes = [...GENERATED_DIRECTORY_NAMES].flatMap((name) => [
  `:(exclude)${name}/**`,
  `:(exclude)**/${name}/**`,
]);

const generatedDirectoryPathspecs = [...GENERATED_DIRECTORY_NAMES].flatMap((name) => [
  name,
  `:(glob)**/${name}/`,
]);

/** @param {{path: string}} left @param {{path: string}} right */
const fileSort = (left, right) => {
  const leftParts = left.path.split('/');
  const rightParts = right.path.split('/');
  const length = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === rightPart) {
      continue;
    }

    const leftIsDirectory = index < leftParts.length - 1;
    const rightIsDirectory = index < rightParts.length - 1;
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }

    return leftPart.localeCompare(rightPart);
  }

  return leftParts.length - rightParts.length;
};

/** @param {string} raw @returns {Array<StatusItem>} */
const parseStatus = (raw) => {
  const parts = raw.split('\0').filter(Boolean);
  const files = new Map();

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    const x = record[0];
    const y = record[1];
    let path = record.slice(3);
    /** @type {string | undefined} */
    let oldPath;

    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = parts[++index];
    }

    const current = files.get(path) || {
      oldPath,
      path,
      staged: false,
      status: 'modified',
      unstaged: false,
      untracked: false,
    };

    if (x === '?' && y === '?') {
      current.status = 'untracked';
      current.unstaged = true;
      current.untracked = true;
    } else {
      current.staged = x !== ' ';
      current.unstaged = y !== ' ';

      const statusCode = current.staged ? x : y;
      current.status =
        statusCode === 'A'
          ? 'added'
          : statusCode === 'D'
            ? 'deleted'
            : statusCode === 'R' || statusCode === 'C'
              ? 'renamed'
              : 'modified';
    }

    files.set(path, current);
  }

  return [...files.values()].sort(fileSort);
};

/** @param {Buffer} buffer */
const isBinaryBuffer = (buffer) => buffer.includes(0);

/** @param {number} size */
const formatBytes = (size) => {
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ['KiB', 'MiB', 'GiB'];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    }
    value /= 1024;
  }

  return `${size} B`;
};

/** @param {string} reason @param {Partial<DiffSummary>} [details] @returns {DiffSummary} */
const createSummary = (reason, details = {}) => ({
  reason,
  ...details,
});

/** @param {unknown} path */
const validateRepositoryPath = (path) => {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || isAbsolute(path)) {
    throw new Error('Invalid repository path.');
  }

  const normalized = normalize(path);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error('Invalid repository path.');
  }

  return path;
};

/** @param {string} repoRoot @param {string} path */
const readFileStat = async (repoRoot, path) => {
  try {
    return await fs.lstat(join(repoRoot, path));
  } catch {
    return undefined;
  }
};

/** @param {string} repoRoot @param {string} spec */
const getBlobSize = async (repoRoot, spec) => {
  try {
    return Number((await git(repoRoot, ['cat-file', '-s', spec])).trim());
  } catch {
    return undefined;
  }
};

/** @param {string} name @param {Buffer} buffer @param {string} cacheKey @returns {FileContentResult} */
const bufferToTextFile = (name, buffer, cacheKey) => {
  const fingerprint = getFingerprint(buffer);

  if (isBinaryBuffer(buffer)) {
    return {
      binary: true,
      fingerprint,
      file: undefined,
      summary: createSummary('Binary file changed.', {
        canLoad: false,
        fingerprint,
        size: buffer.length,
      }),
    };
  }

  return {
    binary: false,
    file: {
      cacheKey,
      contents: buffer.toString('utf8'),
      name,
    },
  };
};

/**
 * @param {string} repoRoot
 * @param {string} ref
 * @param {string} path
 * @param {ReadFileOptions} [options]
 * @returns {Promise<FileContentResult>}
 */
const readGitFile = async (repoRoot, ref, path, options = {}) => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;
  const spec = `${ref}:${path}`;

  try {
    const size = await getBlobSize(repoRoot, spec);
    if (size != null && size > limit) {
      return {
        binary: false,
        loadState: size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
        summary: createSummary(
          size > MANUAL_TEXT_FILE_LIMIT
            ? `File is ${formatBytes(size)}, so Codiff skipped rendering it.`
            : `File is ${formatBytes(size)} and will be loaded on demand.`,
          {
            canLoad: size <= MANUAL_TEXT_FILE_LIMIT,
            limit,
            size,
          },
        ),
      };
    }

    const buffer = await gitBuffer(repoRoot, ['show', spec]);
    return bufferToTextFile(path, buffer, `${ref}:${path}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `${ref}:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

/**
 * @param {string} repoRoot
 * @param {string} path
 * @param {ReadFileOptions} [options]
 * @returns {Promise<FileContentResult>}
 */
const readIndexFile = async (repoRoot, path, options = {}) => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;
  const spec = `:${path}`;

  try {
    const size = await getBlobSize(repoRoot, spec);
    if (size != null && size > limit) {
      return {
        binary: false,
        loadState: size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
        summary: createSummary(
          size > MANUAL_TEXT_FILE_LIMIT
            ? `File is ${formatBytes(size)}, so Codiff skipped rendering it.`
            : `File is ${formatBytes(size)} and will be loaded on demand.`,
          {
            canLoad: size <= MANUAL_TEXT_FILE_LIMIT,
            limit,
            size,
          },
        ),
      };
    }

    const buffer = await gitBuffer(repoRoot, ['show', spec]);
    return bufferToTextFile(path, buffer, `index:${path}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `index:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

/**
 * @param {string} repoRoot
 * @param {string} path
 * @param {ReadFileOptions} [options]
 * @returns {Promise<FileContentResult>}
 */
const readWorkingTreeFile = async (repoRoot, path, options = {}) => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;

  try {
    const stat = await readFileStat(repoRoot, path);
    if (!stat) {
      throw new Error('File is missing.');
    }

    if (stat.isDirectory()) {
      return {
        binary: false,
        loadState: 'directory',
        summary: createSummary('Untracked directory is collapsed by default.', {
          canLoad: false,
        }),
      };
    }

    if (stat.isSymbolicLink()) {
      const contents = await fs.readlink(join(repoRoot, path));
      const size = Buffer.byteLength(contents);

      if (size > limit) {
        return {
          binary: false,
          loadState: size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
          summary: createSummary(
            size > MANUAL_TEXT_FILE_LIMIT
              ? `Symlink target is ${formatBytes(size)}, so Codiff skipped rendering it.`
              : `Symlink target is ${formatBytes(size)} and will be loaded on demand.`,
            {
              canLoad: size <= MANUAL_TEXT_FILE_LIMIT,
              limit,
              size,
            },
          ),
        };
      }

      return {
        binary: false,
        file: {
          cacheKey: `worktree:${path}:symlink:${contents}`,
          contents,
          name: path,
        },
      };
    }

    if (!stat.isFile()) {
      return {
        binary: false,
        loadState: 'error',
        summary: createSummary('Path is not a regular file.', {
          canLoad: false,
          size: stat.size,
        }),
      };
    }

    if (stat.size > limit) {
      return {
        binary: false,
        loadState: stat.size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
        summary: createSummary(
          stat.size > MANUAL_TEXT_FILE_LIMIT
            ? `File is ${formatBytes(stat.size)}, so Codiff skipped rendering it.`
            : `File is ${formatBytes(stat.size)} and will be loaded on demand.`,
          {
            canLoad: stat.size <= MANUAL_TEXT_FILE_LIMIT,
            limit,
            size: stat.size,
          },
        ),
      };
    }

    const buffer = await fs.readFile(join(repoRoot, path));
    return bufferToTextFile(path, buffer, `worktree:${path}:${buffer.length}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `worktree:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

/** @param {string} path @param {string} contents */
const createPatchForNewFile = (path, contents) => {
  const trimmed = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  const lines = trimmed.length > 0 ? trimmed.split('\n') : [];
  const body = lines.map((line) => `+${line}`).join('\n');
  const noNewline = contents.endsWith('\n') ? '' : '\n\\ No newline at end of file';

  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
  ]
    .filter(Boolean)
    .join('\n')
    .concat(noNewline, '\n');
};

/** @param {string} repoRoot @param {string} path @param {WorkingTreeSectionKind} kind */
const getPatch = async (repoRoot, path, kind) => {
  const args =
    kind === 'staged'
      ? ['diff', '--cached', '--patch', '--no-ext-diff', '--', path]
      : ['diff', '--patch', '--no-ext-diff', '--', path];
  const patch = await git(repoRoot, args);

  return {
    binary: /Binary files .* differ/.test(patch),
    patch,
  };
};

/** @param {...FileContentResult} results @returns {{binary: boolean; loadState: DiffSection['loadState']; summary?: DiffSummary}} */
const summarizeContent = (...results) => {
  const binaryResults = results.filter((result) => result.binary);
  if (binaryResults.length > 0) {
    const fingerprint = getFingerprint(
      binaryResults
        .map((result) => `${result.fingerprint || ''}\0${result.summary?.size || ''}`)
        .join('\0'),
    );

    return {
      binary: true,
      loadState: 'binary',
      summary: createSummary('Binary file changed.', {
        canLoad: false,
        fingerprint,
      }),
    };
  }

  const summaryResult = results.find((result) => result.loadState && result.loadState !== 'ready');
  if (summaryResult) {
    return {
      binary: false,
      loadState: summaryResult.loadState,
      summary: summaryResult.summary,
    };
  }

  return {
    binary: false,
    loadState: 'ready',
  };
};

/**
 * @param {string} repoRoot
 * @param {StatusItem} item
 * @param {WorkingTreeSectionKind} kind
 * @param {ReadFileOptions} [options]
 */
const getWorkingTreeContents = async (repoRoot, item, kind, options = {}) => {
  if (kind === 'staged') {
    const oldFile = await readGitFile(repoRoot, 'HEAD', item.oldPath || item.path, options);
    const newFile = await readIndexFile(repoRoot, item.path, options);
    const summary = summarizeContent(oldFile, newFile);

    return {
      ...summary,
      newFile: newFile.file,
      oldFile: oldFile.file,
    };
  }

  if (item.untracked) {
    /** @type {FileContentResult} */
    const newFile = item.summary
      ? {
          binary: false,
          loadState: item.summary.loadState,
          summary: item.summary,
        }
      : item.directory
        ? {
            binary: false,
            loadState: 'directory',
            summary: createSummary('Untracked directory is collapsed by default.', {
              canLoad: false,
            }),
          }
        : await readWorkingTreeFile(repoRoot, item.path, options);
    const summary = summarizeContent(newFile);

    return {
      ...summary,
      newFile: newFile.file,
      oldFile: {
        cacheKey: `empty:${item.path}`,
        contents: '',
        name: item.path,
      },
    };
  }

  const oldFile = await readIndexFile(repoRoot, item.oldPath || item.path, options);
  const newFile = await readWorkingTreeFile(repoRoot, item.path, options);
  const summary = summarizeContent(oldFile, newFile);

  return {
    ...summary,
    newFile: newFile.file,
    oldFile: oldFile.file,
  };
};

/**
 * @param {string} repoRoot
 * @param {StatusItem} item
 * @param {WorkingTreeSectionKind} kind
 * @param {ReadFileOptions} [options]
 * @returns {Promise<DiffSection>}
 */
const createSection = async (repoRoot, item, kind, options = {}) => {
  const contents = await getWorkingTreeContents(repoRoot, item, kind, options);
  const id = `${item.path}:${kind}`;

  if (contents.loadState !== 'ready') {
    return {
      binary: contents.binary,
      id,
      kind,
      loadState: contents.loadState,
      patch: '',
      summary: contents.summary,
    };
  }

  if (item.untracked) {
    return {
      binary: false,
      id,
      kind,
      loadState: 'ready',
      newFile: contents.newFile,
      oldFile: contents.oldFile,
      patch: createPatchForNewFile(item.path, contents.newFile?.contents || ''),
    };
  }

  const patch = await getPatch(repoRoot, item.path, kind);

  return {
    binary: patch.binary || contents.binary,
    id,
    kind,
    loadState: 'ready',
    newFile: contents.newFile,
    oldFile: contents.oldFile,
    patch: patch.patch,
  };
};

/** @param {string} statusCode @returns {GitFileStatus} */
const normalizeStatus = (statusCode) =>
  statusCode === 'A'
    ? 'added'
    : statusCode === 'D'
      ? 'deleted'
      : statusCode === 'R' || statusCode === 'C'
        ? 'renamed'
        : 'modified';

/** @param {string} repoRoot @param {ReadonlyArray<string>} args */
const gitOrEmpty = async (repoRoot, args) => {
  try {
    return await git(repoRoot, args);
  } catch {
    return '';
  }
};

module.exports = {
  EAGER_TEXT_FILE_LIMIT,
  GENERATED_DIRECTORY_NAMES,
  MANUAL_TEXT_FILE_LIMIT,
  MAX_UNTRACKED_INITIAL_ITEMS,
  bufferToTextFile,
  createPatchForNewFile,
  createSection,
  createSummary,
  fileSort,
  formatBytes,
  generatedDirectoryPathspecExcludes,
  generatedDirectoryPathspecs,
  getBlobSize,
  getFingerprint,
  getGravatarHash,
  getPatch,
  getWorkingTreeContents,
  git,
  gitBuffer,
  gitOrEmpty,
  isBinaryBuffer,
  normalizeStatus,
  parseStatus,
  readFileStat,
  readGitFile,
  readIndexFile,
  readWorkingTreeFile,
  summarizeContent,
  validateRepositoryPath,
};

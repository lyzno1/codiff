// @ts-check

const { execFile, spawn } = require('node:child_process');
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
 * @typedef {{reason: string; canLoad?: boolean; fileCount?: number; limit?: number; loadState?: DiffSection['loadState']; size?: number}} DiffSummary
 * @typedef {{binary: boolean; file?: TextFile; loadState?: DiffSection['loadState']; summary?: DiffSummary}} FileContentResult
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
  if (isBinaryBuffer(buffer)) {
    return {
      binary: true,
      file: undefined,
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
  const binary = results.some((result) => result.binary);
  if (binary) {
    return {
      binary: true,
      loadState: 'binary',
      summary: createSummary('Binary file changed.', {
        canLoad: false,
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

/** @param {string} value @returns {PullRequestReference} */
const parseGitHubPullRequestUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Codiff expected a GitHub pull request URL.');
  }

  if (url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Codiff only supports GitHub pull request URLs.');
  }

  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match) {
    throw new Error('Codiff expected a GitHub pull request URL.');
  }

  const [, owner, repo, number] = match;
  return {
    number: Number(number),
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
};

/** @param {string} value @returns {GitHubRemote | null} */
const parseGitHubRemoteUrl = (value) => {
  const trimmed = value.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2].replace(/\.git$/i, ''),
    };
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== 'github.com') {
      return null;
    }

    const match = url.pathname.match(/^\/([^/]+)\/(.+?)(?:\.git)?$/);
    return match
      ? {
          owner: match[1],
          repo: match[2].replace(/\.git$/i, ''),
        }
      : null;
  } catch {
    return null;
  }
};

/** @param {string} repoRoot @returns {Promise<Array<GitHubRemote>>} */
const readLocalGitHubRemotes = async (repoRoot) => {
  const raw = await gitOrEmpty(repoRoot, ['remote', '-v']);
  const remotes = [];
  for (const line of raw.split('\n')) {
    const match = line.match(/^\S+\s+(\S+)\s+\((?:fetch|push)\)$/);
    const remote = match ? parseGitHubRemoteUrl(match[1]) : null;
    if (remote) {
      remotes.push(remote);
    }
  }
  return remotes;
};

/** @param {string} repoRoot @param {PullRequestReference} pullRequest */
const assertPullRequestMatchesRepository = async (repoRoot, pullRequest) => {
  const remotes = await readLocalGitHubRemotes(repoRoot);
  const matches = remotes.some(
    (remote) =>
      remote.owner.toLowerCase() === pullRequest.owner.toLowerCase() &&
      remote.repo.toLowerCase() === pullRequest.repo.toLowerCase(),
  );

  if (!matches) {
    throw new Error(
      `Pull request ${pullRequest.owner}/${pullRequest.repo} does not match a GitHub remote in this repository.`,
    );
  }
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} args
 * @param {unknown} [input]
 * @returns {Promise<string>}
 */
const ghApi = (repoRoot, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn('gh', ['api', ...args], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** @type {Array<Buffer>} */
    const stdout = [];
    /** @type {Array<Buffer>} */
    const stderr = [];

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      if (code === 0) {
        resolve(output);
        return;
      }

      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(errorOutput || `gh api exited with code ${code}.`));
    });

    if (input == null) {
      child.stdin.end();
    } else {
      child.stdin.end(JSON.stringify(input));
    }
  });

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @returns {Promise<GitHubPullRequestMetadata>} */
const readPullRequestMetadata = async (repoRoot, pullRequest) =>
  JSON.parse(
    await ghApi(repoRoot, [
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}`,
    ]),
  );

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @returns {Promise<Array<GitHubPullRequestFile>>} */
const readPullRequestFiles = async (repoRoot, pullRequest) => {
  const pages = JSON.parse(
    await ghApi(repoRoot, [
      '--paginate',
      '--slurp',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/files?per_page=100`,
    ]),
  );
  return pages.flat();
};

/** @param {string} repoRoot @param {PullRequestReference} pullRequest */
const readPullRequestDiff = async (repoRoot, pullRequest) =>
  ghApi(repoRoot, [
    '-H',
    'Accept: application/vnd.github.v3.diff',
    `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}`,
  ]);

/** @param {unknown} side */
const fromGitHubReviewSide = (side) => (side === 'LEFT' ? 'deletions' : 'additions');
/** @param {unknown} side */
const isGitHubReviewSide = (side) => side === 'LEFT' || side === 'RIGHT';

/** @param {...unknown} values */
const firstNumber = (...values) => values.find((value) => typeof value === 'number');

/** @param {GitHubReviewComment} comment */
const normalizeGitHubReviewComment = (comment) => {
  const lineNumber = firstNumber(comment.line, comment.original_line);
  if (lineNumber == null || !comment.path || !comment.body) {
    return null;
  }

  const side = fromGitHubReviewSide(comment.side);
  const startLineNumber = firstNumber(comment.start_line, comment.original_start_line);
  const startSide = isGitHubReviewSide(comment.start_side)
    ? fromGitHubReviewSide(comment.start_side)
    : undefined;
  const hasRange =
    startLineNumber != null && (startLineNumber !== lineNumber || (startSide ?? side) !== side);

  return {
    author: {
      avatarUrl: comment.user?.avatar_url,
      login: comment.user?.login || 'GitHub user',
      url: comment.user?.html_url,
    },
    body: comment.body,
    filePath: comment.path,
    id: `github:${comment.id}`,
    lineNumber,
    side,
    ...(hasRange ? { startLineNumber } : {}),
    ...(hasRange && startSide != null && startSide !== side ? { startSide } : {}),
    submittedAt: comment.created_at,
    url: comment.html_url,
  };
};

/** @param {string} repoRoot @param {PullRequestReference} pullRequest */
const readPullRequestComments = async (repoRoot, pullRequest) => {
  const pages = JSON.parse(
    await ghApi(repoRoot, [
      '--paginate',
      '--slurp',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/comments?per_page=100`,
    ]),
  );
  return pages.flat().map(normalizeGitHubReviewComment).filter(Boolean);
};

/** @param {string} diff @returns {Map<string, string>} */
const splitPullRequestDiff = (diff) => {
  const chunks = diff
    .split(/(?=^diff --git )/m)
    .map((chunk) => chunk.trimEnd())
    .filter((chunk) => chunk.startsWith('diff --git '));
  const map = new Map();

  for (const chunk of chunks) {
    const newPath = chunk.match(/^\+\+\+\s+b\/(.+)$/m)?.[1];
    const oldPath = chunk.match(/^---\s+a\/(.+)$/m)?.[1];
    const renamePath = chunk.match(/^rename to (.+)$/m)?.[1];
    const path = newPath && newPath !== '/dev/null' ? newPath : renamePath || oldPath;
    if (path) {
      map.set(path, `${chunk}\n`);
    }
  }

  return map;
};

/** @param {string} path */
const quotePatchPath = (path) => path.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

/** @param {GitHubPullRequestFile} file */
const createPatchFromPullRequestFile = (file) => {
  if (!file.patch) {
    return '';
  }

  const oldPath = file.previous_filename || file.filename;
  const header = [
    `diff --git a/${quotePatchPath(oldPath)} b/${quotePatchPath(file.filename)}`,
    file.status === 'added' ? '--- /dev/null' : `--- a/${quotePatchPath(oldPath)}`,
    file.status === 'removed' ? '+++ /dev/null' : `+++ b/${quotePatchPath(file.filename)}`,
  ];

  return `${header.join('\n')}\n${file.patch}\n`;
};

/** @param {string} status @returns {GitFileStatus} */
const normalizePullRequestFileStatus = (status) =>
  status === 'added'
    ? 'added'
    : status === 'removed'
      ? 'deleted'
      : status === 'renamed'
        ? 'renamed'
        : 'modified';

/** @param {PullRequestReference} pullRequest @param {GitHubPullRequestMetadata} metadata @returns {Extract<ReviewSource, {type: 'pull-request'}>} */
const createPullRequestSource = (pullRequest, metadata) => ({
  headSha: metadata.head?.sha,
  number: pullRequest.number,
  owner: pullRequest.owner,
  repo: pullRequest.repo,
  title: metadata.title,
  type: 'pull-request',
  url: pullRequest.url,
});

/** @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source @returns {Promise<RepositoryState>} */
const readPullRequestState = async (launchPath, source) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  await assertPullRequestMatchesRepository(repoRoot, pullRequest);

  const [metadata, apiFiles, diff, reviewComments] = await Promise.all([
    readPullRequestMetadata(repoRoot, pullRequest),
    readPullRequestFiles(repoRoot, pullRequest),
    readPullRequestDiff(repoRoot, pullRequest),
    readPullRequestComments(repoRoot, pullRequest),
  ]);
  const diffByPath = splitPullRequestDiff(diff);

  /** @type {Array<ChangedFile>} */
  const files = [...apiFiles]
    .sort((left, right) => left.filename.localeCompare(right.filename))
    .map((file) => {
      const patch = diffByPath.get(file.filename) || createPatchFromPullRequestFile(file);
      const binary = !patch || /Binary files .* differ/.test(patch);

      return {
        fingerprint: getFingerprint(
          `${metadata.head?.sha || ''}\n${file.status}\n${file.previous_filename || ''}\n${
            file.filename
          }\n${patch}`,
        ),
        oldPath: file.previous_filename,
        path: file.filename,
        sections: [
          {
            binary,
            id: `${file.filename}:pull-request:${pullRequest.number}`,
            kind: 'pull-request',
            loadState: binary ? 'binary' : 'ready',
            patch,
            summary: binary
              ? createSummary('Binary file changed.', {
                  canLoad: false,
                })
              : undefined,
          },
        ],
        status: normalizePullRequestFileStatus(file.status),
      };
    });

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    reviewComments,
    root: repoRoot,
    source: createPullRequestSource(pullRequest, metadata),
  };
};

/** @param {PullRequestReviewComment['side']} side */
const toGitHubReviewSide = (side) => (side === 'deletions' ? 'LEFT' : 'RIGHT');

/** @param {PullRequestReviewComment} comment */
const normalizePullRequestComment = (comment) => {
  /** @type {{body: string; line: number; path: string; side: string; start_line?: number; start_side?: string}} */
  const payload = {
    body: comment.body,
    line: comment.lineNumber,
    path: comment.filePath,
    side: toGitHubReviewSide(comment.side),
  };
  const startSide = comment.startSide ?? comment.side;
  if (
    typeof comment.startLineNumber === 'number' &&
    comment.startLineNumber !== comment.lineNumber
  ) {
    payload.start_line = comment.startLineNumber;
    payload.start_side = toGitHubReviewSide(startSide);
  }
  return payload;
};

/** @param {string} launchPath @param {SubmitPullRequestCommentRequest} request */
const submitPullRequestComment = async (launchPath, request) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(request.source.url);
  await assertPullRequestMatchesRepository(repoRoot, pullRequest);

  const metadata = await readPullRequestMetadata(repoRoot, pullRequest);
  const payload = {
    ...normalizePullRequestComment(request.comment),
    commit_id: metadata.head?.sha,
  };

  const rawComment = await ghApi(
    repoRoot,
    [
      '-X',
      'POST',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/comments`,
      '--input',
      '-',
    ],
    payload,
  );
  const comment = normalizeGitHubReviewComment(JSON.parse(rawComment));
  if (!comment) {
    throw new Error('GitHub accepted the comment but did not return line metadata.');
  }
  return comment;
};

/** @param {string} launchPath @param {SubmitPullRequestReviewRequest} request */
const submitPullRequestReview = async (launchPath, request) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(request.source.url);
  await assertPullRequestMatchesRepository(repoRoot, pullRequest);

  await ghApi(
    repoRoot,
    [
      '-X',
      'POST',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/reviews`,
      '--input',
      '-',
    ],
    {
      body:
        request.body ||
        (request.event === 'REQUEST_CHANGES' && request.comments.length === 0
          ? 'Requesting changes.'
          : ''),
      comments: request.comments.map(normalizePullRequestComment),
      event: request.event,
    },
  );
};

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
            }\n${section.summary?.reason || ''}\n${
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

/** @param {string} repoRoot */
const readUntrackedFileSignatures = async (repoRoot) => {
  const raw = await git(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--directory',
    '-z',
    '--',
    '.',
  ]);
  const paths = raw.split('\0').filter(Boolean).sort();
  const signatures = [];

  for (const path of paths) {
    try {
      const stat = await fs.lstat(join(repoRoot, path));
      signatures.push(`${path}\0${stat.size}\0${stat.mtimeMs}\0${stat.mode}`);
    } catch {
      signatures.push(`${path}\0missing`);
    }
  }

  return signatures.join('\0');
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
  const [head, status, stagedDiff, unstagedDiff, untracked] = await Promise.all([
    gitOrEmpty(repoRoot, ['rev-parse', '--verify', 'HEAD']),
    git(repoRoot, ['status', '--branch', '--porcelain=v1', '-z', '-uno']),
    gitOrEmpty(repoRoot, ['diff', '--cached', '--binary', '--no-ext-diff']),
    gitOrEmpty(repoRoot, ['diff', '--binary', '--no-ext-diff']),
    readUntrackedFileSignatures(repoRoot),
  ]);

  return {
    root: repoRoot,
    signature: getFingerprint([head, status, stagedDiff, unstagedDiff, untracked].join('\0')),
  };
};

/** @param {string} launchPath @param {string} ref @returns {Promise<RepositoryState>} */
const readCommitState = async (launchPath, ref) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const commit = (await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  const status = parseCommitNameStatus(
    await git(repoRoot, [
      'diff-tree',
      '--no-commit-id',
      '--name-status',
      '-r',
      '-z',
      '--root',
      '-M',
      commit,
    ]),
  );
  /** @type {Array<ChangedFile>} */
  const files = [];

  for (const item of status) {
    const patch = await git(repoRoot, [
      'show',
      '--format=',
      '--patch',
      '--no-ext-diff',
      '--find-renames',
      commit,
      '--',
      item.path,
    ]);
    const oldFile = await readGitFile(repoRoot, `${commit}^`, item.oldPath || item.path);
    const newFile = await readGitFile(repoRoot, commit, item.path);

    files.push({
      fingerprint: getFingerprint(
        `${commit}\n${item.oldPath || ''}\n${patch}\n${oldFile.file?.contents || ''}\n${
          newFile.file?.contents || ''
        }`,
      ),
      oldPath: item.oldPath,
      path: item.path,
      sections: [
        {
          binary: /Binary files .* differ/.test(patch) || oldFile.binary || newFile.binary,
          id: `${item.path}:${commit}`,
          kind: 'commit',
          newFile: newFile.file,
          oldFile: oldFile.file,
          patch,
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
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  parseStatus,
  parseGitHubPullRequestUrl,
  readDiffSectionContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readCommitState,
  readPullRequestState,
  readRepositoryState,
  readWorkingTreeState,
  submitPullRequestComment,
  submitPullRequestReview,
  validateRepositoryPath,
};

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import type {
  DiffSection,
  DiffSectionContentRequest,
  RepositoryState,
  ReviewSource,
} from './types.ts';

type StatusEntry = {
  oldPath?: string;
  path: string;
  staged: boolean;
  status: string;
  unstaged: boolean;
  untracked: boolean;
};

type GitStateModule = {
  parseStatus: (raw: string) => Array<StatusEntry>;
  readDiffSectionContent: (
    launchPath: string,
    request: DiffSectionContentRequest,
  ) => Promise<DiffSection>;
  readRepositoryChangeSignature: (
    launchPath: string,
  ) => Promise<{ root: string; signature: string }>;
  readRepositoryState: (launchPath: string, source?: ReviewSource) => Promise<RepositoryState>;
  readWorkingTreeState: (launchPath: string) => Promise<RepositoryState>;
};

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const {
  parseStatus,
  readDiffSectionContent,
  readRepositoryChangeSignature,
  readRepositoryState,
  readWorkingTreeState,
} = require('../electron/git-state.cjs') as GitStateModule;

const git = async (repo: string, args: ReadonlyArray<string>) => {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 16,
  });
  return stdout;
};

const createRepo = async () => {
  const repo = await mkdtemp(join(tmpdir(), 'codiff-git-state-'));
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'codiff@example.com']);
  await git(repo, ['config', 'user.name', 'Codiff Test']);
  return realpath(repo);
};

const writeRepoFile = async (repo: string, path: string, contents: string | Uint8Array) => {
  const absolutePath = join(repo, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
};

const commitAll = async (repo: string, message: string) => {
  await git(repo, ['add', '--all']);
  await git(repo, ['commit', '-m', message]);
};

const withRepo = async (run: (repo: string) => Promise<void>) => {
  const repo = await createRepo();
  try {
    await run(repo);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
};

test('parseStatus reads staged rename paths in porcelain v1 -z order', () => {
  expect(parseStatus('R  new.txt\0old.txt\0')).toEqual([
    {
      oldPath: 'old.txt',
      path: 'new.txt',
      staged: true,
      status: 'renamed',
      unstaged: false,
      untracked: false,
    },
  ]);
});

test('parseStatus preserves staged and unstaged flags on the same file', () => {
  expect(parseStatus('MM file.txt\0')).toEqual([
    {
      oldPath: undefined,
      path: 'file.txt',
      staged: true,
      status: 'modified',
      unstaged: true,
      untracked: false,
    },
  ]);
});

test('readWorkingTreeState separates staged and unstaged modifications', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'one\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'file.txt', 'two\n');
    await git(repo, ['add', 'file.txt']);
    await writeRepoFile(repo, 'file.txt', 'three\n');

    const state = await readWorkingTreeState(repo);

    expect(state.root).toBe(repo);
    expect(state.files).toHaveLength(1);
    expect(state.files[0].path).toBe('file.txt');
    expect(state.files[0].status).toBe('modified');
    expect(state.files[0].sections.map((section) => section.kind)).toEqual(['staged', 'unstaged']);
    expect(state.files[0].sections[0].oldFile?.contents).toBe('one\n');
    expect(state.files[0].sections[0].newFile?.contents).toBe('two\n');
    expect(state.files[0].sections[1].oldFile?.contents).toBe('two\n');
    expect(state.files[0].sections[1].newFile?.contents).toBe('three\n');
  });
});

test('readWorkingTreeState reports staged pure renames with old and new paths', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'old.txt', 'same contents\n');
    await commitAll(repo, 'initial commit');
    await git(repo, ['mv', 'old.txt', 'new.txt']);

    const state = await readWorkingTreeState(repo);

    expect(state.files).toHaveLength(1);
    expect(state.files[0].oldPath).toBe('old.txt');
    expect(state.files[0].path).toBe('new.txt');
    expect(state.files[0].status).toBe('renamed');
    expect(state.files[0].sections).toHaveLength(1);
    expect(state.files[0].sections[0].kind).toBe('staged');
    expect(state.files[0].sections[0].oldFile?.name).toBe('old.txt');
    expect(state.files[0].sections[0].oldFile?.contents).toBe('same contents\n');
    expect(state.files[0].sections[0].newFile?.name).toBe('new.txt');
    expect(state.files[0].sections[0].newFile?.contents).toBe('same contents\n');
  });
});

test('readWorkingTreeState reports staged and unstaged deletions', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'staged-delete.txt', 'staged\n');
    await writeRepoFile(repo, 'unstaged-delete.txt', 'unstaged\n');
    await commitAll(repo, 'initial commit');
    await git(repo, ['rm', 'staged-delete.txt']);
    await rm(join(repo, 'unstaged-delete.txt'));

    const state = await readWorkingTreeState(repo);
    const stagedDelete = state.files.find((file) => file.path === 'staged-delete.txt');
    const unstagedDelete = state.files.find((file) => file.path === 'unstaged-delete.txt');

    expect(stagedDelete?.status).toBe('deleted');
    expect(stagedDelete?.sections).toHaveLength(1);
    expect(stagedDelete?.sections[0].kind).toBe('staged');
    expect(stagedDelete?.sections[0].oldFile?.contents).toBe('staged\n');
    expect(stagedDelete?.sections[0].newFile?.contents).toBe('');

    expect(unstagedDelete?.status).toBe('deleted');
    expect(unstagedDelete?.sections).toHaveLength(1);
    expect(unstagedDelete?.sections[0].kind).toBe('unstaged');
    expect(unstagedDelete?.sections[0].oldFile?.contents).toBe('unstaged\n');
    expect(unstagedDelete?.sections[0].newFile?.contents).toBe('');
  });
});

test('readWorkingTreeState reports untracked text and binary files', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'tracked.txt', 'tracked\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'notes/new.txt', 'untracked\n');
    await writeRepoFile(repo, 'raw.bin', Uint8Array.from([0, 1, 2, 3]));

    const state = await readWorkingTreeState(repo);
    const textFile = state.files.find((file) => file.path === 'notes/new.txt');
    const binaryFile = state.files.find((file) => file.path === 'raw.bin');

    expect(textFile?.status).toBe('untracked');
    expect(textFile?.sections).toHaveLength(1);
    expect(textFile?.sections[0].kind).toBe('unstaged');
    expect(textFile?.sections[0].binary).toBe(false);
    expect(textFile?.sections[0].oldFile?.contents).toBe('');
    expect(textFile?.sections[0].newFile?.contents).toBe('untracked\n');
    expect(textFile?.sections[0].patch).toContain('new file mode');

    expect(binaryFile?.status).toBe('untracked');
    expect(binaryFile?.sections).toHaveLength(1);
    expect(binaryFile?.sections[0].kind).toBe('unstaged');
    expect(binaryFile?.sections[0].binary).toBe(true);
    expect(binaryFile?.sections[0].newFile).toBeUndefined();
  });
});

test('readWorkingTreeState defers large untracked text files and loads them on demand', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'tracked.txt', 'tracked\n');
    await commitAll(repo, 'initial commit');
    const contents = `${'large line\n'.repeat(30_000)}end\n`;
    await writeRepoFile(repo, 'large.txt', contents);

    const state = await readWorkingTreeState(repo);
    const file = state.files.find((candidate) => candidate.path === 'large.txt');
    const section = file?.sections[0];

    expect(file?.status).toBe('untracked');
    expect(section?.loadState).toBe('deferred');
    expect(section?.newFile).toBeUndefined();
    expect(section?.patch).toBe('');

    const loadedSection = await readDiffSectionContent(repo, {
      force: true,
      kind: 'unstaged',
      path: 'large.txt',
    });

    expect(loadedSection.loadState).toBe('ready');
    expect(loadedSection.newFile?.contents).toBe(contents);
    expect(loadedSection.patch).toContain('new file mode');
  });
});

test('readWorkingTreeState summarizes extremely large untracked files', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'tracked.txt', 'tracked\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'huge.txt', 'x'.repeat(2 * 1024 * 1024 + 1));

    const state = await readWorkingTreeState(repo);
    const section = state.files.find((file) => file.path === 'huge.txt')?.sections[0];

    expect(section?.loadState).toBe('too-large');
    expect(section?.summary?.canLoad).toBe(false);
    expect(section?.newFile).toBeUndefined();
    expect(section?.patch).toBe('');
  });
});

test('readWorkingTreeState collapses generated untracked directories', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'tracked.txt', 'tracked\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
    await writeRepoFile(repo, 'packages/app/node_modules/pkg/index.js', 'module.exports = 2;\n');
    await writeRepoFile(repo, 'src/new.ts', 'export const value = 1;\n');

    const state = await readWorkingTreeState(repo);
    const paths = state.files.map((file) => file.path);
    const nodeModules = state.files.find((file) => file.path === 'node_modules');
    const nestedNodeModules = state.files.find((file) => file.path === 'packages/app/node_modules');
    const sourceFile = state.files.find((file) => file.path === 'src/new.ts');

    expect(paths).not.toContain('node_modules/pkg/index.js');
    expect(paths).not.toContain('packages/app/node_modules/pkg/index.js');
    expect(nodeModules?.status).toBe('untracked');
    expect(nodeModules?.sections[0].loadState).toBe('directory');
    expect(nestedNodeModules?.sections[0].loadState).toBe('directory');
    expect(sourceFile?.sections[0].loadState).toBe('ready');
    expect(sourceFile?.sections[0].newFile?.contents).toBe('export const value = 1;\n');
  });
});

test('readWorkingTreeState marks modified binary files as binary sections', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'raw.bin', Uint8Array.from([0, 1, 2, 3]));
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'raw.bin', Uint8Array.from([0, 9, 2, 3]));

    const state = await readWorkingTreeState(repo);

    expect(state.files).toHaveLength(1);
    expect(state.files[0].path).toBe('raw.bin');
    expect(state.files[0].status).toBe('modified');
    expect(state.files[0].sections).toHaveLength(1);
    expect(state.files[0].sections[0].binary).toBe(true);
    expect(state.files[0].sections[0].oldFile).toBeUndefined();
    expect(state.files[0].sections[0].newFile).toBeUndefined();
  });
});

test('readWorkingTreeState reads changed symlinks as link text', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'target-v1.txt', 'target v1 contents\n');
    await writeRepoFile(repo, 'target-v2.txt', 'target v2 contents\n');
    await symlink('target-v1.txt', join(repo, 'link.txt'));
    await commitAll(repo, 'initial commit');
    await rm(join(repo, 'link.txt'));
    await symlink('target-v2.txt', join(repo, 'link.txt'));

    const state = await readWorkingTreeState(repo);
    const link = state.files.find((file) => file.path === 'link.txt');

    expect(link?.status).toBe('modified');
    expect(link?.sections).toHaveLength(1);
    expect(link?.sections[0].oldFile?.contents).toBe('target-v1.txt');
    expect(link?.sections[0].newFile?.contents).toBe('target-v2.txt');
    expect(link?.sections[0].patch).toContain('-target-v1.txt');
    expect(link?.sections[0].patch).toContain('+target-v2.txt');
  });
});

test('readRepositoryChangeSignature changes for unstaged content edits', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'one\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'file.txt', 'two changed\n');

    const before = await readRepositoryChangeSignature(repo);
    await writeRepoFile(repo, 'file.txt', 'three\n');
    const after = await readRepositoryChangeSignature(repo);

    expect(before.root).toBe(repo);
    expect(after.signature).not.toBe(before.signature);
  });
});

test('readRepositoryChangeSignature changes for untracked content edits', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'one\n');

    const before = await readRepositoryChangeSignature(repo);
    await writeRepoFile(repo, 'file.txt', 'two changed\n');
    const after = await readRepositoryChangeSignature(repo);

    expect(after.signature).not.toBe(before.signature);
  });
});

test('readRepositoryState reads commit diffs from short hashes', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'one\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'file.txt', 'two\n');
    await writeRepoFile(repo, 'new.txt', 'created\n');
    await commitAll(repo, 'second commit');
    const commit = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const shortCommit = commit.slice(0, 8);

    const state = await readRepositoryState(repo, {
      ref: shortCommit,
      type: 'commit',
    });

    expect(state.source).toEqual({
      ref: commit,
      type: 'commit',
    });
    expect(state.files.map((file) => file.path).sort()).toEqual(['file.txt', 'new.txt']);
    expect(state.files.every((file) => file.sections[0]?.kind === 'commit')).toBe(true);
    expect(state.files.find((file) => file.path === 'file.txt')?.sections[0].patch).toContain(
      '+two',
    );
  });
});

test('readRepositoryState rejects non-repository launch paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-not-a-repo-'));
  try {
    await expect(readRepositoryState(directory)).rejects.toThrow(/not a git repository/i);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

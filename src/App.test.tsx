import { expect, test } from 'vite-plus/test';
import {
  buildReviewCommentsMarkdown,
  fileHasVisibleDiff,
  getDiffSearchResult,
  getRepositoryLoadError,
  getVisibleDiffSections,
  isDiffSearchShortcut,
  shouldDiscardReviewCommentOnEscape,
} from './App.tsx';
import type { ChangedFile } from './types.ts';

test('pure renames are visible without content hunks', () => {
  const file = {
    fingerprint: 'rename-only',
    oldPath: 'old.txt',
    path: 'new.txt',
    sections: [
      {
        binary: false,
        id: 'new.txt:staged',
        kind: 'staged',
        newFile: {
          contents: 'same contents\n',
          name: 'new.txt',
        },
        oldFile: {
          contents: 'same contents\n',
          name: 'old.txt',
        },
        patch:
          'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n',
      },
    ],
    status: 'renamed',
  } satisfies ChangedFile;

  const visibleSections = getVisibleDiffSections(file, false);

  expect(visibleSections).toHaveLength(1);
  expect(visibleSections[0].fileDiff.hunks).toHaveLength(0);
  expect(fileHasVisibleDiff(file, false)).toBe(true);
});

test('diff search finds content matches across sides', () => {
  const file = {
    fingerprint: 'content-search',
    path: 'src/search.ts',
    sections: [
      {
        binary: false,
        id: 'src/search.ts:unstaged',
        kind: 'unstaged',
        newFile: {
          contents: 'const label = "beta";\nconst value = "needle";\n',
          name: 'src/search.ts',
        },
        oldFile: {
          contents: 'const label = "alpha";\nconst value = "hay";\n',
          name: 'src/search.ts',
        },
        patch: '',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;

  const result = getDiffSearchResult(file, false, 'needle');

  expect(result?.matches).toEqual([
    {
      filePath: 'src/search.ts',
      itemId: 'diff:src/search.ts:unstaged',
      lineNumber: 2,
      side: 'additions',
    },
  ]);
  expect(result?.matchCount).toBe(1);
});

test('diff search includes file path matches', () => {
  const file = {
    fingerprint: 'path-search',
    path: 'src/needle.ts',
    sections: [
      {
        binary: false,
        id: 'src/needle.ts:unstaged',
        kind: 'unstaged',
        newFile: {
          contents: 'same\n',
          name: 'src/needle.ts',
        },
        oldFile: {
          contents: 'different\n',
          name: 'src/needle.ts',
        },
        patch: '',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;

  expect(getDiffSearchResult(file, false, 'needle')?.matches[0]).toEqual({
    filePath: 'src/needle.ts',
    itemId: 'diff:src/needle.ts:unstaged',
  });
});

test('diff search shortcut does not claim fullscreen shortcut', () => {
  const baseEvent = {
    altKey: false,
    key: 'f',
    metaKey: false,
    shiftKey: false,
  };

  expect(isDiffSearchShortcut({ ...baseEvent, ctrlKey: false, metaKey: true }, 'MacIntel')).toBe(
    true,
  );
  expect(isDiffSearchShortcut({ ...baseEvent, ctrlKey: true, metaKey: true }, 'MacIntel')).toBe(
    false,
  );
  expect(isDiffSearchShortcut({ ...baseEvent, ctrlKey: true }, 'Win32')).toBe(true);
  expect(isDiffSearchShortcut({ ...baseEvent, ctrlKey: false, metaKey: true }, 'Win32')).toBe(
    false,
  );
});

test('repository load errors hide raw git output for non-repositories', () => {
  const error = getRepositoryLoadError(
    new Error('Command failed: git -C /tmp rev-parse --show-toplevel fatal: not a git repository'),
  );

  expect(error).toEqual({
    kind: 'not-a-repository',
    message:
      'Codiff was opened outside a Git repository. Run `codiff` from inside a repo, or choose File → Open Folder… to open one.',
  });
});

test('review comment markdown includes file and patch context', () => {
  const file = {
    fingerprint: 'comment-export',
    path: 'src/comment.ts',
    sections: [
      {
        binary: false,
        id: 'src/comment.ts:unstaged',
        kind: 'unstaged',
        newFile: {
          contents: 'const label = "alpha";\nconst value = "needle";\n',
          name: 'src/comment.ts',
        },
        oldFile: {
          contents: 'const label = "alpha";\nconst value = "hay";\n',
          name: 'src/comment.ts',
        },
        patch: '',
      },
    ],
    status: 'modified',
  } satisfies ChangedFile;

  const markdown = buildReviewCommentsMarkdown(
    [file],
    [
      {
        body: 'Please double-check this value.',
        filePath: 'src/comment.ts',
        id: 'comment-1',
        lineNumber: 2,
        sectionId: 'src/comment.ts:unstaged',
        side: 'additions',
      },
    ],
    false,
  );

  expect(markdown).toContain('# Address these Review Comments');
  expect(markdown).toContain('1. **src/comment.ts** (additions line 2)');
  expect(markdown).toContain('Please double-check this value.');
  expect(markdown).toContain('```diff');
  expect(markdown).toContain('+   2 | const value = "needle";');
  expect(markdown.indexOf('```diff')).toBeLessThan(
    markdown.indexOf('Please double-check this value.'),
  );
});

test('escape discards empty review comments without confirmation', () => {
  let confirmationCount = 0;

  expect(
    shouldDiscardReviewCommentOnEscape('   ', () => {
      confirmationCount += 1;
      return false;
    }),
  ).toBe(true);
  expect(confirmationCount).toBe(0);
});

test('escape confirms before discarding review comments with text', () => {
  expect(shouldDiscardReviewCommentOnEscape('Needs work.', () => false)).toBe(false);
  expect(shouldDiscardReviewCommentOnEscape('Needs work.', () => true)).toBe(true);
});

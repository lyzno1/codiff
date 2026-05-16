import {
  parseDiffFromFile,
  parsePatchFiles,
  registerCustomTheme,
  type CodeViewItem,
  type CodeViewOptions,
  type FileDiffMetadata,
} from '@pierre/diffs';
import { CodeView, type CodeViewHandle, WorkerPoolContextProvider } from '@pierre/diffs/react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import dunkelTheme from './themes/dunkel.json' with { type: 'json' };
import lichtTheme from './themes/licht.json' with { type: 'json' };
import type {
  ChangedFile,
  CodiffPreferences,
  DiffSection,
  GitFileStatus,
  RepositoryState,
} from './types.ts';

type CodeViewInstance = NonNullable<ReturnType<CodeViewHandle<undefined>['getInstance']>>;

registerCustomTheme('Licht', async () => lichtTheme as never);
registerCustomTheme('Dunkel', async () => dunkelTheme as never);

const statusLabel: Record<GitFileStatus, string> = {
  added: 'Added',
  deleted: 'Deleted',
  modified: 'Modified',
  renamed: 'Renamed',
  untracked: 'Untracked',
};

const sectionLabel: Record<DiffSection['kind'], string> = {
  commit: 'Commit',
  staged: 'Staged',
  unstaged: 'Unstaged',
};

const statusForTree: Record<
  GitFileStatus,
  'added' | 'deleted' | 'modified' | 'renamed' | 'untracked'
> = {
  added: 'added',
  deleted: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
  untracked: 'untracked',
};

// 11px needed to account for the box shadow around individual diffs
const DEFAULT_PADDING = 11;

const codeViewLayout = {
  // 2px is used to account for a 10px gap with the 1px box shadows
  gap: 12,
  paddingBottom: DEFAULT_PADDING,
  paddingTop: DEFAULT_PADDING,
};

const codeViewItemMetrics = {
  diffHeaderHeight: 54,
};

const workerHighlighterOptions = {
  lineDiffType: 'char' as const,
  maxLineDiffLength: 2000,
  theme: {
    dark: 'Dunkel',
    light: 'Licht',
  },
  tokenizeMaxLineLength: 20_000,
  useTokenTransformer: false,
};

const maxWorkerThreads = 3;

const fileTreeSort = (
  left: { isDirectory: boolean; path: string; segments?: ReadonlyArray<string> },
  right: { isDirectory: boolean; path: string; segments?: ReadonlyArray<string> },
) => compareTreePaths(left.path, right.path);

const defaultPreferences: CodiffPreferences = {
  showWhitespace: false,
};

const codeViewUnsafeCSS = `
  :host {
    --diffs-font-family: var(--font-mono);
    --diffs-header-font-family: var(--font-sans);
    --diffs-font-size: 13px;
    --diffs-line-height: 20px;
    --diffs-light-bg: #ffffff;
    --diffs-dark-bg: #1c1c1c;
  }

  /* Align scrollbar with number column */
  [data-code]::-webkit-scrollbar-track {
    margin-left: var(--diffs-column-number-width);
  }

  /* Ensure right edge of scrollbar never gets cropped by rounded corners */
  [data-file] [data-code]::-webkit-scrollbar-track,
  [data-diff-type="single"] [data-code]::-webkit-scrollbar-track,
  [data-diff-type="split"] [data-code][data-additions]::-webkit-scrollbar-track {
    margin-right: 14px;
  }
`;

const compactPath = (path: string) => {
  const homePath = path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/home\/[^/]+(?=\/|$)/, '~');
  const parts = homePath.split('/').filter(Boolean);

  if (parts.length <= 2) {
    return homePath;
  }

  const prefix = homePath.startsWith('/') ? '/' : '';
  const [first, ...rest] = parts;
  const last = rest.pop();
  const middle = rest.map((part) => part[0]).join('/');

  return `${prefix}${first}/${middle ? `${middle}/` : ''}${last}`;
};

function compareTreePaths(leftPath: string, rightPath: string) {
  const leftParts = leftPath.split('/');
  const rightParts = rightPath.split('/');
  const length = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const left = leftParts[index];
    const right = rightParts[index];
    if (left === right) {
      continue;
    }

    const leftIsDirectory = index < leftParts.length - 1;
    const rightIsDirectory = index < rightParts.length - 1;
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }

    return left.localeCompare(right);
  }

  return leftParts.length - rightParts.length;
}

const sortFiles = (files: ReadonlyArray<ChangedFile>) =>
  [...files].sort((left, right) => compareTreePaths(left.path, right.path));

const fuzzyMatches = (path: string, query: string) => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const normalizedPath = path.toLowerCase();
  let pathIndex = 0;
  for (const character of normalizedQuery) {
    pathIndex = normalizedPath.indexOf(character, pathIndex);
    if (pathIndex === -1) {
      return false;
    }
    pathIndex += 1;
  }
  return true;
};

const getViewedKey = (root: string) => `codiff:viewed:${root}`;

const readViewed = (root: string): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(getViewedKey(root)) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
};

const writeViewed = (root: string, viewed: Record<string, string>) => {
  localStorage.setItem(getViewedKey(root), JSON.stringify(viewed));
};

const getItemId = (section: DiffSection) => `diff:${section.id}`;

const getItemVersion = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash >>> 0;
};

type CodeViewItemMetadata = {
  file: ChangedFile;
  isCollapsed: boolean;
  isSelected: boolean;
  isViewed: boolean;
  section: DiffSection;
  sectionCount: number;
};

const createBinaryFileDiff = (file: ChangedFile, section: DiffSection): FileDiffMetadata => ({
  additionLines: ['Binary file changed\n'],
  cacheKey: `binary:${file.fingerprint}:${section.id}`,
  deletionLines: [],
  hunks: [
    {
      additionCount: 1,
      additionLineIndex: 0,
      additionLines: 1,
      additionStart: 1,
      collapsedBefore: 0,
      deletionCount: 0,
      deletionLineIndex: 0,
      deletionLines: 0,
      deletionStart: 0,
      hunkContent: [
        {
          additionLineIndex: 0,
          additions: 1,
          deletionLineIndex: 0,
          deletions: 0,
          type: 'change',
        },
      ],
      hunkSpecs: '@@ -0,0 +1 @@\n',
      noEOFCRAdditions: false,
      noEOFCRDeletions: false,
      splitLineCount: 1,
      splitLineStart: 0,
      unifiedLineCount: 1,
      unifiedLineStart: 0,
    },
  ],
  isPartial: true,
  name: file.path,
  prevName: file.oldPath,
  splitLineCount: 1,
  type: file.status === 'deleted' ? 'deleted' : file.status === 'added' ? 'new' : 'change',
  unifiedLineCount: 1,
});

const createEmptyFileDiff = (file: ChangedFile, section: DiffSection): FileDiffMetadata => ({
  additionLines: section.newFile?.contents.split('\n') ?? [],
  cacheKey: `empty:${file.fingerprint}:${section.id}`,
  deletionLines: section.oldFile?.contents.split('\n') ?? [],
  hunks: [],
  isPartial: false,
  name: section.newFile?.name ?? file.path,
  prevName: section.oldFile?.name ?? file.oldPath,
  splitLineCount: 0,
  type: file.status === 'deleted' ? 'deleted' : file.status === 'added' ? 'new' : 'change',
  unifiedLineCount: 0,
});

const parsedDiffCache = new Map<string, FileDiffMetadata>();

const parseSectionDiffWithOptions = (
  file: ChangedFile,
  section: DiffSection,
  showWhitespace: boolean,
): FileDiffMetadata => {
  const cacheKey = `${file.fingerprint}:${section.id}:${showWhitespace ? 'ws' : 'ignore-ws'}`;
  const cached = parsedDiffCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let fileDiff: FileDiffMetadata;
  if (section.binary) {
    fileDiff = createBinaryFileDiff(file, section);
  } else if (section.oldFile && section.newFile) {
    try {
      fileDiff = {
        ...parseDiffFromFile(section.oldFile, section.newFile, {
          ignoreWhitespace: !showWhitespace,
        }),
        cacheKey,
      };
    } catch {
      fileDiff = createEmptyFileDiff(file, section);
    }
  } else {
    const parsedFileDiff = parsePatchFiles(section.patch)[0]?.files[0];
    fileDiff = parsedFileDiff
      ? {
          ...parsedFileDiff,
          cacheKey,
        }
      : createBinaryFileDiff(file, section);
  }

  parsedDiffCache.set(cacheKey, fileDiff);
  return fileDiff;
};

const fileHasVisibleDiff = (file: ChangedFile, showWhitespace: boolean) =>
  file.sections.some((section) => {
    if (section.binary) {
      return true;
    }

    return parseSectionDiffWithOptions(file, section, showWhitespace).hunks.length > 0;
  });

const getFirstVisibleSection = (file: ChangedFile, showWhitespace: boolean) =>
  file.sections.find(
    (section) =>
      section.binary || parseSectionDiffWithOptions(file, section, showWhitespace).hunks.length > 0,
  );

function Sidebar({
  files,
  onActivatePath,
  onSearchQueryChange,
  onSelectPath,
  searchQuery,
  selectedPath,
}: {
  files: ReadonlyArray<ChangedFile>;
  onActivatePath: (path: string) => void;
  onSearchQueryChange: (query: string) => void;
  onSelectPath: (path: string) => void;
  searchQuery: string;
  selectedPath: string | null;
}) {
  const allowSelectionScroll = useRef(false);
  const allowSelectionScrollTimer = useRef<number | null>(null);
  const treeHostRef = useRef<HTMLDivElement>(null);
  const suppressSelectionChange = useRef(false);
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const filePathSet = useMemo(() => new Set(paths), [paths]);
  const status = useMemo(
    () =>
      files.map((file) => ({
        path: file.path,
        status: statusForTree[file.status],
      })),
    [files],
  );
  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    gitStatus: status,
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: 30,
    onSelectionChange: (paths) => {
      if (suppressSelectionChange.current) {
        return;
      }

      if (!allowSelectionScroll.current) {
        return;
      }
      allowSelectionScroll.current = false;
      if (allowSelectionScrollTimer.current != null) {
        window.clearTimeout(allowSelectionScrollTimer.current);
        allowSelectionScrollTimer.current = null;
      }

      const path = paths.at(-1);
      if (path) {
        onSelectPath(path);
      }
    },
    paths,
    sort: fileTreeSort,
    unsafeCSS: `
      :host {
        color: var(--sidebar-text);
        font: 13px/1.35 var(--font-sans);
      }

      button[data-type='item'] {
        border-radius: 14px;
        corner-shape: squircle;
      }
    `,
  });

  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(status);
  }, [model, paths, status]);

  const scrollPathIntoView = useCallback(
    (path: string) => {
      model.focusPath(path);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const host = treeHostRef.current?.querySelector('file-tree-container');
          const row = Array.from(
            host?.shadowRoot?.querySelectorAll<HTMLElement>('[data-item-path]') ?? [],
          ).find((element) => element.getAttribute('data-item-path') === path);
          row?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });
        });
      });
    },
    [model],
  );

  const handleTreeClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      for (const target of event.nativeEvent.composedPath()) {
        if (!('getAttribute' in target) || typeof target.getAttribute !== 'function') {
          continue;
        }

        const path = target.getAttribute('data-item-path');
        if (path && filePathSet.has(path)) {
          onActivatePath(path);
          return;
        }
      }
    },
    [filePathSet, onActivatePath],
  );

  useEffect(
    () => () => {
      if (allowSelectionScrollTimer.current != null) {
        window.clearTimeout(allowSelectionScrollTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!selectedPath) {
      return;
    }

    const selectedPaths = model.getSelectedPaths();
    if (selectedPaths.length === 1 && selectedPaths[0] === selectedPath) {
      return;
    }

    suppressSelectionChange.current = true;
    for (const path of selectedPaths) {
      model.getItem(path)?.deselect();
    }
    model.getItem(selectedPath)?.select();
    requestAnimationFrame(() => scrollPathIntoView(selectedPath));
    window.setTimeout(() => {
      suppressSelectionChange.current = false;
    }, 0);
  }, [model, scrollPathIntoView, selectedPath]);

  return (
    <>
      <div className="sidebar-search-row">
        <input
          aria-label="Filter changed files"
          className="sidebar-search"
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
              event.currentTarget.select();
              event.preventDefault();
            }
          }}
          placeholder="Filter files"
          spellCheck={false}
          type="search"
          value={searchQuery}
        />
      </div>
      <div className="file-tree-shell" ref={treeHostRef}>
        <FileTree className="file-tree" model={model} onClick={handleTreeClick} />
      </div>
    </>
  );
}

function CodeViewHeader({
  meta,
  onToggleCollapsed,
  onToggleViewed,
}: {
  meta: CodeViewItemMetadata;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean) => void;
}) {
  const { file, isCollapsed, isSelected, isViewed, section, sectionCount } = meta;

  return (
    <div
      className={`codiff-file-header${isCollapsed ? ' collapsed' : ''}${
        isSelected ? ' selected' : ''
      }${isViewed ? ' viewed' : ''}`}
    >
      <button
        aria-expanded={!isCollapsed}
        aria-label={isCollapsed ? 'Expand file' : 'Collapse file'}
        className="codiff-header-toggle"
        onClick={() => onToggleCollapsed(file, isCollapsed)}
        title={isCollapsed ? 'Expand' : 'Collapse'}
        type="button"
      >
        <span className="codiff-chevron-box">
          <span className={isCollapsed ? 'codiff-chevron collapsed' : 'codiff-chevron'} />
        </span>
        <span className="codiff-file-heading">
          <span className="codiff-file-path">{file.path}</span>
          {file.oldPath ? <span className="codiff-file-old-path">{file.oldPath}</span> : null}
        </span>
        {sectionCount > 1 ? (
          <span className={`codiff-section-badge ${section.kind}`}>
            {sectionLabel[section.kind]}
          </span>
        ) : null}
      </button>
      <div className={`codiff-status-badge ${file.status}`}>{statusLabel[file.status]}</div>
      <button
        aria-pressed={isViewed}
        className={`codiff-viewed-button${isViewed ? ' active' : ''}`}
        onClick={() => onToggleViewed(file, isViewed)}
        type="button"
      >
        <span aria-hidden className="codiff-viewed-checkbox" />
        Viewed
      </button>
    </div>
  );
}

function ReviewCodeView({
  collapsed,
  files,
  itemVersionByPath,
  onSelectPathFromScroll,
  onToggleCollapsed,
  onToggleViewed,
  scrollTarget,
  selectedPath,
  showWhitespace,
  viewed,
}: {
  collapsed: ReadonlySet<string>;
  files: ReadonlyArray<ChangedFile>;
  itemVersionByPath: Readonly<Record<string, number>>;
  onSelectPathFromScroll: (viewer: CodeViewInstance) => void;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean) => void;
  scrollTarget: { path: string; request: number } | null;
  selectedPath: string | null;
  showWhitespace: boolean;
  viewed: Record<string, string>;
}) {
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null);
  const handledScrollRequestRef = useRef<number | null>(null);

  const { firstItemByPath, itemMetadata, items } = useMemo(() => {
    const nextItems: Array<CodeViewItem> = [];
    const nextFirstItemByPath = new Map<string, string>();
    const nextItemMetadata = new Map<string, CodeViewItemMetadata>();

    for (const file of files) {
      const isViewed = viewed[file.path] === file.fingerprint;
      const isCollapsed = collapsed.has(file.path);
      const visibleSections = file.sections
        .map((section) => ({
          fileDiff: parseSectionDiffWithOptions(file, section, showWhitespace),
          section,
        }))
        .filter(({ fileDiff, section }) => section.binary || fileDiff.hunks.length > 0);
      const sections = isCollapsed ? visibleSections.slice(0, 1) : visibleSections;

      for (const [index, { fileDiff, section }] of sections.entries()) {
        const id = getItemId(section);
        nextItemMetadata.set(id, {
          file,
          isCollapsed,
          isSelected: selectedPath === file.path,
          isViewed,
          section,
          sectionCount: file.sections.length,
        });
        nextFirstItemByPath.set(file.path, nextFirstItemByPath.get(file.path) ?? id);
        nextItems.push({
          collapsed: isCollapsed,
          fileDiff,
          id,
          type: 'diff',
          version: getItemVersion(
            `${itemVersionByPath[file.path] ?? 0}:${file.fingerprint}:${section.id}:${
              isCollapsed ? 'collapsed' : 'open'
            }:${isViewed ? 'viewed' : 'pending'}:${index}:${
              selectedPath === file.path ? 'selected' : 'idle'
            }:${showWhitespace ? 'ws' : 'ignore-ws'}`,
          ),
        });
      }
    }

    return {
      firstItemByPath: nextFirstItemByPath,
      itemMetadata: nextItemMetadata,
      items: nextItems,
    };
  }, [collapsed, files, itemVersionByPath, selectedPath, showWhitespace, viewed]);

  const codeViewOptions: CodeViewOptions<undefined> = useMemo(
    () =>
      ({
        diffIndicators: 'bars',
        diffStyle: 'split',
        enableLineSelection: true,
        hunkSeparators: 'simple',
        itemMetrics: codeViewItemMetrics,
        layout: codeViewLayout,
        lineDiffType: 'char',
        stickyHeaders: true,
        theme: {
          dark: 'Dunkel',
          light: 'Licht',
        },
        themeType: 'system',
        tokenizeMaxLength: 100_000,
        unsafeCSS: codeViewUnsafeCSS,
      }) satisfies CodeViewOptions<undefined>,
    [],
  );

  const workerPoolOptions = useMemo(
    () => ({
      poolSize: Math.min(
        maxWorkerThreads,
        Math.max(1, navigator.hardwareConcurrency || maxWorkerThreads),
      ),
      workerFactory: () =>
        new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), {
          type: 'module',
        }),
    }),
    [],
  );

  const scrollItemHeaderIntoView = useCallback((itemId: string) => {
    const handle = codeViewRef.current;
    const viewer = handle?.getInstance();
    if (!handle || !viewer || viewer.getTopForItem(itemId) == null) {
      return false;
    }

    handle.scrollTo({
      behavior: 'instant',
      id: itemId,
      offset: DEFAULT_PADDING,
      type: 'item',
    });

    return true;
  }, []);

  useEffect(() => {
    if (!scrollTarget || handledScrollRequestRef.current === scrollTarget.request) {
      return;
    }

    let frame: number | null = null;
    let attempts = 0;
    let canceled = false;

    const tryScroll = () => {
      if (canceled || handledScrollRequestRef.current === scrollTarget.request) {
        return;
      }

      const itemId = firstItemByPath.get(scrollTarget.path);
      if (itemId && scrollItemHeaderIntoView(itemId)) {
        handledScrollRequestRef.current = scrollTarget.request;
        return;
      }

      if (attempts < 6) {
        attempts += 1;
        frame = window.requestAnimationFrame(tryScroll);
      }
    };

    tryScroll();

    return () => {
      canceled = true;
      if (frame != null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [firstItemByPath, scrollItemHeaderIntoView, scrollTarget]);

  const renderCustomHeader = useCallback(
    (item: CodeViewItem) => {
      const meta = itemMetadata.get(item.id);
      return meta ? (
        <CodeViewHeader
          meta={meta}
          onToggleCollapsed={onToggleCollapsed}
          onToggleViewed={onToggleViewed}
        />
      ) : null;
    },
    [itemMetadata, onToggleCollapsed, onToggleViewed],
  );

  const handleScroll = useCallback(
    (_scrollTop: number, viewer: CodeViewInstance) => {
      onSelectPathFromScroll(viewer);
    },
    [onSelectPathFromScroll],
  );

  return (
    <WorkerPoolContextProvider
      highlighterOptions={workerHighlighterOptions}
      poolOptions={workerPoolOptions}
    >
      <CodeView
        className="code-view"
        items={items}
        onScroll={handleScroll}
        options={codeViewOptions}
        ref={codeViewRef}
        renderCustomHeader={renderCustomHeader}
      />
    </WorkerPoolContextProvider>
  );
}

export default function App() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [itemVersionByPath, setItemVersionByPath] = useState<Record<string, number>>({});
  const [preferences, setPreferences] = useState<CodiffPreferences>(defaultPreferences);
  const [scrollTarget, setScrollTarget] = useState<{ path: string; request: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [state, setState] = useState<RepositoryState | null>(null);
  const [viewed, setViewed] = useState<Record<string, string>>({});
  const programmaticScrollPathRef = useRef<string | null>(null);
  const programmaticScrollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let canceled = false;

    window.codiff
      .getRepositoryState()
      .then((nextState) => {
        if (canceled) {
          return;
        }

        const orderedState = {
          ...nextState,
          files: sortFiles(nextState.files),
        };
        const nextViewed = readViewed(orderedState.root);

        setState(orderedState);
        setError(null);
        setCollapsed(
          new Set(
            orderedState.files
              .filter((file) => nextViewed[file.path] === file.fingerprint)
              .map((file) => file.path),
          ),
        );
        setItemVersionByPath({});
        setViewed(nextViewed);
        setSelectedPath((current) => current ?? orderedState.files[0]?.path ?? null);
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    let canceled = false;

    window.codiff.getPreferences().then((nextPreferences) => {
      if (!canceled) {
        setPreferences(nextPreferences);
      }
    });

    const removeListener = window.codiff.onPreferencesChanged((nextPreferences) => {
      setPreferences(nextPreferences);
    });

    return () => {
      canceled = true;
      removeListener();
    };
  }, []);

  useEffect(
    () => () => {
      if (programmaticScrollTimerRef.current != null) {
        window.clearTimeout(programmaticScrollTimerRef.current);
      }
    },
    [],
  );

  const showWhitespace = preferences.showWhitespace;
  const visibleFiles = useMemo(
    () =>
      state
        ? sortFiles(state.files).filter(
            (file) =>
              fuzzyMatches(file.path, searchQuery) && fileHasVisibleDiff(file, showWhitespace),
          )
        : [],
    [searchQuery, showWhitespace, state],
  );

  const selectPath = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const activatePath = useCallback((path: string) => {
    setSelectedPath(path);
    setScrollTarget((current) => ({
      path,
      request: (current?.request ?? 0) + 1,
    }));
    programmaticScrollPathRef.current = path;
    if (programmaticScrollTimerRef.current != null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }

    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollPathRef.current = null;
      programmaticScrollTimerRef.current = null;
    }, 1200);
  }, []);

  const bumpItemVersion = useCallback((path: string) => {
    setItemVersionByPath((current) => ({
      ...current,
      [path]: (current[path] ?? 0) + 1,
    }));
  }, []);

  const toggleCollapsed = useCallback(
    (file: ChangedFile, isCollapsed: boolean) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (isCollapsed) {
          next.delete(file.path);
        } else {
          next.add(file.path);
        }
        return next;
      });
      bumpItemVersion(file.path);
    },
    [bumpItemVersion],
  );

  const updateSelectedPathFromScroll = useCallback(
    (viewer: CodeViewInstance) => {
      if (!visibleFiles.length) {
        return;
      }

      const scrollTop = viewer.getScrollTop();
      const activationTop = scrollTop + DEFAULT_PADDING;
      let nextPath = visibleFiles[0]?.path ?? null;
      let nextDistance = Number.NEGATIVE_INFINITY;

      for (const file of visibleFiles) {
        const section = getFirstVisibleSection(file, showWhitespace);
        const itemId = section ? getItemId(section) : null;
        const itemTop = itemId ? viewer.getTopForItem(itemId) : undefined;
        if (itemTop == null) {
          continue;
        }

        const distance = itemTop - activationTop;
        if (distance <= 0 && distance > nextDistance) {
          nextDistance = distance;
          nextPath = file.path;
        }
      }

      const programmaticScrollPath = programmaticScrollPathRef.current;
      if (programmaticScrollPath && nextPath !== programmaticScrollPath) {
        return;
      }

      if (programmaticScrollPath) {
        programmaticScrollPathRef.current = null;
        if (programmaticScrollTimerRef.current != null) {
          window.clearTimeout(programmaticScrollTimerRef.current);
          programmaticScrollTimerRef.current = null;
        }
      }

      if (nextPath) {
        setSelectedPath((current) => (current === nextPath ? current : nextPath));
      }
    },
    [showWhitespace, visibleFiles],
  );

  const toggleViewed = useCallback(
    (file: ChangedFile, isViewed: boolean) => {
      if (!state) {
        return;
      }

      setViewed((current) => {
        if (isViewed) {
          const next = { ...current };
          delete next[file.path];
          writeViewed(state.root, next);
          return next;
        }

        const next = {
          ...current,
          [file.path]: file.fingerprint,
        };
        writeViewed(state.root, next);
        return next;
      });

      setCollapsed((current) => {
        if (isViewed) {
          const next = new Set(current);
          next.delete(file.path);
          return next;
        }

        const next = new Set(current);
        next.add(file.path);
        return next;
      });
      bumpItemVersion(file.path);
    },
    [bumpItemVersion, state],
  );

  if (error) {
    return (
      <main className="empty-state">
        <div className="empty-panel squircle">
          <strong>Unable to read repository</strong>
          <span>{error}</span>
        </div>
      </main>
    );
  }

  if (!state) {
    return <main className="loading">Loading</main>;
  }

  const visibleSelectedPath =
    selectedPath && visibleFiles.some((file) => file.path === selectedPath)
      ? selectedPath
      : (visibleFiles[0]?.path ?? null);

  return (
    <div className="app-shell">
      <aside className="sidebar squircle">
        <div className="sidebar-header">
          <div className="sidebar-path-row">
            <div className="sidebar-path" title={state.root}>
              {compactPath(state.root)}
            </div>
          </div>
        </div>
        <Sidebar
          files={visibleFiles}
          onActivatePath={activatePath}
          onSearchQueryChange={setSearchQuery}
          onSelectPath={selectPath}
          searchQuery={searchQuery}
          selectedPath={visibleSelectedPath}
        />
      </aside>
      <main className="review">
        {state.files.length === 0 ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>No local changes</strong>
              <span>{state.root}</span>
            </div>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>No matching files</strong>
              <span>
                {searchQuery || (showWhitespace ? state.root : 'Whitespace-only changes hidden')}
              </span>
            </div>
          </div>
        ) : (
          <ReviewCodeView
            collapsed={collapsed}
            files={visibleFiles}
            itemVersionByPath={itemVersionByPath}
            onSelectPathFromScroll={updateSelectedPathFromScroll}
            onToggleCollapsed={toggleCollapsed}
            onToggleViewed={toggleViewed}
            scrollTarget={scrollTarget}
            selectedPath={visibleSelectedPath}
            showWhitespace={showWhitespace}
            viewed={viewed}
          />
        )}
      </main>
    </div>
  );
}

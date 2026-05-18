export type DiffSection = {
  binary: boolean;
  id: string;
  kind: 'commit' | 'staged' | 'unstaged';
  loadState?: 'binary' | 'deferred' | 'directory' | 'error' | 'ready' | 'too-large';
  newFile?: {
    cacheKey?: string;
    contents: string;
    name: string;
  };
  oldFile?: {
    cacheKey?: string;
    contents: string;
    name: string;
  };
  patch: string;
  summary?: {
    canLoad?: boolean;
    fileCount?: number;
    limit?: number;
    reason: string;
    size?: number;
  };
};

export type GitFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked';

export type ChangedFile = {
  fingerprint: string;
  oldPath?: string;
  path: string;
  sections: ReadonlyArray<DiffSection>;
  status: GitFileStatus;
};

export type ReviewSource =
  | {
      type: 'working-tree';
    }
  | {
      ref: string;
      type: 'commit';
    };

export type HistoryEntry = {
  committedAt: number;
  parents: ReadonlyArray<string>;
  ref: string;
  subject: string;
};

export type RepositoryHistory = {
  entries: ReadonlyArray<HistoryEntry>;
  root: string;
};

export type RepositoryState = {
  files: ReadonlyArray<ChangedFile>;
  generatedAt: number;
  launchPath: string;
  root: string;
  source: ReviewSource;
};

export type CodiffLaunchOptions = {
  source?: ReviewSource;
  walkthrough: boolean;
};

export type WalkthroughFile = {
  path: string;
  reason: string;
};

export type WalkthroughGroup = {
  files: ReadonlyArray<WalkthroughFile>;
  reason: string;
  title: string;
};

export type Walkthrough = {
  groups: ReadonlyArray<WalkthroughGroup>;
  summary: string;
  version: 1;
};

export type WalkthroughResult =
  | {
      status: 'ready';
      walkthrough: Walkthrough;
    }
  | {
      reason: string;
      status: 'unavailable';
    };

export type GitIdentity = {
  email: string;
  gravatarUrl?: string;
  name: string;
};

export type DiffSectionContentRequest = {
  force?: boolean;
  kind: DiffSection['kind'];
  path: string;
  source?: ReviewSource;
};

export type CodiffPreferences = {
  showWhitespace: boolean;
};

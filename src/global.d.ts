import type {
  CodiffPreferences,
  CodiffLaunchOptions,
  DiffSection,
  DiffSectionContentRequest,
  GitIdentity,
  RepositoryHistory,
  RepositoryState,
  ReviewAssistantRequest,
  ReviewAssistantResult,
  ReviewSource,
  TerminalHelperStatus,
  WalkthroughResult,
} from './types.ts';

declare global {
  interface Window {
    codiff: {
      askReviewAssistant: (request: ReviewAssistantRequest) => Promise<ReviewAssistantResult>;
      getDiffSectionContent: (request: DiffSectionContentRequest) => Promise<DiffSection>;
      getGitIdentity: () => Promise<GitIdentity>;
      getLaunchOptions: () => Promise<CodiffLaunchOptions>;
      getPreferences: () => Promise<CodiffPreferences>;
      getRepositoryHistory: (limit?: number) => Promise<RepositoryHistory>;
      getRepositoryState: (source?: ReviewSource) => Promise<RepositoryState>;
      getTerminalHelperStatus: () => Promise<TerminalHelperStatus>;
      getWalkthrough: (source?: ReviewSource) => Promise<WalkthroughResult>;
      installTerminalHelper: () => Promise<TerminalHelperStatus>;
      onFindInDiffs: (callback: () => void) => () => void;
      onPreferencesChanged: (callback: (preferences: CodiffPreferences) => void) => () => void;
      onRepositoryChanged: (callback: (change: { root: string }) => void) => () => void;
      openFile: (path: string) => Promise<void>;
      showInFolder: (path: string) => Promise<void>;
    };
  }
}

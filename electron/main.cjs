// @ts-check

const { execFile, execFileSync } = require('node:child_process');
const {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join, relative, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseArgs } = require('node:util');
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
} = require('electron');
const squirrelStartup = require('electron-squirrel-startup');
const {
  listRepositoryHistory,
  readGitIdentity,
  readDiffSectionContent,
  readRepositoryChangeSignature,
  readRepositoryState,
  submitPullRequestComment,
  submitPullRequestReview,
  validateRepositoryPath,
} = require('./git-state.cjs');
const {
  DEFAULT_OPENAI_MODEL,
  FALLBACK_OPENAI_MODEL,
  normalizeOpenAIModel,
  OPENAI_MODELS,
} = require('./codex.cjs');
const { readReviewAssistantReply } = require('./review-assist.cjs');
const {
  findMatchingWindowIdentity,
  getWindowIdentity,
  getWindowIdentityForSource,
} = require('./window-identity.cjs');
const { createPendingCommentsClipboardController } = require('./pending-comments.cjs');
const { readWalkthrough } = require('./walkthrough.cjs');

/**
 * @typedef {import('../src/types.ts').CodiffLaunchOptions} CodiffLaunchOptions
 * @typedef {import('../src/types.ts').CodiffPreferences} CodiffPreferences
 * @typedef {import('../src/types.ts').CodiffTheme} CodiffTheme
 * @typedef {import('../src/types.ts').ReviewSource} ReviewSource
 * @typedef {{key: string; repositoryRoot: string; sourceKey: string}} WindowIdentity
 * @typedef {{direction: string; name: string; owner: string; repo: string}} GitHubRemote
 * @typedef {{repositoryPath?: string; launchOptions?: CodiffLaunchOptions}} SingleInstanceAdditionalData
 * @typedef {{changed: boolean; checking: boolean; interval?: ReturnType<typeof setInterval>; signature?: string}} RepositoryWatcher
 * @typedef {{args: Array<string>; command: string}} EditorCommand
 * @typedef {{launchOptions: CodiffLaunchOptions; pullRequestNumber: number | null; repositoryPath: string | null}} ParsedCommandLineArguments
 */

const root = dirname(__dirname);
/** @type {Map<number, RepositoryWatcher>} */
const repositoryWatchers = new Map();
/** @type {Map<number, WindowIdentity | null>} */
const windowIdentities = new Map();
/** @type {Map<number, string>} */
const windowRepositories = new Map();
/** @type {Map<number, CodiffLaunchOptions>} */
const windowLaunchOptions = new Map();
const pendingCommentsClipboardController = createPendingCommentsClipboardController({ clipboard });
/** @type {CodiffPreferences} */
let preferences = {
  copyCommentsOnClose: false,
  openAIModel: DEFAULT_OPENAI_MODEL,
  showWhitespace: false,
  theme: 'system',
};

const commitHashPattern = /^[0-9a-f]{4,64}$/i;
const pullRequestNumberPattern = /^#([1-9]\d*)$/;

/** @param {string} arg */
const isCommitHashArgument = (arg) => commitHashPattern.test(arg) && !existsSync(resolve(arg));

/** @param {string} arg */
const parsePullRequestNumberArgument = (arg) => {
  const match = arg.match(pullRequestNumberPattern);
  return match ? Number(match[1]) : null;
};

/** @param {string} value */
const parsePullRequestNumberValue = (value) => {
  const normalized = value.startsWith('#') ? value : `#${value}`;
  return parsePullRequestNumberArgument(normalized);
};

/** @param {string} arg */
const isPullRequestMarkerArgument = (arg) => /^(?:pr|pull-request)$/i.test(arg);

/** @param {string} arg */
const isPullRequestUrlArgument = (arg) => {
  try {
    const url = new URL(arg);
    return (
      url.hostname.toLowerCase() === 'github.com' &&
      /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
};

/** @param {string} value @returns {{owner: string; repo: string} | null} */
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

/** @param {string} repositoryPath @returns {Array<GitHubRemote>} */
const readGitHubRemotes = (repositoryPath) => {
  const repoRoot = execFileSync('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const raw = execFileSync('git', ['-C', repoRoot, 'remote', '-v'], { encoding: 'utf8' });
  /** @type {Array<GitHubRemote>} */
  const remotes = [];

  for (const line of raw.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    const remote = match ? parseGitHubRemoteUrl(match[2]) : null;
    if (remote && match) {
      remotes.push({
        direction: match[3],
        name: match[1],
        ...remote,
      });
    }
  }

  return remotes;
};

/** @param {ReadonlyArray<GitHubRemote>} remotes */
const selectGitHubRemote = (remotes) =>
  [...remotes].sort((left, right) => {
    /** @param {GitHubRemote} remote */
    const getPriority = (remote) =>
      remote.name === 'origin'
        ? remote.direction === 'fetch'
          ? 0
          : 1
        : remote.direction === 'fetch'
          ? 2
          : 3;
    return getPriority(left) - getPriority(right);
  })[0] ?? null;

/** @param {string} repositoryPath @param {number} number */
const resolvePullRequestUrl = (repositoryPath, number) => {
  let remotes;
  try {
    remotes = readGitHubRemotes(repositoryPath);
  } catch {
    throw new Error(
      `Could not resolve PR #${number}. Run codiff from inside a GitHub repository or pass a full GitHub pull request URL.`,
    );
  }

  const remote = selectGitHubRemote(remotes);
  if (!remote) {
    throw new Error(
      `Could not resolve PR #${number} because this repository has no GitHub remote.`,
    );
  }

  return `https://github.com/${remote.owner}/${remote.repo}/pull/${number}`;
};

/** @param {ReadonlyArray<string>} [commandLine] @returns {ParsedCommandLineArguments} */
const parseCommandLineArguments = (commandLine = process.argv) => {
  const args = commandLine.slice(process.defaultApp ? 2 : 1);
  const useEnvironment = commandLine === process.argv;
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
  let pullRequestNumber = null;
  let pullRequestUrl = null;
  let repositoryPath = null;

  for (let index = 0; index < positionals.length; index += 1) {
    const arg = positionals[index];
    if (!pullRequestUrl && isPullRequestUrlArgument(arg)) {
      pullRequestUrl = arg;
      continue;
    }

    if (!pullRequestUrl && pullRequestNumber == null) {
      const number = parsePullRequestNumberArgument(arg);
      if (number != null) {
        pullRequestNumber = number;
        continue;
      }

      const nextNumber = isPullRequestMarkerArgument(arg)
        ? parsePullRequestNumberValue(positionals[index + 1] ?? '')
        : null;
      if (nextNumber != null) {
        pullRequestNumber = nextNumber;
        index += 1;
        continue;
      }
    }

    if (!commitRef && isCommitHashArgument(arg)) {
      commitRef = arg;
    } else if (repositoryPath == null) {
      repositoryPath = arg;
    }
  }

  const envCommitRef = useEnvironment ? process.env.CODIFF_COMMIT_REF || '' : '';
  const envPullRequestNumber = useEnvironment
    ? parsePullRequestNumberValue(process.env.CODIFF_PULL_REQUEST_NUMBER || '')
    : null;
  const envPullRequestUrl = useEnvironment ? process.env.CODIFF_PULL_REQUEST_URL || '' : '';
  const sourcePullRequestNumber = envPullRequestNumber ?? pullRequestNumber;
  const sourceRef = envCommitRef || commitRef;
  const sourcePullRequestUrl = envPullRequestUrl || pullRequestUrl;
  const repositoryPathProvided = Boolean(
    repositoryPath || (useEnvironment && process.env.CODIFF_REPOSITORY_PATH),
  );
  return {
    launchOptions: {
      repositoryPathProvided,
      source: sourcePullRequestUrl
        ? {
            type: 'pull-request',
            url: sourcePullRequestUrl,
          }
        : sourceRef && sourcePullRequestNumber == null
          ? {
              ref: sourceRef,
              type: 'commit',
            }
          : undefined,
      walkthrough:
        (useEnvironment && process.env.CODIFF_WALKTHROUGH === '1') || values.walkthrough === true,
    },
    pullRequestNumber: sourcePullRequestNumber,
    repositoryPath,
  };
};

/** @param {ReadonlyArray<string>} [commandLine] */
const getCommandLineRepositoryPath = (commandLine = process.argv) =>
  parseCommandLineArguments(commandLine).repositoryPath;

/** @param {ReadonlyArray<string>} [commandLine] @param {string} [fallbackPath] @returns {CodiffLaunchOptions} */
const getCommandLineLaunchOptions = (commandLine = process.argv, fallbackPath = process.cwd()) => {
  const { launchOptions, pullRequestNumber, repositoryPath } =
    parseCommandLineArguments(commandLine);
  if (pullRequestNumber == null || launchOptions.source) {
    return launchOptions;
  }

  return {
    ...launchOptions,
    source: {
      type: 'pull-request',
      url: resolvePullRequestUrl(
        resolve(
          (commandLine === process.argv ? process.env.CODIFF_REPOSITORY_PATH : '') ||
            repositoryPath ||
            fallbackPath,
        ),
        pullRequestNumber,
      ),
    },
  };
};

const getLaunchPath = () =>
  resolve(process.env.CODIFF_REPOSITORY_PATH || getCommandLineRepositoryPath() || process.cwd());

const getLaunchOptions = () => getCommandLineLaunchOptions();

const getPreferencesPath = () => join(app.getPath('userData'), 'preferences.json');

/** @param {unknown} theme @returns {CodiffTheme} */
const normalizeTheme = (theme) =>
  theme === 'system' || theme === 'light' || theme === 'dark' ? theme : 'system';

/** @returns {CodiffPreferences} */
const readPreferences = () => {
  try {
    const storedPreferences = JSON.parse(readFileSync(getPreferencesPath(), 'utf8'));
    return {
      ...preferences,
      ...storedPreferences,
      openAIModel: normalizeOpenAIModel(storedPreferences?.openAIModel),
      theme: normalizeTheme(storedPreferences?.theme),
    };
  } catch {
    return preferences;
  }
};

const writePreferences = () => {
  writeFileSync(getPreferencesPath(), JSON.stringify(preferences, null, 2));
};

const sendPreferencesChanged = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('codiff:preferencesChanged', preferences);
    }
  }
};

/** @param {Partial<CodiffPreferences>} nextPreferences */
const updatePreferences = (nextPreferences) => {
  preferences = {
    ...preferences,
    ...nextPreferences,
    openAIModel: normalizeOpenAIModel(nextPreferences.openAIModel ?? preferences.openAIModel),
    theme: normalizeTheme(nextPreferences.theme ?? preferences.theme),
  };
  nativeTheme.themeSource = preferences.theme;
  writePreferences();
  sendPreferencesChanged();
  Menu.setApplicationMenu(buildApplicationMenu());
};

/** @param {string} model */
const selectOpenAIModel = (model) => {
  const openAIModel = normalizeOpenAIModel(model);
  if (preferences.openAIModel === openAIModel) {
    return;
  }

  updatePreferences({ openAIModel });
};

const getCodexOptions = () => ({
  fallbackModel: FALLBACK_OPENAI_MODEL,
  model: preferences.openAIModel,
  /** @param {string} fallbackModel */
  onModelFallback: async (fallbackModel) => {
    updatePreferences({ openAIModel: fallbackModel });
  },
});

/** @param {CodiffTheme} theme */
const updateTheme = (theme) => {
  updatePreferences({ theme });
};

/** @param {string} repositoryPath */
const readRepositoryWatcherSnapshot = async (repositoryPath) => {
  try {
    return await readRepositoryChangeSignature(repositoryPath);
  } catch (error) {
    return {
      root: repositoryPath,
      signature: `error:${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/** @param {number} webContentsId @param {string} repositoryPath */
const resetRepositoryWatcher = async (webContentsId, repositoryPath) => {
  const watcher = repositoryWatchers.get(webContentsId);
  if (!watcher) {
    return;
  }

  const snapshot = await readRepositoryWatcherSnapshot(repositoryPath);
  watcher.changed = false;
  watcher.signature = snapshot.signature;
};

/** @param {import('electron').BrowserWindow} browserWindow @param {string} repositoryPath */
const startRepositoryWatcher = (browserWindow, repositoryPath) => {
  const webContentsId = browserWindow.webContents.id;
  /** @type {RepositoryWatcher} */
  const watcher = {
    changed: false,
    checking: false,
    interval: undefined,
    signature: undefined,
  };
  repositoryWatchers.set(webContentsId, watcher);

  const checkForChanges = async (reset = false) => {
    if (watcher.checking || browserWindow.isDestroyed()) {
      return;
    }

    watcher.checking = true;
    try {
      const snapshot = await readRepositoryWatcherSnapshot(repositoryPath);
      if (reset || watcher.signature == null) {
        watcher.changed = false;
        watcher.signature = snapshot.signature;
        return;
      }

      if (!watcher.changed && watcher.signature !== snapshot.signature) {
        watcher.changed = true;
        browserWindow.webContents.send('codiff:repositoryChanged', {
          root: snapshot.root,
        });
      }
    } finally {
      watcher.checking = false;
    }
  };

  void checkForChanges(true);
  watcher.interval = setInterval(() => void checkForChanges(), 2500);
};

/** @param {import('electron').BaseWindow | undefined} browserWindow */
const openRepositoryFolder = async (browserWindow) => {
  const options = {
    properties: /** @type {Array<'openDirectory'>} */ (['openDirectory']),
  };
  const result = browserWindow
    ? await dialog.showOpenDialog(browserWindow, options)
    : await dialog.showOpenDialog(options);

  if (!result.canceled && result.filePaths[0]) {
    focusOrCreateWindow(result.filePaths[0], { repositoryPathProvided: true, walkthrough: false });
  }
};

const getTerminalHelperSourcePath = () =>
  app.isPackaged ? join(process.resourcesPath, 'app/bin/codiff-app') : join(root, 'bin/codiff.js');

const getTerminalHelperTargetPaths = () => [
  '/opt/homebrew/bin/codiff',
  '/usr/local/bin/codiff',
  join(app.getPath('home'), '.local/bin/codiff'),
];

const getPreferredTerminalHelperTargetPath = () => {
  for (const directory of ['/opt/homebrew/bin', '/usr/local/bin']) {
    try {
      if (existsSync(directory)) {
        accessSync(directory, constants.W_OK);
        return join(directory, 'codiff');
      }
    } catch {
      // Keep looking for a writable install location.
    }
  }

  return join(app.getPath('home'), '.local/bin/codiff');
};

/** @param {string} targetPath */
const isInstalledTerminalHelper = (targetPath) => {
  try {
    if (!existsSync(targetPath)) {
      return false;
    }

    const target = lstatSync(targetPath);
    if (!target.isSymbolicLink()) {
      return false;
    }

    return realpathSync(targetPath) === realpathSync(getTerminalHelperSourcePath());
  } catch {
    return false;
  }
};

const getTerminalHelperStatus = () => {
  const installedPath = getTerminalHelperTargetPaths().find((targetPath) =>
    isInstalledTerminalHelper(targetPath),
  );

  return {
    command: 'codiff',
    installed: installedPath != null,
    path: installedPath || getPreferredTerminalHelperTargetPath(),
  };
};

const getWritableHelperDirectory = () => {
  for (const directory of ['/opt/homebrew/bin', '/usr/local/bin']) {
    try {
      if (existsSync(directory)) {
        accessSync(directory, constants.W_OK);
        return directory;
      }
    } catch {
      // Keep looking for a writable install location.
    }
  }

  const localBin = join(app.getPath('home'), '.local/bin');
  mkdirSync(localBin, { recursive: true });
  return localBin;
};

/** @param {import('electron').BaseWindow | undefined | null} browserWindow */
const installTerminalHelper = async (browserWindow) => {
  try {
    const sourcePath = getTerminalHelperSourcePath();
    const targetPath = join(getWritableHelperDirectory(), 'codiff');

    if (!existsSync(sourcePath)) {
      throw new Error(`Could not find terminal helper at ${sourcePath}.`);
    }

    if (existsSync(targetPath)) {
      const target = lstatSync(targetPath);

      if (!target.isSymbolicLink()) {
        throw new Error(`${targetPath} already exists and is not a symlink.`);
      }

      unlinkSync(targetPath);
    }

    symlinkSync(sourcePath, targetPath);

    /** @type {import('electron').MessageBoxOptions} */
    const successMessage = {
      buttons: ['OK'],
      message: `Installed codiff at ${targetPath}.`,
      type: 'info',
    };
    if (browserWindow) {
      await dialog.showMessageBox(browserWindow, successMessage);
    } else {
      await dialog.showMessageBox(successMessage);
    }
    return true;
  } catch (error) {
    /** @type {import('electron').MessageBoxOptions} */
    const errorMessage = {
      buttons: ['OK'],
      detail: error instanceof Error ? error.message : String(error),
      message: 'Could not install the terminal helper.',
      type: 'error',
    };
    if (browserWindow) {
      await dialog.showMessageBox(browserWindow, errorMessage);
    } else {
      await dialog.showMessageBox(errorMessage);
    }
    return false;
  }
};

/** @param {string} command */
const parseEditorCommand = (command) =>
  command.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => part.replace(/^['"]|['"]$/g, '')) ?? [];

/** @param {string} command @param {ReadonlyArray<string>} args */
const runEditorCommand = (command, args) =>
  new Promise((resolveCommand) => {
    execFile(command, args, { windowsHide: true }, (error) => resolveCommand(!error));
  });

/** @param {string} absolutePath @returns {Array<EditorCommand>} */
const getEditorCommands = (absolutePath) => {
  /** @type {Array<EditorCommand>} */
  const commands = [];
  const customEditor = process.env.CODIFF_EDITOR;
  if (customEditor) {
    const [command, ...args] = parseEditorCommand(customEditor);
    if (command) {
      const hasFilePlaceholder = args.some((arg) => arg.includes('{file}'));
      commands.push({
        args:
          args.length > 0
            ? [
                ...args.map((arg) => arg.replaceAll('{file}', absolutePath)),
                ...(hasFilePlaceholder ? [] : [absolutePath]),
              ]
            : [absolutePath],
        command,
      });
    }
  }

  for (const command of ['/opt/homebrew/bin/code', '/usr/local/bin/code', 'code']) {
    commands.push({
      args: ['-g', absolutePath],
      command,
    });
  }

  if (process.platform === 'darwin') {
    commands.push({
      args: ['-a', 'Visual Studio Code', absolutePath],
      command: 'open',
    });
  }

  return commands;
};

/** @param {string} absolutePath */
const openFileInEditor = async (absolutePath) => {
  for (const { args, command } of getEditorCommands(absolutePath)) {
    if (await runEditorCommand(command, args)) {
      return;
    }
  }

  await shell.openPath(absolutePath);
};

/** @returns {Array<import('electron').MenuItemConstructorOptions>} */
const buildOpenAIModelSubmenu = () =>
  OPENAI_MODELS.map((model) => ({
    checked: preferences.openAIModel === model.id,
    click: () => selectOpenAIModel(model.id),
    label: model.label,
    type: 'radio',
  }));

/** @returns {import('electron').Menu} */
const buildApplicationMenu = () =>
  Menu.buildFromTemplate(
    /** @type {Array<import('electron').MenuItemConstructorOptions>} */ ([
      ...(process.platform === 'darwin'
        ? [
            {
              label: 'Codiff',
              submenu: [
                { role: 'about' },
                { type: 'separator' },
                {
                  label: 'OpenAI Model',
                  submenu: buildOpenAIModelSubmenu(),
                },
                { type: 'separator' },
                {
                  click:
                    /** @type {NonNullable<import('electron').MenuItemConstructorOptions['click']>} */ (
                      (_menuItem, browserWindow) => installTerminalHelper(browserWindow)
                    ),
                  label: 'Install Terminal Helper',
                },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          ...(process.platform === 'darwin'
            ? []
            : [
                {
                  label: 'OpenAI Model',
                  submenu: buildOpenAIModelSubmenu(),
                },
                { type: 'separator' },
              ]),
          {
            accelerator: 'CommandOrControl+O',
            click: (_menuItem, browserWindow) => openRepositoryFolder(browserWindow),
            label: 'Open Folder...',
          },
          { type: 'separator' },
          process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          {
            accelerator: 'CommandOrControl+F',
            click: (_menuItem, browserWindow) => {
              if (browserWindow instanceof BrowserWindow) {
                browserWindow.webContents.send('codiff:findInDiffs');
              }
            },
            label: 'Find in Diffs',
          },
        ],
      },
      {
        label: 'View',
        submenu: [
          {
            checked: preferences.showWhitespace,
            click: (menuItem) => {
              updatePreferences({
                showWhitespace: menuItem.checked,
              });
            },
            label: 'Show Whitespace',
            type: 'checkbox',
          },
          {
            checked: preferences.copyCommentsOnClose,
            click: (menuItem) => {
              updatePreferences({
                copyCommentsOnClose: menuItem.checked,
              });
            },
            label: 'Copy Comments on Close',
            type: 'checkbox',
          },
          {
            label: 'Theme',
            submenu: [
              {
                checked: preferences.theme === 'system',
                click: () => updateTheme('system'),
                label: 'Match System',
                type: 'radio',
              },
              {
                checked: preferences.theme === 'light',
                click: () => updateTheme('light'),
                label: 'Light',
                type: 'radio',
              },
              {
                checked: preferences.theme === 'dark',
                click: () => updateTheme('dark'),
                label: 'Dark',
                type: 'radio',
              },
            ],
          },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          { role: 'reload' },
          {
            accelerator: 'CommandOrControl+Alt+J',
            click: (_menuItem, browserWindow) => {
              if (browserWindow instanceof BrowserWindow) {
                browserWindow.webContents.toggleDevTools();
              }
            },
            label: 'Toggle Developer Tools',
          },
        ],
      },
    ]),
  );

let copyingPendingCommentsBeforeQuit = false;
let quitting = false;
let quitAfterCopyingPendingComments = false;

ipcMain.on(
  'codiff:copyPendingCommentsResult',
  pendingCommentsClipboardController.handleCopyPendingCommentsResult,
);

/**
 * @param {string} repositoryPath
 * @param {CodiffLaunchOptions} [launchOptions]
 * @param {WindowIdentity | null} [identity]
 */
const createWindow = (
  repositoryPath,
  launchOptions = { repositoryPathProvided: true, walkthrough: false },
  identity = getWindowIdentity(repositoryPath, launchOptions),
) => {
  const display = screen.getPrimaryDisplay();
  const { height, width } = display.workAreaSize;
  const window = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#ffffff',
    center: true,
    height: Math.max(720, Math.floor(height * 0.86)),
    minHeight: 520,
    minWidth: 880,
    show: false,
    title: `Codiff - ${repositoryPath}`,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 25, y: 24 } } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
    },
    width: Math.max(1120, Math.floor(width * 0.86)),
  });

  const webContentsId = window.webContents.id;
  if (identity) {
    windowIdentities.set(webContentsId, identity);
  }
  windowRepositories.set(webContentsId, repositoryPath);
  windowLaunchOptions.set(webContentsId, launchOptions);
  if (!launchOptions.source) {
    startRepositoryWatcher(window, repositoryPath);
  }
  window.once('ready-to-show', () => window.show());
  let allowClose = false;
  let copyingPendingCommentsBeforeClose = false;
  window.on('close', (event) => {
    if (allowClose || quitting || !preferences.copyCommentsOnClose) {
      return;
    }

    event.preventDefault();
    if (copyingPendingCommentsBeforeClose) {
      return;
    }

    copyingPendingCommentsBeforeClose = true;
    pendingCommentsClipboardController.copyPendingCommentsToClipboard([window]).finally(() => {
      allowClose = true;
      if (!window.isDestroyed()) {
        window.close();
      }
    });
  });
  window.on('closed', () => {
    const watcher = repositoryWatchers.get(webContentsId);
    if (watcher?.interval) {
      clearInterval(watcher.interval);
    }
    repositoryWatchers.delete(webContentsId);
    windowIdentities.delete(webContentsId);
    windowRepositories.delete(webContentsId);
    windowLaunchOptions.delete(webContentsId);
  });

  const rendererURL = process.env.ELECTRON_RENDERER_URL;
  if (rendererURL) {
    window.loadURL(rendererURL);
  } else {
    window.loadURL(pathToFileURL(join(root, 'dist/index.html')).toString());
  }
};

/** @param {import('electron').BrowserWindow} window */
const focusWindow = (window) => {
  if (window.isMinimized()) {
    window.restore();
  }

  if (!window.isVisible()) {
    window.show();
  }

  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  }
  window.focus();
};

/**
 * @param {string} repositoryPath
 * @param {CodiffLaunchOptions} [launchOptions]
 */
const focusOrCreateWindow = (
  repositoryPath,
  launchOptions = { repositoryPathProvided: true, walkthrough: false },
) => {
  const identity = getWindowIdentity(repositoryPath, launchOptions);
  const matchingWebContentsId = findMatchingWindowIdentity(identity, windowIdentities);
  const matchingWindow =
    matchingWebContentsId == null
      ? null
      : BrowserWindow.getAllWindows().find(
          (window) => window.webContents.id === matchingWebContentsId,
        );

  if (matchingWindow) {
    focusWindow(matchingWindow);
    return matchingWindow;
  }

  return createWindow(repositoryPath, launchOptions, identity);
};

const lock =
  !squirrelStartup &&
  app.requestSingleInstanceLock({
    launchOptions: getLaunchOptions(),
    repositoryPath: getLaunchPath(),
  });

if (squirrelStartup || !lock) {
  app.quit();
} else {
  app.setName('Codiff');

  app.on('second-instance', (event, commandLine, workingDirectory, additionalData) => {
    const data = /** @type {SingleInstanceAdditionalData} */ (additionalData || {});
    focusOrCreateWindow(
      resolve(data.repositoryPath || getCommandLineRepositoryPath(commandLine) || workingDirectory),
      data.launchOptions || getCommandLineLaunchOptions(commandLine, workingDirectory),
    );
  });

  app.on('ready', () => {
    preferences = readPreferences();
    nativeTheme.themeSource = preferences.theme;
    Menu.setApplicationMenu(buildApplicationMenu());
    focusOrCreateWindow(getLaunchPath(), getLaunchOptions());
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      focusOrCreateWindow(getLaunchPath(), getLaunchOptions());
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    const windows = BrowserWindow.getAllWindows().filter(
      (window) => !window.isDestroyed() && !window.webContents.isDestroyed(),
    );

    if (preferences.copyCommentsOnClose && !quitAfterCopyingPendingComments && windows.length) {
      event.preventDefault();
      if (copyingPendingCommentsBeforeQuit) {
        return;
      }

      copyingPendingCommentsBeforeQuit = true;
      void pendingCommentsClipboardController
        .copyPendingCommentsToClipboard(windows)
        .finally(() => {
          quitAfterCopyingPendingComments = true;
          quitting = true;
          app.quit();
        });
      return;
    }

    quitting = true;
  });
}

ipcMain.handle('codiff:getRepositoryState', async (event, source) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const state = await readRepositoryState(repositoryPath, source || launchOptions?.source);
  const identity = getWindowIdentityForSource(state.root, state.source);
  if (identity) {
    windowIdentities.set(event.sender.id, identity);
  }
  await resetRepositoryWatcher(event.sender.id, repositoryPath);
  return state;
});

ipcMain.handle(
  'codiff:getLaunchOptions',
  (event) =>
    windowLaunchOptions.get(event.sender.id) || {
      repositoryPathProvided: false,
      walkthrough: false,
    },
);

ipcMain.handle('codiff:getTerminalHelperStatus', () => getTerminalHelperStatus());

ipcMain.handle('codiff:installTerminalHelper', async (event) => {
  await installTerminalHelper(BrowserWindow.fromWebContents(event.sender));
  return getTerminalHelperStatus();
});

ipcMain.handle('codiff:getWalkthrough', async (event, source) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const state = await readRepositoryState(repositoryPath, source || launchOptions?.source);
  return readWalkthrough(state, getCodexOptions());
});

ipcMain.handle('codiff:askReviewAssistant', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const launchOptions = windowLaunchOptions.get(event.sender.id);
  const state = await readRepositoryState(repositoryPath, request?.source || launchOptions?.source);
  return readReviewAssistantReply(state, request, getCodexOptions());
});

ipcMain.handle('codiff:submitPullRequestComment', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return submitPullRequestComment(repositoryPath, request);
});

ipcMain.handle('codiff:submitPullRequestReview', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return submitPullRequestReview(repositoryPath, request);
});

ipcMain.handle('codiff:getDiffSectionContent', async (event, request) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return readDiffSectionContent(repositoryPath, request);
});

ipcMain.handle('codiff:getRepositoryHistory', async (event, limit) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return listRepositoryHistory(repositoryPath, limit);
});

ipcMain.handle('codiff:getGitIdentity', async (event) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  return readGitIdentity(repositoryPath);
});

ipcMain.handle('codiff:getPreferences', () => preferences);

ipcMain.handle('codiff:openFile', async (event, filePath) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const state = await readRepositoryState(repositoryPath);
  const repositoryFilePath = validateRepositoryPath(filePath);
  const absolutePath = resolve(state.root, repositoryFilePath);

  if (existsSync(absolutePath)) {
    await openFileInEditor(absolutePath);
  } else {
    await shell.openPath(state.root);
  }
});

ipcMain.handle('codiff:showInFolder', async (event, filePath) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const state = await readRepositoryState(repositoryPath);
  const repositoryFilePath = validateRepositoryPath(filePath);
  const absolutePath = resolve(state.root, repositoryFilePath);

  if (existsSync(absolutePath)) {
    shell.showItemInFolder(absolutePath);
  } else {
    shell.openPath(state.root);
  }
});

ipcMain.handle('codiff:getRelativePath', async (event, filePath) => {
  const repositoryPath = windowRepositories.get(event.sender.id) || getLaunchPath();
  const state = await readRepositoryState(repositoryPath);
  return relative(state.root, filePath);
});

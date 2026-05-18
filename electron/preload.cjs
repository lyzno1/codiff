const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codiff', {
  askReviewAssistant: (request) => ipcRenderer.invoke('codiff:askReviewAssistant', request),
  getDiffSectionContent: (request) => ipcRenderer.invoke('codiff:getDiffSectionContent', request),
  getGitIdentity: () => ipcRenderer.invoke('codiff:getGitIdentity'),
  getLaunchOptions: () => ipcRenderer.invoke('codiff:getLaunchOptions'),
  getPreferences: () => ipcRenderer.invoke('codiff:getPreferences'),
  getRepositoryHistory: (limit) => ipcRenderer.invoke('codiff:getRepositoryHistory', limit),
  getRepositoryState: (source) => ipcRenderer.invoke('codiff:getRepositoryState', source),
  getTerminalHelperStatus: () => ipcRenderer.invoke('codiff:getTerminalHelperStatus'),
  getWalkthrough: (source) => ipcRenderer.invoke('codiff:getWalkthrough', source),
  installTerminalHelper: () => ipcRenderer.invoke('codiff:installTerminalHelper'),
  onFindInDiffs: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('codiff:findInDiffs', listener);
    return () => ipcRenderer.removeListener('codiff:findInDiffs', listener);
  },
  onPreferencesChanged: (callback) => {
    const listener = (_event, preferences) => callback(preferences);
    ipcRenderer.on('codiff:preferencesChanged', listener);
    return () => ipcRenderer.removeListener('codiff:preferencesChanged', listener);
  },
  onRepositoryChanged: (callback) => {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('codiff:repositoryChanged', listener);
    return () => ipcRenderer.removeListener('codiff:repositoryChanged', listener);
  },
  openFile: (path) => ipcRenderer.invoke('codiff:openFile', path),
  showInFolder: (path) => ipcRenderer.invoke('codiff:showInFolder', path),
});

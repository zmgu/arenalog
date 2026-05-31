const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowClose: () => ipcRenderer.send('window-close'),

  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),

  getCompletedChampions: (puuid) => ipcRenderer.invoke('get-completed-champions', puuid),
  applyChampionChanges: (puuid, toAdd, toDelete) => ipcRenderer.invoke('apply-champion-changes', puuid, toAdd, toDelete),
  markChampionCompleted: (puuid, id, nameKo, nameEn) => ipcRenderer.invoke('mark-champion-completed', puuid, id, nameKo, nameEn),

  validateSummoner: (gameName, tagLine) => ipcRenderer.invoke('validate-summoner', gameName, tagLine),
  fetchSummonerByPuuid: (puuid) => ipcRenderer.invoke('fetch-summoner-by-puuid', puuid),
  fetchAccountByPuuid: (puuid) => ipcRenderer.invoke('fetch-account-by-puuid', puuid),
  fetchMatchIds: (puuid, count, startTime) => ipcRenderer.invoke('fetch-match-ids', puuid, count, startTime),
  fetchMatchDetail: (matchId) => ipcRenderer.invoke('fetch-match-detail', matchId),
  getCachedMatchesBulk: (ids) => ipcRenderer.invoke('get-cached-matches-bulk', ids),
  getAllCachedMatches: (puuid) => ipcRenderer.invoke('get-all-cached-matches', puuid),
  saveCachedMatches: (entries) => ipcRenderer.invoke('save-cached-matches', entries),

  resetData: () => ipcRenderer.invoke('reset-data'),
  fetchUrlBase64: (url) => ipcRenderer.invoke('fetch-url-base64', url),
  fetchUrlJson: (url) => ipcRenderer.invoke('fetch-url-json', url),
  validateApiKey: (key) => ipcRenderer.invoke('validate-api-key', key),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  log: (...args) => ipcRenderer.send('renderer-log', ...args),
});

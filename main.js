const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const axios = require('axios');

// ── URL allowlist (SSRF 방지) ──────────────────────────────────────────────
const ALLOWED_FETCH_HOSTS = new Set([
  'ddragon.leagueoflegends.com',
  'raw.communitydragon.org',
]);

function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL: ' + url); }
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS allowed');
  if (parsed.port !== '') throw new Error('Non-standard port not allowed');
  if (!ALLOWED_FETCH_HOSTS.has(parsed.hostname)) throw new Error(`허용되지 않은 호스트: ${parsed.hostname}`);
}

// ── Match cache limit ──────────────────────────────────────────────────────
const MAX_CACHE_ENTRIES = 200;

async function writeJSONAsync(file, data) {
  await fs.promises.writeFile(file, JSON.stringify(data), 'utf8');
}

let mainWindow;
let dataDir;
let championsFile;
let settingsFile;

// ── JSON-based persistence ─────────────────────────────────────────────────
function readJSON(file, defaultVal) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return defaultVal; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

let _settingsCache = null;
function getSettings() {
  if (!_settingsCache) _settingsCache = readJSON(settingsFile, {});
  return _settingsCache;
}
function getChampions() { return readJSON(championsFile, {}); }

let matchCacheFile;

function initStorage() {
  dataDir = app.getPath('userData');
  championsFile  = path.join(dataDir, 'champions.json');
  settingsFile   = path.join(dataDir, 'settings.json');
  matchCacheFile = path.join(dataDir, 'match_cache.json');
  if (!fs.existsSync(championsFile))  writeJSON(championsFile, {});
  if (!fs.existsSync(settingsFile))   writeJSON(settingsFile, {});
  if (!fs.existsSync(matchCacheFile)) writeJSON(matchCacheFile, {});
  migrateChampionsJson();
}

// puuid 없이 루트 레벨에 저장된 구버전 데이터를 현재 계정 아래로 이전
function migrateChampionsJson() {
  const data = readJSON(championsFile, {});
  // puuid는 40자 이상, 챔피언 ID는 최대 20자 이하로 구분
  const flatKeys = Object.keys(data).filter(k => {
    if (k.length > 30) return false;          // 긴 키는 puuid → 건드리지 않음
    const v = data[k];
    return v && typeof v === 'object' && 'isCompleted' in v; // 평면 챔피언 형식
  });
  if (!flatKeys.length) return;

  const settings = readJSON(settingsFile, {});
  const puuid = settings.puuid;

  if (puuid && puuid.length > 30) {
    // 현재 계정에 없는 항목만 이전 (이미 있으면 현재 계정 데이터 우선)
    if (!data[puuid]) data[puuid] = {};
    for (const key of flatKeys) {
      if (!data[puuid][key]) data[puuid][key] = data[key];
      delete data[key];
    }
  } else {
    // 로그인된 계정 없으면 고립 데이터 삭제
    for (const key of flatKeys) delete data[key];
  }

  writeJSON(championsFile, data);
}

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 660,
    resizable: false,
    frame: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#00000000',
    show: false,
    icon: path.join(__dirname, 'assets/icon.png'),
  });
  mainWindow.loadFile('renderer/index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (_, input) => {
      if (input.control && input.shift && input.key === 'I') mainWindow.webContents.openDevTools();
    });
  }
}

app.whenReady().then(() => {
  initStorage();
  createWindow();
});
app.on('window-all-closed', () => app.quit());

ipcMain.on('renderer-log', (_, ...args) => console.log('[renderer]', ...args));

// ── Window controls ────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-close',    () => mainWindow.close());

// ── Settings IPC ──────────────────────────────────────────────────────────
ipcMain.handle('get-setting', (_, key) => {
  return getSettings()[key] ?? null;
});
const ALLOWED_SETTING_KEYS = new Set(['summoner_name', 'tag_line', 'puuid', 'last_sync_at', 'riot_api_key']);

ipcMain.handle('set-setting', (_, key, value) => {
  if (!ALLOWED_SETTING_KEYS.has(key)) return;
  const s = getSettings();
  s[key] = value;
  _settingsCache = s;
  writeJSON(settingsFile, s);
});

// ── Champions IPC ──────────────────────────────────────────────────────────
ipcMain.handle('get-completed-champions', (_, puuid) => {
  const data = getChampions();
  const userData = data[puuid] || {};
  return Object.entries(userData)
    .filter(([, v]) => v.isCompleted)
    .map(([id, v]) => ({ champion_id: id, ...v }));
});

ipcMain.handle('apply-champion-changes', (_, puuid, toAdd, toDelete) => {
  const data = getChampions();
  if (!data[puuid]) data[puuid] = {};
  const now = new Date().toISOString();
  for (const c of toAdd) {
    data[puuid][c.id] = { champion_name_ko: c.nameKo, champion_name_en: c.nameEn, isCompleted: true, source: 'manual', completed_at: now };
  }
  for (const c of toDelete) {
    if (data[puuid][c.id]) data[puuid][c.id].isCompleted = false;
  }
  writeJSON(championsFile, data);
});

ipcMain.handle('mark-champion-completed', (_, puuid, championId, nameKo, nameEn) => {
  const data = getChampions();
  if (!data[puuid]) data[puuid] = {};
  if (data[puuid][championId]?.source === 'manual') return;
  data[puuid][championId] = {
    champion_name_ko: nameKo, champion_name_en: nameEn,
    isCompleted: true, source: 'auto', completed_at: new Date().toISOString(),
  };
  writeJSON(championsFile, data);
});

ipcMain.handle('get-all-cached-matches', (_, puuid) => {
  const cache = readJSON(matchCacheFile, {});
  return Object.values(cache).filter(match =>
    match.info?.participants?.some(p => p.puuid === puuid)
  );
});

// ── Riot API IPC ───────────────────────────────────────────────────────────
function getRiotOpts() {
  const key = getSettings().riot_api_key || process.env.RIOT_API_KEY || '';
  return { headers: { 'X-Riot-Token': key }, timeout: 10000 };
}

ipcMain.handle('validate-api-key', async (_, key) => {
  if (!key) return { valid: false };
  try {
    await axios.get(
      'https://kr.api.riotgames.com/lol/status/v4/platform-data',
      { headers: { 'X-Riot-Token': key }, timeout: 8000 }
    );
    return { valid: true };
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401 || status === 403) return { valid: false };
    return { valid: true }; // 404·429 등은 키 자체는 유효
  }
});

ipcMain.handle('open-external', (_, url) => {
  const allowed = /^https:\/\/(developer\.riotgames\.com|auth\.riotgames\.com)/;
  if (allowed.test(url)) shell.openExternal(url);
});

ipcMain.handle('validate-summoner', async (_, gameName, tagLine) => {
  const url = `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  const res = await axios.get(url, getRiotOpts());
  return res.data;
});

ipcMain.handle('fetch-summoner-by-puuid', async (_, puuid) => {
  const url = `https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`;
  const res = await axios.get(url, getRiotOpts());
  return res.data;
});

ipcMain.handle('fetch-account-by-puuid', async (_, puuid) => {
  const url = `https://asia.api.riotgames.com/riot/account/v1/accounts/by-puuid/${encodeURIComponent(puuid)}`;
  const res = await axios.get(url, getRiotOpts());
  return res.data;
});

ipcMain.handle('fetch-match-ids', async (_, puuid, count = 20, startTime = null) => {
  const safeCount = Math.min(Math.max(parseInt(count) || 20, 1), 100);
  const safeStart = startTime != null ? parseInt(startTime) || null : null;
  let url = `https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=${safeCount}`;
  if (safeStart) url += `&startTime=${safeStart}`;
  console.log('[fetch-match-ids] URL:', url);
  try {
    const res = await axios.get(url, getRiotOpts());
    console.log('[fetch-match-ids] count:', res.data.length, '| first:', res.data[0]);
    return res.data;
  } catch (err) {
    console.error('[fetch-match-ids] error:', err?.response?.status, err?.message);
    if (err?.response?.status === 404) return [];
    throw err;
  }
});

// Match detail cache (persisted to disk)
ipcMain.handle('get-cached-matches-bulk', (_, matchIds) => {
  if (!Array.isArray(matchIds)) return {};
  const cache = readJSON(matchCacheFile, {});
  const result = {};
  for (const id of matchIds) {
    if (typeof id === 'string' && /^[A-Z0-9_]{1,32}$/i.test(id) && cache[id]) {
      result[id] = cache[id];
    }
  }
  return result;
});

ipcMain.handle('save-cached-matches', async (_, entries) => {
  if (!Array.isArray(entries)) return;
  const cache = readJSON(matchCacheFile, {});
  for (const { id, data } of entries) {
    // Riot 매치 ID 형식만 허용 (예: KR_1234567890) — prototype 오염 방지
    if (typeof id !== 'string' || !/^[A-Z0-9_]{1,32}$/i.test(id)) continue;
    cache[id] = data;
  }
  // 오래된 항목 정리: 최신 MAX_CACHE_ENTRIES개만 보관
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHE_ENTRIES) {
    const sorted = keys.sort((a, b) => {
      const tA = cache[a]?.info?.gameEndTimestamp || cache[a]?.info?.gameCreation || 0;
      const tB = cache[b]?.info?.gameEndTimestamp || cache[b]?.info?.gameCreation || 0;
      return tB - tA;
    });
    for (const k of sorted.slice(MAX_CACHE_ENTRIES)) delete cache[k];
  }
  await writeJSONAsync(matchCacheFile, cache);
});

ipcMain.handle('fetch-match-detail', async (_, matchId) => {
  if (typeof matchId !== 'string' || !/^[A-Z0-9_]{1,32}$/i.test(matchId)) throw new Error('Invalid matchId');
  const url = `https://asia.api.riotgames.com/lol/match/v5/matches/${matchId}`;
  try {
    const res = await axios.get(url, getRiotOpts());
    console.log(`[fetch-match-detail] OK ${matchId} queueId=${res.data?.info?.queueId}`);
    return res.data;
  } catch (err) {
    console.error(`[fetch-match-detail] FAIL ${matchId} status=${err?.response?.status} msg=${err?.message}`);
    throw err;
  }
});

// ── Asset proxy (avoids CORS in renderer) ────────────────────────────────
ipcMain.handle('reset-data', () => {
  writeJSON(championsFile, {});
  writeJSON(matchCacheFile, {});
  // champions 캐시 초기화 (settings는 유지)
});

ipcMain.handle('fetch-url-base64', async (_, url) => {
  validateUrl(url);
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    validateStatus: s => s === 200,
    maxContentLength: 10 * 1024 * 1024, // 10 MB
  });
  const b64 = Buffer.from(res.data).toString('base64');
  // Content-Type 헤더 조작 방어: image/* 형식만 허용, 그 외는 image/png 고정
  const rawMime = (res.headers['content-type'] || '').split(';')[0].trim();
  const mime = /^image\/[a-zA-Z0-9.+-]{1,20}$/.test(rawMime) ? rawMime : 'image/png';
  return `data:${mime};base64,${b64}`;
});

ipcMain.handle('fetch-url-json', async (_, url) => {
  validateUrl(url);
  const res = await axios.get(url, {
    timeout: 15000,
    maxContentLength: 20 * 1024 * 1024, // 20 MB
  });
  return res.data;
});

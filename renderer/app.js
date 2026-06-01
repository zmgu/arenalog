// ── Utilities ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── State ──────────────────────────────────────────────────────────────────
const ARENA_QUEUE_IDS = new Set([1700, 1750]);
// rarity=4 는 게임 내 효과(화학공학 부패기, 양의 안식처 등)로 일반 증강이 아님
// rarity: 0=실버, 1=골드, 2=프리즘, 4=게임효과(제외)
const AUG_EXCLUDE = new Set(['증강 강화', '증강 슬롯 획득', '증강 교체', '증강 슬롯 추가']);
function isGameEffect(aug) { return (aug?.rarityNum ?? 0) > 2; }

// ── Constants ──────────────────────────────────────────────────────────────
const TOTAL_CHAMPIONS     = 60;
const RECENT_MATCH_WINDOW = 20;
const MAX_FETCH_COUNT     = 100;
const LOADING_TIMEOUT_MS  = 20000;
const EDIT_MAX_PER_ACTION = 10;
const DONUT_RADIUS        = 21;
const TOOLTIP_WIDTH       = 214;
const TOOLTIP_HEIGHT      = 120;
const RANK_COLORS         = ['#c89b3c', '#888888', '#8B6914'];

// 매치 히스토리에서 제외할 아이템 ID (비전 탐지기 계열: 3348 Arcane Sweeper, 3364 Oracle Lens, 3513 Eye of the Herald)
const EXCLUDED_ITEM_IDS = new Set(['3348', '3364', '3513']);

// CDragon 미반영 신규 증강 placeholder
const UNKNOWN_AUGMENT = (id) => ({
  id, name: '알 수 없는 증강', grade: 'silver', rarityNum: 0,
  description: '최신 패치에서 추가된 증강으로 데이터가 아직 업데이트되지 않았습니다.',
  iconSmall: null, iconLarge: null, iconBase64: null,
});

// ── Shared helpers ─────────────────────────────────────────────────────────
const sortByTimestampDesc = (a, b) =>
  (b?.info?.gameEndTimestamp || b?.info?.gameCreation || 0) -
  (a?.info?.gameEndTimestamp || a?.info?.gameCreation || 0);

function parseApiError(err) {
  const status = err?.cause?.status ?? err?.response?.status;
  if (status === 401 || status === 403) return null; // redirectToApiKeyScreen이 처리
  if (status === 429) return 'API Rate Limit 초과. 잠시 후 다시 시도해 주세요.';
  return null;
}

function isApiKeyError(err) {
  const status = err?.cause?.status ?? err?.response?.status;
  return status === 401 || status === 403;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function saveAccountSettings(name, tag, puuid) {
  await window.api.setSetting('summoner_name', name);
  await window.api.setSetting('tag_line', tag);
  await window.api.setSetting('puuid', puuid);
}

function initChampionSets(rows) {
  completedSet = new Set(rows.map(r => r.champion_id));
  manualSet = new Set(rows.filter(r => r.source === 'manual').map(r => r.champion_id));
}

function refreshMatchHistoryView() {
  cache.matchHistory.sort(sortByTimestampDesc);
  renderMatchHistory(cache.matchHistory);
  updateStats();
}

async function fetchMatchesBatch(ids, onBatchDone) {
  const toSave = [];
  let fetched = 0;
  for (let i = 0; i < ids.length; i += HISTORY_CONCURRENCY) {
    const batch = ids.slice(i, i + HISTORY_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(id => window.api.fetchMatchDetail(id)));
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') {
        cache.matchHistory.push(results[j].value);
        toSave.push({ id: batch[j], data: results[j].value });
      }
      fetched++;
    }
    if (onBatchDone) onBatchDone(fetched, ids.length);
    if (i + HISTORY_CONCURRENCY < ids.length) {
      await new Promise(r => setTimeout(r, HISTORY_BATCH_DELAY));
    }
  }
  if (toSave.length) await window.api.saveCachedMatches(toSave);
}

async function redirectToApiKeyScreen() {
  const savedKey = await window.api.getSetting('riot_api_key');
  const el = $('input-apikey');
  if (el) el.value = savedKey || '';
  $('apikey-error-msg').classList.remove('hidden');
  showScreen('apikey');
}

async function scanAndMarkWins(matches, prevCompleted = null) {
  const newWins = [];
  for (const match of matches) {
    if (!ARENA_QUEUE_IDS.has(match?.info?.queueId)) continue;
    const p = match.info.participants?.find(x => x.puuid === cache.puuid);
    if (!p || p.placement !== 1 || completedSet.has(p.championName)) continue;
    if (prevCompleted?.has(p.championName)) continue;
    const champId = p.championName;
    const info = getChampInfo(champId);
    completedSet.add(champId);
    await window.api.markChampionCompleted(cache.puuid, champId, info?.nameKo || champId, info?.nameEn || champId);
    newWins.push(info?.nameKo || champId);
  }
  return newWins;
}

function getChampInfo(id) {
  return cache.champions[id] ?? cache.champions[cache.championsIndex[id?.toLowerCase()]];
}
let completedSet = new Set();   // champion_id strings
let manualSet = new Set();      // 수동 추가된 champion_id strings
let editMode = false;
let editPending = { add: new Set(), del: new Set() };
let tooltipTarget = null;
let historyLoading = false;

// ── DOM shortcuts ──────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const screens = {
  loading: $('screen-loading'),
  apikey:  $('screen-apikey'),
  login:   $('screen-login'),
  main:    $('screen-main'),
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

// ── Window controls ────────────────────────────────────────────────────────
$('btn-minimize').addEventListener('click', () => window.api.windowMinimize());
$('btn-close').addEventListener('click', () => window.api.windowClose());

// ── Account menu dropdown ──────────────────────────────────────────────────
function closeAccountDropdown() {
  $('account-dropdown').classList.add('hidden');
  $('btn-account-menu').classList.remove('open');
}

$('btn-account-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = !$('account-dropdown').classList.contains('hidden');
  if (isOpen) { closeAccountDropdown(); } else {
    $('account-dropdown').classList.remove('hidden');
    $('btn-account-menu').classList.add('open');
  }
});

document.addEventListener('click', (e) => {
  if (!$('account-menu-wrap').contains(e.target)) closeAccountDropdown();
});

// ── Loading helpers ────────────────────────────────────────────────────────
const STEPS = [
  { id: 'step-version',   label: 'Data Dragon 버전 확인' },
  { id: 'step-champions', label: '챔피언 목록 로드' },
  { id: 'step-icons',     label: '챔피언 아이콘 로드' },
  { id: 'step-items',     label: '아이템 데이터 로드' },
  { id: 'step-augments',  label: '증강 데이터 로드' },
];

function renderSteps(activeIdx) {
  const container = $('loading-steps');
  container.innerHTML = STEPS.map((s, i) => {
    let cls = '';
    let icon = '○';
    if (i < activeIdx) { cls = 'done'; icon = '✓'; }
    else if (i === activeIdx) { cls = 'active'; icon = '…'; }
    return `<div class="loading-step ${cls}"><span class="step-icon">${icon}</span>${s.label}</div>`;
  }).join('');
}

function setProgress(pct) {
  $('loading-bar').style.width = pct + '%';
  $('loading-pct').textContent = Math.round(pct) + '%';
}

// ── Initial data load ──────────────────────────────────────────────────────
let loadingTimeoutId = null;

function showLoadingRetry(msg) {
  $('loading-retry-msg').textContent = msg;
  $('loading-retry').style.display = 'block';
}

async function loadAllData() {
  showScreen('loading');
  $('loading-retry').style.display = 'none';
  clearTimeout(loadingTimeoutId);

  loadingTimeoutId = setTimeout(() => {
    showLoadingRetry('로딩이 오래 걸리고 있습니다. 네트워크 상태를 확인해 주세요.');
  }, LOADING_TIMEOUT_MS);

  try {
    renderSteps(0); setProgress(0);

    // Step 0: version
    const versions = await window.api.fetchUrlJson('https://ddragon.leagueoflegends.com/api/versions.json');
    cache.version = versions[0];
    renderSteps(1); setProgress(10);

    // Step 1: champion list
    const champData = await window.api.fetchUrlJson(
      `https://ddragon.leagueoflegends.com/cdn/${cache.version}/data/ko_KR/champion.json`
    );
    const champEntries = Object.values(champData?.data ?? {});
    for (const c of champEntries) {
      cache.champions[c.id] = { nameKo: c.name, nameEn: c.id, iconBase64: null };
      cache.championsIndex[c.id.toLowerCase()] = c.id;
    }
    renderSteps(2); setProgress(20);

    // Step 2: champion icons (batch, concurrent) — 개별 실패 시 placeholder 유지
    await Promise.allSettled(champEntries.map(async (c) => {
      const url = `https://ddragon.leagueoflegends.com/cdn/${cache.version}/img/champion/${c.id}.png`;
      cache.champions[c.id].iconBase64 = await window.api.fetchUrlBase64(url);
    }));
    renderSteps(3); setProgress(50);

    // Step 3: items
    const itemData = await window.api.fetchUrlJson(
      `https://ddragon.leagueoflegends.com/cdn/${cache.version}/data/ko_KR/item.json`
    );
    const itemEntries = Object.entries(itemData?.data ?? {});
    await Promise.allSettled(itemEntries.map(async ([id, item]) => {
      const iconBase64 = await window.api.fetchUrlBase64(
        `https://ddragon.leagueoflegends.com/cdn/${cache.version}/img/item/${id}.png`
      );
      cache.items[id] = { name: item.name, description: item.description, iconBase64 };
    }));
    renderSteps(4); setProgress(75);

    // Step 4: augments (Community Dragon) — metadata only, icons loaded lazily
    const augData = await window.api.fetchUrlJson(
      'https://raw.communitydragon.org/latest/cdragon/arena/ko_kr.json'
    );
    const augList = augData.augments || [];
    const gradeMap = { 0: 'silver', 1: 'gold', 2: 'prismatic' };
    for (const aug of augList) {
      cache.augments[aug.id] = {
        name: aug.name,
        grade: gradeMap[aug.rarity] || 'silver',
        rarityNum: aug.rarity ?? 0,
        description: aug.desc || '',
        dataValues: aug.dataValues || {},
        iconSmall: aug.iconSmall || null,
        iconLarge: aug.iconLarge || null,
        iconBase64: null,
      };
    }
    const FRAME_BASE = 'https://raw.communitydragon.org/latest/game/assets/ux/cherry/augments/augmentselection/augmentcard_frame_';
    await Promise.all(['silver', 'gold', 'prismatic'].map(async (grade) => {
      try { cache.augFrames[grade] = await window.api.fetchUrlBase64(FRAME_BASE + grade + '.png'); } catch {}
    }));
    try {
      cache.augFallbackIcon = await window.api.fetchUrlBase64(
        'https://raw.communitydragon.org/latest/game/assets/ux/cherry/augments/icons/augment404_large.png'
      );
    } catch {}
    setProgress(100);

    await new Promise(r => setTimeout(r, 300));
    clearTimeout(loadingTimeoutId);
    onLoadComplete();
  } catch (err) {
    console.error('Load error:', err);
    clearTimeout(loadingTimeoutId);
    showLoadingRetry('데이터 로딩에 실패했습니다.');
  }
}

$('btn-retry').addEventListener('click', loadAllData);

async function onLoadComplete() {
  const savedKey   = await window.api.getSetting('riot_api_key');
  const savedName  = await window.api.getSetting('summoner_name');
  const savedTag   = await window.api.getSetting('tag_line');
  const savedPuuid = await window.api.getSetting('puuid');

  if (!savedKey) { showScreen('apikey'); return; }

  if (savedName && savedTag && savedPuuid) {
    cache.puuid = savedPuuid;

    const rows = await window.api.getCompletedChampions(cache.puuid);
    initChampionSets(rows);

    showMainScreen(savedName, savedTag);
    loadMatchHistoryFromCache();
    refreshAccountData(savedPuuid);
  } else {
    showScreen('login');
  }
}

async function loadMatchHistoryFromCache() {
  if (historyLoading) return;
  historyLoading = true;
  showLoadingModal('매치 기록 불러오는 중...');
  try {
    const cached = await window.api.getAllCachedMatches(cache.puuid);
    if (!cached.length) {
      $('history-scroll').innerHTML = '<div class="history-empty">새로고침으로 매치 기록을 불러오세요</div>';
      cache.matchHistory = [];
      updateStats();
      return;
    }
    cache.matchHistory = cached;
    await scanAndMarkWins(cache.matchHistory);
    refreshMatchHistoryView();
    renderChampionGrid();
    await preloadAugmentIcons(cache.matchHistory);
  } finally {
    historyLoading = false;
    hideLoadingModal();
  }
}

// ── API 키 화면 ────────────────────────────────────────────────────────────
$('btn-riot-dev').addEventListener('click', () =>
  window.api.openExternal('https://developer.riotgames.com/')
);

$('btn-apikey-confirm').addEventListener('click', async () => {
  const key = $('input-apikey').value.trim();
  if (!key) { $('input-apikey').classList.add('error'); $('input-apikey').focus(); return; }
  $('input-apikey').classList.remove('error');

  const btn = $('btn-apikey-confirm');
  btn.disabled = true;
  btn.textContent = '확인 중...';

  try {
    const { valid } = await window.api.validateApiKey(key);
    if (!valid) {
      $('apikey-error-msg').textContent = '유효하지 않은 API 키입니다. 다시 확인해 주세요.';
      $('apikey-error-msg').classList.remove('hidden');
      $('input-apikey').classList.add('error');
      $('input-apikey').focus();
      return;
    }
    $('apikey-error-msg').classList.add('hidden');
    await window.api.setSetting('riot_api_key', key);
    showScreen('login');
  } catch {
    $('apikey-error-msg').textContent = '네트워크 오류가 발생했습니다. 연결을 확인해 주세요.';
    $('apikey-error-msg').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '다음';
  }
});

$('input-apikey').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-apikey-confirm').click(); });

// ── Screen 1: Login ────────────────────────────────────────────────────────
$('btn-confirm').addEventListener('click', handleLogin);
$('input-tag').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
$('input-summoner').addEventListener('keydown', e => { if (e.key === 'Enter') $('input-tag').focus(); });

async function handleLogin() {
  const name = $('input-summoner').value.trim();
  const tag  = $('input-tag').value.trim();
  if (!name || !tag) {
    $('login-input-row').classList.add('error');
    return;
  }
  $('login-input-row').classList.remove('error');
  const btn = $('btn-confirm');
  btn.disabled = true;
  btn.textContent = '확인 중...';

  try {
    const data = await window.api.validateSummoner(name, tag);
    cache.puuid = data.puuid;
    await saveAccountSettings(name, tag, data.puuid);
    const rows = await window.api.getCompletedChampions(cache.puuid);
    initChampionSets(rows);
    showMainScreen(name, tag);
    loadMatchHistory();
  } catch (err) {
    if (isApiKeyError(err)) { redirectToApiKeyScreen(); return; }
    const status = err?.response?.status;
    let msg;
    if (status === 404) msg = '존재하지 않는 계정입니다. 소환사명과 태그를 확인해 주세요.';
    else if (!navigator.onLine) msg = '네트워크에 연결되어 있지 않습니다.';
    else msg = parseApiError(err) ?? '알 수 없는 오류가 발생했습니다.';
    showError(msg);
  } finally {
    btn.disabled = false;
    btn.textContent = '확인';
  }
}

// ── Screen 2: Main ─────────────────────────────────────────────────────────
function showMainScreen(name, tag) {
  $('user-name-display').textContent = name;
  $('user-tag-display').textContent = '#' + tag;
  showScreen('main');
  renderChampionGrid();
  updateStats();
  loadProfileIcon();
}

async function refreshAccountData(puuid) {
  try {
    const account = await window.api.fetchAccountByPuuid(puuid);
    const name = account.gameName;
    const tag = account.tagLine;
    $('user-name-display').textContent = name;
    $('user-tag-display').textContent = '#' + tag;
    await window.api.setSetting('summoner_name', name);
    await window.api.setSetting('tag_line', tag);
  } catch {
    // 실패 시 저장된 정보 유지
  }
}

async function loadProfileIcon() {
  try {
    const summoner = await window.api.fetchSummonerByPuuid(cache.puuid);
    const iconId = summoner.profileIconId;
    const url = `https://ddragon.leagueoflegends.com/cdn/${cache.version}/img/profileicon/${iconId}.png`;
    const iconBase64 = await window.api.fetchUrlBase64(url);
    const dot = document.querySelector('.user-dot');
    dot.innerHTML = `<img src="${iconBase64}" alt="profile" style="width:100%;height:100%;object-fit:cover;">`;
  } catch {
    // 실패 시 기본 SVG 아이콘 유지
  }
}

$('btn-change-account').addEventListener('click', async () => {
  closeAccountDropdown();
  await window.api.setSetting('summoner_name', '');
  await window.api.setSetting('tag_line', '');
  await window.api.setSetting('puuid', '');
  cache.puuid = null;
  cache.matchHistory = [];
  completedSet = new Set();
  manualSet = new Set();
  exitEditMode(false);
  // 프로필 아이콘 초기화
  document.querySelector('.user-dot').innerHTML = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#c89b3c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
    </svg>`;
  $('input-summoner').value = '';
  $('input-tag').value = '';
  showScreen('login');
});

$('btn-change-apikey').addEventListener('click', async () => {
  closeAccountDropdown();
  const savedKey = await window.api.getSetting('riot_api_key');
  $('input-apikey').value = savedKey || '';
  $('apikey-error-msg').classList.add('hidden');
  showScreen('apikey');
});

// ── Data reset ─────────────────────────────────────────────────────────────
$('btn-reset-data').addEventListener('click', () => {
  closeAccountDropdown();
  $('modal-reset').classList.remove('hidden');
});

$('modal-reset-close').addEventListener('click', () => $('modal-reset').classList.add('hidden'));
$('modal-reset-cancel').addEventListener('click', () => $('modal-reset').classList.add('hidden'));

$('modal-reset-confirm').addEventListener('click', async () => {
  $('modal-reset').classList.add('hidden');
  await window.api.resetData();

  completedSet = new Set();
  manualSet = new Set();
  cache.matchHistory = [];
  exitEditMode(false);
  renderChampionGrid();
  updateStats();
  $('history-scroll').innerHTML = '<div class="history-empty">초기화 완료. 새로고침으로 매치 기록을 불러오세요</div>';
});

// ── Stats ──────────────────────────────────────────────────────────────────
function updateStats() {
  updateCompletionStat();
  updateWinrateStat();
  updateTopAugStat();
}

function updateCompletionStat() {
  const done = completedSet.size;
  const pct = Math.round((done / TOTAL_CHAMPIONS) * 100);
  $('stat-completed').textContent = done;
  $('main-progress-bar').style.width = pct + '%';
  $('champ-count-label').textContent = `${done} / ${TOTAL_CHAMPIONS}`;
}

function updateWinrateStat() {
  const arenaMatches = (cache.matchHistory || []).filter(m => ARENA_QUEUE_IDS.has(m?.info?.queueId));
  const recent = arenaMatches.slice(0, RECENT_MATCH_WINDOW);
  const winCount = recent.filter(m => {
    const p = m.info.participants?.find(x => x.puuid === cache.puuid);
    return p && p.placement === 1;
  }).length;
  const winPct = recent.length > 0 ? Math.round((winCount / RECENT_MATCH_WINDOW) * 100) : 0;
  const circumference = 2 * Math.PI * DONUT_RADIUS;
  $('stat-winrate-pct').textContent = winPct + '%';
  $('donut-arc').style.strokeDashoffset = circumference * (1 - winPct / 100);

  const grid = $('win-champs-grid');
  grid.innerHTML = '';
  for (let i = 0; i < RECENT_MATCH_WINDOW; i++) {
    const slot = document.createElement('div');
    if (i < recent.length) {
      const p = recent[i].info.participants?.find(x => x.puuid === cache.puuid);
      const placement = p?.placement;
      slot.className = 'win-champ-slot' + (placement === 1 ? ' win' : placement >= 2 && placement <= 4 ? ' mid' : '');
      if (placement) slot.textContent = placement;
    } else {
      slot.className = 'win-champ-slot';
    }
    grid.appendChild(slot);
  }
}

function updateTopAugStat() {
  const augCount = {};
  for (const match of cache.matchHistory) {
    if (!ARENA_QUEUE_IDS.has(match?.info?.queueId)) continue;
    const p = match.info.participants?.find(x => x.puuid === cache.puuid);
    if (!p) continue;
    for (let i = 1; i <= 6; i++) {
      const augId = p[`playerAugment${i}`];
      if (augId && cache.augments[augId]) {
        const aug = cache.augments[augId];
        if (!isGameEffect(aug) && !AUG_EXCLUDE.has(aug.name)) {
          augCount[augId] = (augCount[augId] || 0) + 1;
        }
      }
    }
  }
  const top3 = Object.entries(augCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, count]) => ({ id, count, ...cache.augments[id] }));
  renderTopAugments(top3);
}

function renderTopAugments(top3) {
  const el = $('top-augs');
  if (!top3.length) {
    el.innerHTML = '<div style="font-size:10px;color:#555;margin-top:4px;">데이터 없음</div>';
    return;
  }
  el.innerHTML = '';
  for (let i = 0; i < top3.length; i++) {
    const aug = top3[i];
    const row = document.createElement('div');
    row.className = 'top-aug-row';

    const rankEl = document.createElement('div');
    rankEl.className = 'top-aug-rank';
    rankEl.style.color = RANK_COLORS[i];
    rankEl.textContent = i + 1;

    const iconDiv = createAugIconEl(aug, 'top-aug-icon');

    const nameEl = document.createElement('div');
    nameEl.className = 'top-aug-name';
    nameEl.textContent = aug.name;

    const countEl = document.createElement('div');
    countEl.className = 'top-aug-count';
    countEl.textContent = aug.count + '회';

    row.appendChild(rankEl);
    row.appendChild(iconDiv);
    row.appendChild(nameEl);
    row.appendChild(countEl);
    el.appendChild(row);
  }
}

// ── Champion Grid ──────────────────────────────────────────────────────────
function filterAndSortChampions(filter) {
  const all = Object.entries(cache.champions).map(([id, c]) => ({
    id,
    nameKo: c.nameKo,
    nameEn: c.nameEn,
    iconBase64: c.iconBase64,
    done: completedSet.has(id),
    manual: manualSet.has(id),
  }));

  const filtered = filter
    ? all.filter(c => window.hangulSearch.match(filter, c.nameKo) || window.hangulSearch.match(filter, c.nameEn))
    : all;

  const locale = (a, b) => a.nameKo.localeCompare(b.nameKo, 'ko');
  return {
    filtered,
    done:    filtered.filter(c =>  c.done).sort(locale),
    notDone: filtered.filter(c => !c.done).sort(locale),
  };
}

function createChampionCell(champ) {
  const cell = document.createElement('div');
  cell.className = 'champ-cell' + (champ.done ? (champ.manual ? ' done done-manual' : ' done') : '');
  cell.dataset.id = champ.id;

  if (editMode) {
    if (editPending.add.has(champ.id)) cell.classList.add('selected-add');
    if (editPending.del.has(champ.id)) cell.classList.add('selected-del');

    const willBeCompleted = (champ.done && !editPending.del.has(champ.id))
                         || (!champ.done && editPending.add.has(champ.id));
    const checkbox = document.createElement('div');
    checkbox.className = 'champ-checkbox' + (willBeCompleted ? ' checked' : '');
    if (willBeCompleted) checkbox.innerHTML = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    cell.appendChild(checkbox);
    cell.addEventListener('click', () => toggleEditCell(champ, cell));
  }

  const iconDiv = document.createElement('div');
  iconDiv.className = 'champ-icon-img';
  if (champ.iconBase64) {
    const img = document.createElement('img');
    img.src = champ.iconBase64;
    img.alt = champ.nameKo;
    iconDiv.appendChild(img);
  }

  const nameDiv = document.createElement('div');
  nameDiv.className = 'champ-name';
  nameDiv.textContent = champ.nameKo.length > 5 ? champ.nameKo.slice(0, 5) + '…' : champ.nameKo;

  cell.appendChild(iconDiv);
  cell.appendChild(nameDiv);

  if (champ.manual) {
    cell.addEventListener('mouseenter', (e) => {
      tooltipEl.className = 'tooltip-box';
      tooltipEl.innerHTML = `
        <div class="tooltip-name" style="color:#c4a8f0;">${escapeHtml(champ.nameKo)}</div>
        <div class="tooltip-divider"></div>
        <div class="tooltip-desc">편집 모드에서 우승 완료 챔피언으로 수동 등록</div>
      `;
      tooltipEl.classList.remove('hidden');
      positionTooltip(e);
    });
    cell.addEventListener('mouseleave', hideTooltip);
  }

  return cell;
}

function renderChampionGrid(filter = '') {
  const grid = $('champ-grid');
  grid.innerHTML = '';

  const { filtered, done, notDone } = filterAndSortChampions(filter);

  if (!filtered.length) {
    grid.innerHTML = '<div class="no-results">검색 결과가 없습니다</div>';
    return;
  }

  done.forEach(champ => grid.appendChild(createChampionCell(champ)));

  if (done.length > 0 && notDone.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'grid-divider';
    grid.appendChild(divider);
  }

  notDone.forEach(champ => grid.appendChild(createChampionCell(champ)));
}

let _limitMsgTimer = null;
function showEditLimitMsg(type) {
  const el = $('edit-limit-msg');
  el.textContent = type === 'add' ? '추가 최대 10개' : '삭제 최대 10개';
  el.classList.remove('hidden');
  clearTimeout(_limitMsgTimer);
  _limitMsgTimer = setTimeout(() => el.classList.add('hidden'), 2000);
}

function toggleEditCell(champ, cell) {
  if (champ.done) {
    if (editPending.del.has(champ.id)) {
      editPending.del.delete(champ.id);
      cell.classList.remove('selected-del');
    } else {
      if (editPending.del.size >= EDIT_MAX_PER_ACTION) { showEditLimitMsg('del'); return; }
      editPending.del.add(champ.id);
      cell.classList.add('selected-del');
    }
  } else {
    if (editPending.add.has(champ.id)) {
      editPending.add.delete(champ.id);
      cell.classList.remove('selected-add');
    } else {
      if (editPending.add.size >= EDIT_MAX_PER_ACTION) { showEditLimitMsg('add'); return; }
      editPending.add.add(champ.id);
      cell.classList.add('selected-add');
    }
  }

  const willBeCompleted = (champ.done && !editPending.del.has(champ.id))
                       || (!champ.done && editPending.add.has(champ.id));
  const checkbox = cell.querySelector('.champ-checkbox');
  if (checkbox) {
    checkbox.className = 'champ-checkbox' + (willBeCompleted ? ' checked' : '');
    checkbox.innerHTML = willBeCompleted ? `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` : '';
  }
}

// ── Search ─────────────────────────────────────────────────────────────────
const searchInput = $('champ-search');
const searchClear = $('search-clear');

const onSearchInput = debounce(() => {
  const val = searchInput.value;
  searchClear.classList.toggle('hidden', !val);
  renderChampionGrid(val);
}, 50);
searchInput.addEventListener('keyup', onSearchInput);

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.add('hidden');
  renderChampionGrid();
  searchInput.focus();
});

// ── Edit mode ──────────────────────────────────────────────────────────────
const btnEdit = $('btn-edit');
const labelEl = $('champ-list-label');

btnEdit.addEventListener('click', () => { if (!editMode) enterEditMode(); });

$('btn-edit-save').addEventListener('click', () => {
  if (editPending.add.size === 0 && editPending.del.size === 0) {
    exitEditMode(false);
    return;
  }
  showEditModal();
});

$('btn-edit-cancel').addEventListener('click', () => exitEditMode(false));

$('btn-edit-reset').addEventListener('click', () => {
  // 수동 추가 챔피언 전체를 삭제 대상으로 선택
  for (const id of manualSet) {
    if (!editPending.del.has(id)) {
      editPending.del.add(id);
      editPending.add.delete(id);
    }
  }
  renderChampionGrid(searchInput.value);
});

function enterEditMode() {
  editMode = true;
  editPending = { add: new Set(), del: new Set() };
  $('champ-header-normal').classList.add('hidden');
  $('champ-header-edit').classList.remove('hidden');
  document.querySelector('.col-left').classList.add('editing');
  renderChampionGrid(searchInput.value);
}

function exitEditMode(save) {
  editMode = false;
  editPending = { add: new Set(), del: new Set() };
  $('champ-header-normal').classList.remove('hidden');
  $('champ-header-edit').classList.add('hidden');
  document.querySelector('.col-left').classList.remove('editing');
  renderChampionGrid(searchInput.value);
}

function showEditModal() {
  const list = $('modal-edit-list');
  list.innerHTML = '';

  const makeGrid = (ids, cls, icon) => {
    if (!ids.length) return;
    const grid = document.createElement('div');
    grid.className = 'edit-champ-grid';
    for (const id of ids) {
      const name = cache.champions[id]?.nameKo || id;
      const item = document.createElement('div');
      item.className = `modal-item ${cls}`;
      item.innerHTML = `<span class="modal-item-icon">${icon}</span><span class="modal-item-name">${escapeHtml(name)}</span>`;
      grid.appendChild(item);
    }
    list.appendChild(grid);
  };

  makeGrid([...editPending.add], 'add', '+');
  makeGrid([...editPending.del], 'del', '-');
  $('modal-edit').classList.remove('hidden');
}

$('modal-edit-close').addEventListener('click', () => $('modal-edit').classList.add('hidden'));
$('modal-edit-cancel').addEventListener('click', () => $('modal-edit').classList.add('hidden'));
$('modal-edit-apply').addEventListener('click', async () => {
  $('modal-edit').classList.add('hidden');

  const toAdd = [...editPending.add].map(id => ({
    id,
    nameKo: cache.champions[id]?.nameKo || id,
    nameEn: cache.champions[id]?.nameEn || id,
  }));
  const toDelete = [...editPending.del].map(id => ({ id }));

  await window.api.applyChampionChanges(cache.puuid, toAdd, toDelete);

  for (const { id } of toAdd) { completedSet.add(id); manualSet.add(id); }
  for (const { id } of toDelete) { completedSet.delete(id); manualSet.delete(id); }

  exitEditMode(true);
  updateStats();
  renderChampionGrid(searchInput.value);
});

// ── Match History ──────────────────────────────────────────────────────────

// Fetch at most CONCURRENCY requests at a time to stay within rate limits
const HISTORY_CONCURRENCY = 5;
const HISTORY_BATCH_DELAY = 300; // ms between batches (~16 req/s)

async function loadMatchHistory() {
  if (historyLoading) return;
  historyLoading = true;
  const historyEl = $('history-scroll');
  historyEl.innerHTML = '';
  cache.matchHistory = [];
  showLoadingModal('매치 기록 가져오는 중...', true);
  updateLoadingProgress(0);

  try {
    const matchIds = await window.api.fetchMatchIds(cache.puuid, MAX_FETCH_COUNT);
    console.log('[loadMatchHistory] puuid:', cache.puuid, '| matchIds:', matchIds.length, matchIds.slice(0, 3));
    updateLoadingProgress(10);
    if (!matchIds.length) {
      historyEl.innerHTML = '<div class="history-empty">아레나 매치 기록이 없습니다</div>';
      return;
    }

    // 1. 디스크 캐시 일괄 조회 — 파일을 한 번만 읽음
    const cachedMap = await window.api.getCachedMatchesBulk(matchIds);
    const uncachedIds = [];
    for (const id of matchIds) {
      if (cachedMap[id]) cache.matchHistory.push(cachedMap[id]);
      else uncachedIds.push(id);
    }
    refreshMatchHistoryView();
    updateLoadingProgress(30);

    if (!uncachedIds.length) { updateLoadingProgress(100); return; }

    // 2. Phase 1: 최대 20개 우선 fetch — UI 빠르게 표시
    const phase1 = uncachedIds.slice(0, 20);
    const phase2 = uncachedIds.slice(20);

    await fetchMatchesBatch(phase1, (fetched, total) => {
      refreshMatchHistoryView();
      updateLoadingProgress(30 + (fetched / total) * 65);
    });

    await scanAndMarkWins(cache.matchHistory);
    renderChampionGrid();
    updateStats();

    // 3. Phase 2: 나머지 백그라운드 fetch
    if (phase2.length) {
      fetchRemainingMatchesBackground(phase2).catch(err => console.error('Background fetch error:', err));
    }
  } catch (err) {
    if (isApiKeyError(err)) { redirectToApiKeyScreen(); return; }
    const msg = parseApiError(err) ?? '히스토리를 불러오지 못했습니다.';
    if (!cache.matchHistory.length) {
      historyEl.innerHTML = '<div class="history-empty">히스토리 로딩 실패</div>';
    }
    showError(msg);
    console.error(err);
  } finally {
    historyLoading = false;
    hideLoadingModal();
  }
}

async function fetchRemainingMatchesBackground(ids) {
  await fetchMatchesBatch(ids, () => updateStats());
  refreshMatchHistoryView();
}

function renderMatchHistory(matches) {
  const historyEl = $('history-scroll');
  historyEl.innerHTML = '';

  if (matches.length) {
    const queueCounts = {};
    matches.forEach(m => { const q = m.info?.queueId; queueCounts[q] = (queueCounts[q] || 0) + 1; });
    window.api.log('renderMatchHistory total=' + matches.length, 'queueIds:', JSON.stringify(queueCounts));
  }

  if (!matches.length) {
    historyEl.innerHTML = '<div class="history-empty">아레나 매치 기록이 없습니다</div>';
    return;
  }

  for (const match of matches) {
    if (!ARENA_QUEUE_IDS.has(match?.info?.queueId)) continue;
    const participant = match.info.participants?.find(p => p.puuid === cache.puuid);
    if (!participant) continue;

    const champId = participant.championName;
    const placement = participant.placement;
    const ts = match.info.gameEndTimestamp || match.info.gameCreation;
    const date = formatDate(ts);

    const isDone = completedSet.has(champId);
    const rankClass = placement === 1 ? 'rank1' : placement <= 4 ? 'rank-mid' : 'rank-low';
    const badgeClass = placement === 1 ? 'r1' : placement <= 4 ? 'rmid' : 'rlow';

    const item = document.createElement('div');
    item.className = `history-item ${rankClass}`;

    const champInfo = getChampInfo(champId);
    const iconSrc = champInfo?.iconBase64 || '';
    const champName = champInfo?.nameKo || champId;

    // Augments — rarity=4(게임 효과) 및 이름 기반 제외 목록 필터링
    // CDragon에 아직 없는 신규 증강은 placeholder로 표시
    const augments = [];
    for (let i = 1; i <= 6; i++) {
      const augId = participant[`playerAugment${i}`];
      if (!augId) continue;
      if (cache.augments[augId]) {
        const aug = cache.augments[augId];
        if (!isGameEffect(aug) && !AUG_EXCLUDE.has(aug.name)) {
          augments.push({ id: augId, ...aug });
        }
      } else {
        augments.push(UNKNOWN_AUGMENT(augId));
      }
    }

    // Items — 아이템 ID 기반으로 와드류 제외 (이름 변경 패치에 무관)
    const itemIds = [];
    for (let i = 0; i <= 6; i++) {
      const itemId = participant[`item${i}`];
      if (!itemId || itemId === 0) continue;
      if (EXCLUDED_ITEM_IDS.has(String(itemId))) continue;
      itemIds.push(String(itemId));
    }

    item.innerHTML = `
      <div class="history-header">
        <div class="champ-icon-history${isDone ? ' done' : ''}">
          ${iconSrc ? `<img src="${iconSrc}" alt="${escapeHtml(champName)}">` : ''}
        </div>
        <div class="history-info">
          <div class="history-champ">${escapeHtml(champName)}</div>
          <div class="history-date">${escapeHtml(date)}</div>
        </div>
        <div class="history-augs"></div>
        <div class="history-right">
          <div class="rank-badge ${badgeClass}">${placement}위</div>
          <div class="chevron">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
        </div>
      </div>
    `;

    const historyAugsEl = item.querySelector('.history-augs');
    for (const aug of augments) {
      historyAugsEl.appendChild(createAugIconEl(aug, 'history-aug-icon'));
    }

    // Detail area (hidden by default)
    const detail = document.createElement('div');
    detail.className = 'history-detail';
    detail.style.display = 'none';
    detail.appendChild(createAugmentSection(augments));
    detail.appendChild(createItemSection(itemIds));

    item.appendChild(detail);

    // Toggle expand
    const header = item.querySelector('.history-header');
    const chevron = item.querySelector('.chevron');
    header.addEventListener('click', () => {
      const isOpen = detail.style.display !== 'none';
      detail.style.display = isOpen ? 'none' : 'block';
      chevron.classList.toggle('open', !isOpen);
    });

    historyEl.appendChild(item);
  }
}

function createAugmentSection(augments) {
  const section = document.createElement('div');
  section.className = 'detail-section';
  section.innerHTML = '<div class="detail-title">증강</div>';
  const row = document.createElement('div');
  row.className = 'augment-row';
  if (augments.length) {
    for (const aug of augments) {
      const chip = document.createElement('div');
      const gradeClass = aug.grade === 'prismatic' ? 'prismatic-aug' : aug.grade === 'gold' ? 'gold-aug' : 'silver-aug';
      chip.className = `augment-chip ${gradeClass}`;
      chip.appendChild(createAugIconEl(aug, 'aug-icon'));
      chip.appendChild(document.createTextNode(aug.name));
      chip.addEventListener('mouseenter', (e) => showTooltip(e, 'augment', aug));
      chip.addEventListener('mouseleave', hideTooltip);
      row.appendChild(chip);
    }
  } else {
    row.innerHTML = '<span style="font-size:10px; color:#555;">증강 없음</span>';
  }
  section.appendChild(row);
  return section;
}

function createItemSection(itemIds) {
  const section = document.createElement('div');
  section.className = 'detail-section';
  section.innerHTML = '<div class="detail-title">아이템</div>';
  const row = document.createElement('div');
  row.className = 'item-row';
  for (const itemId of itemIds) {
    const itemInfo = cache.items[itemId];
    const cell = document.createElement('div');
    cell.className = `item-cell${itemInfo ? ' filled' : ''}`;
    if (itemInfo?.iconBase64) {
      cell.innerHTML = `<img src="${itemInfo.iconBase64}" alt="${escapeHtml(itemInfo.name)}">`;
    }
    if (itemInfo) {
      cell.addEventListener('mouseenter', (e) => showTooltip(e, 'item', itemInfo));
      cell.addEventListener('mouseleave', hideTooltip);
    }
    row.appendChild(cell);
  }
  for (let i = itemIds.length; i < 6; i++) {
    const cell = document.createElement('div');
    cell.className = 'item-cell';
    row.appendChild(cell);
  }
  section.appendChild(row);
  return section;
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const time = `${h}:${m}`;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today - target) / 86400000);

  if (diffDays === 0) return `오늘 ${time}`;
  if (diffDays === 1) return `어제 ${time}`;
  if (diffDays === 2) return `2일 전 ${time}`;

  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const prefix = d.getFullYear() !== now.getFullYear() ? `${d.getFullYear()}년 ` : '';
  return `${prefix}${mo}월 ${day}일 (${DAYS[d.getDay()]}) ${time}`;
}

// ── Refresh ────────────────────────────────────────────────────────────────
async function doRefresh() {
  if (historyLoading) return;
  historyLoading = true;
  const btnTop  = $('btn-refresh-top');
  btnTop.disabled = true;
  const prevCompleted = new Set(completedSet);
  showLoadingModal('새로고침 중...', true);
  updateLoadingProgress(0);

  try {
    const lastTs = cache.matchHistory.length > 0
      ? Math.max(...cache.matchHistory.map(m => m?.info?.gameEndTimestamp || m?.info?.gameCreation || 0))
      : null;
    const startTime = lastTs > 0 ? Math.floor(lastTs / 1000) + 1 : null;
    const matchIds = await window.api.fetchMatchIds(cache.puuid, MAX_FETCH_COUNT, startTime);
    updateLoadingProgress(10);

    // 디스크 캐시 일괄 조회
    const cachedMap = await window.api.getCachedMatchesBulk(matchIds);
    const freshIds = matchIds.filter(id => !cachedMap[id]);
    updateLoadingProgress(25);

    // 증분 조회 시 기존 기록 유지, 전체 조회 시 교체 (중복 제거)
    const base = startTime ? cache.matchHistory : [];
    const seenIds = new Set(base.map(m => m.metadata?.matchId).filter(Boolean));
    const newFromDisk = Object.values(cachedMap).filter(m => {
      const id = m.metadata?.matchId;
      if (!id || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });
    cache.matchHistory = [...base, ...newFromDisk];
    refreshMatchHistoryView();

    await fetchMatchesBatch(freshIds, (fetched, total) => {
      updateLoadingProgress(25 + (fetched / Math.max(total, 1)) * 65);
    });
    updateLoadingProgress(100);

    const newWins = await scanAndMarkWins(cache.matchHistory, prevCompleted);
    refreshMatchHistoryView();
    renderChampionGrid(searchInput.value);

    if (newWins.length > 0) {
      const items = newWins.map(n =>
        `<div class="refresh-champ-item"><span class="refresh-champ-dot">•</span><span class="refresh-champ-name">${escapeHtml(n)}</span></div>`
      ).join('');
      $('modal-refresh-msg').innerHTML =
        `<div class="refresh-summary">${newWins.length}개의 챔피언이 새로 추가되었습니다!</div>` +
        `<div class="refresh-champ-grid">${items}</div>`;
      $('modal-refresh').classList.remove('hidden');
    }
  } catch (err) {
    if (isApiKeyError(err)) { redirectToApiKeyScreen(); return; }
    showError(parseApiError(err) ?? '새로고침 실패: ' + (err.message || err));
  } finally {
    historyLoading = false;
    btnTop.disabled = false;
    hideLoadingModal();
  }
}

$('btn-refresh-top').addEventListener('click', doRefresh);

$('modal-refresh-close').addEventListener('click', () => $('modal-refresh').classList.add('hidden'));
$('modal-refresh-ok').addEventListener('click', () => $('modal-refresh').classList.add('hidden'));

// ── Tooltip ────────────────────────────────────────────────────────────────
const tooltipEl = $('tooltip');

async function preloadAugmentIcons(matches) {
  const seen = new Set();
  const jobs = [];
  for (const match of matches) {
    if (!ARENA_QUEUE_IDS.has(match?.info?.queueId)) continue;
    const p = match.info.participants?.find(x => x.puuid === cache.puuid);
    if (!p) continue;
    for (let i = 1; i <= 6; i++) {
      const augId = p[`playerAugment${i}`];
      const aug = augId && cache.augments[augId];
      if (aug && !isGameEffect(aug) && !aug.iconBase64 && (aug.iconLarge || aug.iconSmall) && !seen.has(augId)) {
        seen.add(augId);
        jobs.push(loadAugmentIcon(aug));
      }
    }
  }
  await Promise.allSettled(jobs);
}

const AUG_KEYWORD_MAP = {
  'item_keyword_onhit': '적중 시',
};

function formatAugDesc(raw, dataValues) {
  if (!raw) return '';
  const dv = dataValues || {};
  const dvLower = {};
  for (const k of Object.keys(dv)) {
    const v = dv[k];
    dvLower[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }

  return raw
    .replace(/<spellName>(.*?)<\/spellName>/gi, '$1')
    .replace(/<keyword\w*>(.*?)<\/keyword\w*>/gi, '$1')
    .replace(/<trueDamage>(.*?)<\/trueDamage>/gi, '$1')
    .replace(/<rules>(.*?)<\/rules>/gi, '$1')
    .replace(/<[^>]+>(.*?)<\/[^>]+>/gi, '$1')
    .replace(/<[^>]+>/gi, '')
    .replace(/%i:[^%]+%/g, '')
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
      const mapped = AUG_KEYWORD_MAP[key.toLowerCase()];
      return mapped ? `<span class="desc-keyword">${mapped}</span>` : '';
    })
    .replace(/@([^@]+)@/g, (_, expr) => {
      let varPart = expr;
      let multiplier = 1;
      let decimals = -1;
      const multMatch = varPart.match(/^([^*|]+)\*(\d+(?:\.\d+)?)/);
      if (multMatch) { varPart = multMatch[1]; multiplier = parseFloat(multMatch[2]); }
      const decMatch = expr.match(/\|(\d+)/);
      if (decMatch) decimals = parseInt(decMatch[1]);
      const val = dvLower[varPart.toLowerCase()];
      if (val == null) return '<span class="desc-var">?</span>';
      const num = parseFloat(val) * multiplier;
      if (isNaN(num)) return `<em>${escapeHtml(String(val))}</em>`;
      const str = decimals >= 0 ? num.toFixed(decimals) : parseFloat(num.toFixed(1)).toString();
      return `<em>${str}</em>`;
    })
    .replace(/(?<!<em>)(\d+(?:\.\d+)?%?)(?!<\/em>)/g, '<em>$1</em>');
}

function createAugIconEl(aug, cssClass) {
  const wrapper = document.createElement('div');
  wrapper.className = `${cssClass} aug-grade-${aug.grade || 'silver'}`;
  const img = document.createElement('img');
  img.alt = '';
  if (aug.iconBase64) {
    img.src = aug.iconBase64;
  } else if (aug.iconLarge || aug.iconSmall) {
    loadAugmentIcon(aug).then(() => {
      img.src = aug.iconBase64 || cache.augFallbackIcon || '';
    });
    if (cache.augFallbackIcon) img.src = cache.augFallbackIcon;
  } else if (cache.augFallbackIcon) {
    img.src = cache.augFallbackIcon;
  }
  wrapper.appendChild(img);
  if (cache.augFrames[aug.grade]) {
    const frameImg = document.createElement('img');
    frameImg.src = cache.augFrames[aug.grade];
    frameImg.className = 'augment-frame';
    frameImg.alt = '';
    wrapper.appendChild(frameImg);
  }
  return wrapper;
}

async function loadAugmentIcon(aug) {
  if (aug.iconBase64 || (!aug.iconLarge && !aug.iconSmall)) return;
  const iconPath = (aug.iconLarge || aug.iconSmall).toLowerCase();
  const iconUrl = 'https://raw.communitydragon.org/latest/game/' + iconPath;
  try {
    aug.iconBase64 = await window.api.fetchUrlBase64(iconUrl);
    // Update any visible tooltip icon
    const existing = tooltipEl.querySelector('.tooltip-icon-box img');
    if (existing && tooltipTarget === aug) existing.src = aug.iconBase64;
  } catch {}
}

function showTooltip(e, type, data) {
  tooltipTarget = data;
  let html = '';
  if (type === 'augment') {
    const gradeLabel = data.grade === 'prismatic' ? '프리즘 증강' : data.grade === 'gold' ? '골드 증강' : '실버 증강';
    const gradeClass = data.grade;
    const frameHtml = cache.augFrames[data.grade] ? `<img src="${cache.augFrames[data.grade]}" class="augment-frame" alt="">` : '';
    const icon = data.iconBase64 ? `<img src="${data.iconBase64}" alt="">${frameHtml}` : '';
    const desc = formatAugDesc(data.description, data.dataValues);
    html = `
      <div class="tooltip-header-row">
        <div class="tooltip-icon-box">${icon}</div>
        <div><div class="tooltip-name">${escapeHtml(data.name)}</div><div class="tooltip-grade ${gradeClass}">${gradeLabel}</div></div>
      </div>
      <div class="tooltip-divider"></div>
      <div class="tooltip-desc">${desc}</div>
    `;
    tooltipEl.className = `tooltip-box ${data.grade}-border`;
    if (!data.iconBase64) loadAugmentIcon(data);
  } else if (type === 'item') {
    const icon = data.iconBase64 ? `<img src="${data.iconBase64}" alt="">` : '';
    const desc = (data.description || '').replace(/<[^>]*>/g, '').replace(/(\d+(?:\.\d+)?(?:%)?)/g, '<em>$1</em>');
    html = `
      <div class="tooltip-header-row">
        <div class="tooltip-icon-box">${icon}</div>
        <div><div class="tooltip-name">${escapeHtml(data.name)}</div></div>
      </div>
      <div class="tooltip-divider"></div>
      <div class="tooltip-desc">${desc}</div>
    `;
    tooltipEl.className = 'tooltip-box';
  }

  tooltipEl.innerHTML = html;
  tooltipEl.classList.remove('hidden');
  positionTooltip(e);
}

function positionTooltip(e) {
  const tw = TOOLTIP_WIDTH;
  const th = TOOLTIP_HEIGHT;
  let x = e.clientX + 12;
  let y = e.clientY + 12;
  if (x + tw > window.innerWidth) x = e.clientX - tw;
  if (y + th > window.innerHeight) y = e.clientY - th;
  tooltipEl.style.left = x + 'px';
  tooltipEl.style.top = y + 'px';
}

document.addEventListener('mousemove', (e) => {
  if (!tooltipEl.classList.contains('hidden')) positionTooltip(e);
});

function hideTooltip() {
  tooltipEl.classList.add('hidden');
}

// ── Loading modal ──────────────────────────────────────────────────────────
function showLoadingModal(text = '불러오는 중...', showProgress = false) {
  $('loading-modal-text').textContent = text;
  $('loading-modal-progress-wrap').classList.toggle('hidden', !showProgress);
  $('loading-modal-pct').classList.toggle('hidden', !showProgress);
  if (showProgress) updateLoadingProgress(0);
  $('modal-loading').classList.remove('hidden');
}
function updateLoadingProgress(pct) {
  const p = Math.round(pct);
  $('loading-modal-bar').style.width = p + '%';
  $('loading-modal-pct').textContent = p + '%';
}
function hideLoadingModal() {
  $('modal-loading').classList.add('hidden');
}

// ── Error modal ────────────────────────────────────────────────────────────
function showError(msg) {
  $('modal-error-msg').textContent = msg;
  $('modal-error').classList.remove('hidden');
}
$('modal-error-close').addEventListener('click', () => $('modal-error').classList.add('hidden'));
$('modal-error-ok').addEventListener('click', () => $('modal-error').classList.add('hidden'));

// ── Boot ───────────────────────────────────────────────────────────────────
loadAllData();

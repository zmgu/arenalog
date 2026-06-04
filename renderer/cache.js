// In-memory cache — lives for the duration of the app session
window.cache = {
  version: null,
  champions: {},       // { championId: { nameKo, nameEn, iconBase64 } }
  championsIndex: {},  // { lowerCaseId: actualId } — 대소문자 불일치 보정용
  championsArray: [],  // [{ id, nameKo, nameEn, iconBase64 }] — 반복 순회용 배열
  items: {},       // { itemId: { name, description, iconBase64 } }
  augments: {},    // { augmentId: { name, grade, description, iconBase64 } }
  augFrames: { silver: null, gold: null, prismatic: null },
  augFallbackIcon: null, // 알 수 없는 증강용 플레이스홀더
  matchHistory: [],
  puuid: null,
};

# ArenaLog

리그 오브 레전드 아레나 모드에서 "아레나의 신" 칭호 획득을 위한 60챔피언 우승 트래커 데스크탑 앱.

---

## 기술 스택

- **런타임**: Electron 28
- **프론트**: HTML / CSS / JavaScript
- **백엔드(메인 프로세스)**: Node.js
- **퍼시스턴스**: JSON 파일 (`champions.json`, `settings.json`, `match_cache.json`)
- **API 호출**: `axios`
- **검색**: `hangul-js` (초성 검색, 한영 변환)
- **패키징**: `electron-builder` (NSIS 설치 파일 `.exe`)
- **폰트**: Pretendard (SIL OFL)
  - 폴백: `font-family: 'Pretendard', 'Malgun Gothic', sans-serif`

---

## 앱 기본 설정

- **앱 이름**: ArenaLog
- **창 크기**: 920 x 660 (고정, 리사이즈 불가)
- **타이틀바**: 커스텀 (`frame: false`) — 좌측 ●●● 점 3개 + 앱 이름, 우측 최소화/닫기 버튼
- **데이터 저장 위치**: `app.getPath('userData')`
  - Windows: `C:\Users\{사용자명}\AppData\Roaming\ArenaLog\`

---

## 데이터 관리 (JSON 파일)

`userData` 폴더에 3개의 JSON 파일로 영속 데이터를 관리합니다.

**`champions.json`** — puuid별 챔피언 완료 현황
```json
{
  "{puuid}": {
    "{championId}": {
      "champion_name_ko": "...",
      "champion_name_en": "...",
      "isCompleted": true,
      "source": "auto | manual",
      "completed_at": "ISO8601"
    }
  }
}
```

**`settings.json`** — 계정 및 앱 설정
```
summoner_name, tag_line, puuid, last_sync_at, riot_api_key
```

**`match_cache.json`** — 매치 상세 데이터 캐시 (최대 200개, 오래된 순 삭제)

---

## 초기 로딩 전략

앱 실행 시 로딩 화면을 표시하면서 모든 데이터를 병렬 fetch 후 메모리 캐시에 올림.
이후 검색/상세보기 등 모든 기능을 네트워크 요청 없이 즉시 처리하는 것이 목표.

### 로딩 순서

```
앱 실행
→ 로딩 화면 표시 (진행률 % + 단계별 상태)
→ 병렬 fetch
   ├── Data Dragon 버전 확인
   ├── 챔피언 전체 목록 + 한글/영어 이름
   ├── 챔피언 아이콘 전체 → base64 변환 후 캐시
   ├── 아이템 전체 데이터 + 아이콘 → base64 변환 후 캐시
   └── 증강 전체 데이터 + 아이콘 → base64 변환 후 캐시 (Community Dragon)
→ API 키 없으면 키 입력 화면 → 소환사명 없으면 로그인 화면 → 있으면 메인 화면
```

### 메모리 캐시 구조

```javascript
window.cache = {
  version: null,
  champions: {},       // { championId: { nameKo, nameEn, iconBase64 } }
  championsIndex: {},  // { lowerCaseId: actualId } — 대소문자 불일치 보정
  items: {},           // { itemId: { name, description, iconBase64 } }
  augments: {},        // { augmentId: { name, grade, rarityNum, description, iconBase64 } }
  augFrames: { silver: null, gold: null, prismatic: null },
  augFallbackIcon: null,
  matchHistory: [],
  puuid: null,
}
```

- 이미지는 base64 변환 후 메모리 보관, 앱 종료 시 소멸
- 매치 히스토리는 새로고침 버튼 클릭 시만 재fetch
- 챔피언/아이템/증강 데이터는 앱 재시작 시에만 재fetch

---

## 화면 구조

### 로딩 화면
- 진행률 바 + % + 단계별 상태 목록 (완료 ✓ 골드 / 진행 흰색 / 대기 회색)
- fetch 실패 시 오류 메시지 + 다시 시도 버튼

### API 키 입력 화면 (screen-apikey)
- 최초 실행 또는 API 키가 유효하지 않을 때 표시
- `developer.riotgames.com` 외부 링크 제공
- 입력한 키를 `settings.json`에 저장

### 소환사 입력 화면 (screen-login)
- 소환사명 + `#` + 태그 입력
- Riot Account API로 유효성 검증 후 메인으로 이동

### 메인 화면 (screen-main)
- 상단 바: 소환사 정보 + 새로고침 + 계정 변경
- 진척도: stat 카드 3개(완료 수 / 총 경기 / 최고 연속 1등) + 도넛 프로그레스
- 2분할: 왼쪽(챔피언 목록, flex 3) / 오른쪽(매치 히스토리, flex 2)

---

## 챔피언 목록

- 6열 그리드, 아이콘 38px
- 완료 상단 → 구분선 → 미완료 하단
- 완료(자동): 골드 테두리 / 완료(수동): 보라 테두리 / 미완료: 회색 테두리
- 우측 상단 "N / 60" + 편집 버튼 + 도움말(?) 버튼

### 검색
- 한글 / 영어(대소문자 무관) / 초성 / 한→영 오타 변환
- 한글 IME 문제: `keyup` + `setTimeout 50ms` 조합으로 처리

### 편집 모드
- 미완료 클릭 → 초록(추가 대상) / 완료 클릭 → 빨강(삭제 대상)
- 최대 10개씩 선택
- 초기화 버튼: 수동 추가(보라) 챔피언 전체를 삭제 대상으로 지정
- 저장 클릭 시 변경 내역 확인 팝업 표시
- 편집 모드 진입 시 단계별 도움말 가이드 자동 표시 (최초 1회)

---

## 매치 히스토리

- 아레나 큐(1700, 1750)만 필터링
- 카드: 챔피언 아이콘 + 챔피언명 + 날짜 + 등수 배지
- 등수별 border-left 2px 색상 구분
- 카드 클릭 시 증강/아이템 영역 펼침
  - 증강: 프리즘/골드/실버 등급 칩 + 호버 툴팁
  - 아이템: 30x30px 셀, 비전 탐지기 계열(ID: 3364, 3513) 제외
  - CDragon 미반영 신규 증강은 "알 수 없는 증강" placeholder 표시
- 새로고침 시 신규 1등 챔피언 있으면 알림 팝업

---

## 오류 처리

- 401/403 → API 키 입력 화면으로 리다이렉트
- 429 → "Rate Limit 초과" 팝업
- 그 외 → 오류 팝업
- 초기 로딩 실패 → 다시 시도 버튼

---

## Riot API

- API 키: `settings.json` 또는 환경변수 `RIOT_API_KEY` (하드코딩 금지)
- 아레나 큐 타입: 1700, 1750
- 개발용 키: 24시간마다 만료, Rate Limit 20req/1초 · 100req/2분

### 엔드포인트

```
GET https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}
GET https://kr.api.riotgames.com/lol/status/v4/platform-data          (API 키 유효성 검증)
GET https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/{puuid}/ids?count=100
GET https://asia.api.riotgames.com/lol/match/v5/matches/{matchId}
GET https://ddragon.leagueoflegends.com/api/versions.json
GET https://ddragon.leagueoflegends.com/cdn/{version}/data/ko_KR/champion.json
GET https://ddragon.leagueoflegends.com/cdn/{version}/img/champion/{championId}.png
GET https://ddragon.leagueoflegends.com/cdn/{version}/data/ko_KR/item.json
GET https://ddragon.leagueoflegends.com/cdn/{version}/img/item/{itemId}.png
GET https://raw.communitydragon.org/latest/cdragon/arena/ko_kr.json
```

---

## 보안

- IPC URL allowlist: `ddragon.leagueoflegends.com`, `raw.communitydragon.org`만 허용
- Riot API 호출은 메인 프로세스에서만 수행 (renderer는 IPC 경유)
- `contextIsolation: true`, `nodeIntegration: false`
- 매치 ID 형식 검증: `/^[A-Z0-9_]{1,32}$/i`

---

## 디자인 시스템

### 컬러 팔레트

```
APP_BG         #2e2e2e   앱 배경
TITLEBAR_BG    #252525   타이틀바, 카드 배경
INPUT_BG       #3a3a3a   입력창, 버튼
DETAIL_BG      #202020   히스토리 펼침 배경

GOLD           #c89b3c   메인 포인트 컬러
RANK1          #c89b3c   1위
RANK2          #888888   2위
RANK3          #8B6914   3위
RANK_LOW       #555555   4위 이하

PRISMATIC      #9b7fd4 / #c4a8f0   프리즘 증강
SELECT_ADD     #52b052 / #1a3a1a   추가 선택
SELECT_DEL     #cc8888 / #3a2525   삭제 선택

TEXT_PRIMARY   #e0e0e0
TEXT_SECONDARY #aaaaaa
```

### 레이아웃 치수

```
앱: 920 x 660, border-radius 12px
타이틀바: 36px
2분할: col-left flex 3 / col-right flex 2, gap 12px
챔피언 그리드: 6열, 아이콘 38x38px, border-radius 6px
히스토리 아이콘: 36x36px
툴팁: width 214px
```

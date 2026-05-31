// ── 챔피언 목록 안내 팝오버 ────────────────────────────────────────────────
const champInfoPopover = $('champ-info-popover');
let champInfoOpen = false;

function openChampInfo(btn) {
  const rect = btn.getBoundingClientRect();
  const pw = 230;
  let left = rect.left - 10;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  const top = rect.bottom + 8;
  const tailX = rect.left + rect.width / 2 - left;
  champInfoPopover.style.left = left + 'px';
  champInfoPopover.style.top  = top  + 'px';
  champInfoPopover.style.setProperty('--tail-x', tailX + 'px');
  champInfoPopover.classList.remove('hidden');
  champInfoOpen = true;
}

function closeChampInfo() {
  champInfoPopover.classList.add('hidden');
  champInfoOpen = false;
}

$('btn-champ-info').addEventListener('click', (e) => {
  e.stopPropagation();
  if (champInfoOpen) closeChampInfo();
  else openChampInfo(e.currentTarget);
});

document.addEventListener('click', (e) => {
  if (champInfoOpen && !champInfoPopover.contains(e.target)) closeChampInfo();
});

// ── 편집 모드 가이드 ───────────────────────────────────────────────────────
// tailOffset: 꼬리 위치 수동 지정 (px). null이면 자동 계산.
//   side=right → 팝오버 상단에서의 Y 오프셋
//   side=bottom → 팝오버 왼쪽에서의 X 오프셋
const EDIT_STEPS = [
  {
    targetId: 'champ-grid',
    title: '챔피언 선택 — <span class="guide-title-add">추가</span>',
    desc: '회색 테두리(미완료) 챔피언을 클릭하면 <span class="g-add">초록 테두리</span>로 변경됩니다. 다시 클릭하면 선택이 해제됩니다.<span class="desc-bullet-line"><span class="desc-bullet">·</span> 최대 <span class="g-add">10개</span>까지 선택 가능</span>',
    side: 'right', pad: 8, tailOffset: 20,
  },
  {
    targetId: 'champ-grid',
    title: '챔피언 선택 — <span class="guide-title-del">삭제</span>',
    desc: '<span class="g-gold">금색 테두리</span> 또는 <span class="g-purple">보라색 테두리</span>(수동 추가) 챔피언을 클릭하면 <span class="g-del">빨강 테두리</span>로 변경됩니다. 완료 상태를 취소할 때 사용합니다.<span class="desc-bullet-line"><span class="desc-bullet">·</span> 최대 <span class="g-del">10개</span>까지 선택 가능</span>',
    side: 'right', pad: 8, tailOffset: 20,
  },
  {
    targetId: 'btn-edit-reset',
    title: '초기화 버튼',
    desc: '<span class="g-purple">보라색 테두리</span>(수동 추가) 챔피언을 <span class="g-del">전체 삭제 대상</span>으로 지정합니다.',
    side: 'bottom', pad: 4, tailOffset: 104,
  },
  {
    targetId: 'btn-edit-cancel',
    title: '취소 버튼',
    desc: '변경 사항을 저장하지 않고 편집 모드를 종료합니다.',
    side: 'bottom', pad: 4, tailOffset: 104,
  },
  {
    targetId: 'btn-edit-save',
    title: '저장 버튼',
    desc: '변경 내역 확인 팝업이 열립니다. 내역을 확인한 뒤 <span class="g-gold">적용</span>하거나 취소할 수 있습니다.',
    side: 'bottom', pad: 4, tailOffset: 104,
  },
];

let guideStep = 0;
const guideOverlay   = $('guide-overlay');
const guideHighlight = $('guide-highlight-box');
const guidePopover   = $('guide-popover');
const guideTitleEl   = $('guide-title');
const guideDescEl    = $('guide-desc');
const guideStepEl    = $('guide-step-label');
const guidePrevBtn   = $('guide-prev');
const guideNextBtn   = $('guide-next');

function showStep(idx) {
  const step   = EDIT_STEPS[idx];
  const target = $(step.targetId);
  if (!target) return;

  const rect = target.getBoundingClientRect();
  const p    = step.pad;
  const W    = window.innerWidth, H = window.innerHeight;

  let x1 = rect.left  - p, y1 = rect.top    - p;
  let x2 = rect.right + p, y2 = rect.bottom + p;

  // champ-grid: grid 컨테이너는 scroll 전체 너비로 늘어나므로 실제 마지막 열 셀의 right 사용
  if (step.targetId === 'champ-grid') {
    const scroll = $('champ-scroll');
    if (scroll) {
      const sr = scroll.getBoundingClientRect();
      const cells = target.querySelectorAll('.champ-cell');
      const rightCell = cells.length >= 6 ? cells[5] : cells[cells.length - 1];
      x1 = sr.left - p;
      x2 = (rightCell ? rightCell.getBoundingClientRect().right : sr.right) + p;
      y1 = Math.max(rect.top,    sr.top)    - p;
      y2 = Math.min(rect.bottom, sr.bottom) + p;
      if (y1 > y2) y2 = y1;
    }
  }

  // 하이라이트 박스
  guideHighlight.style.left   = x1 + 'px';
  guideHighlight.style.top    = y1 + 'px';
  guideHighlight.style.width  = (x2 - x1) + 'px';
  guideHighlight.style.height = (y2 - y1) + 'px';
  guideHighlight.classList.remove('hidden');

  // 오버레이 — 외곽 ar=12px(앱 모서리), 구멍 r=8px
  const r = 8, ar = 12;
  const svgPath =
    `M${ar},0 L${W-ar},0 Q${W},0 ${W},${ar} L${W},${H-ar} Q${W},${H} ${W-ar},${H} L${ar},${H} Q0,${H} 0,${H-ar} L0,${ar} Q0,0 ${ar},0 Z ` +
    `M${x1},${y1+r} L${x1},${y2-r} Q${x1},${y2} ${x1+r},${y2} ` +
    `L${x2-r},${y2} Q${x2},${y2} ${x2},${y2-r} ` +
    `L${x2},${y1+r} Q${x2},${y1} ${x2-r},${y1} ` +
    `L${x1+r},${y1} Q${x1},${y1} ${x1},${y1+r} Z`;
  guideOverlay.style.background = 'rgba(0,0,0,0.62)';
  guideOverlay.style.clipPath = `path('${svgPath}')`;


  // 팝오버 내용
  guideTitleEl.innerHTML = step.title;
  guideDescEl.innerHTML    = step.desc;
  guideStepEl.textContent  = `${idx + 1} / ${EDIT_STEPS.length}`;
  guidePrevBtn.style.visibility = idx === 0 ? 'hidden' : 'visible';
  guideNextBtn.textContent = idx === EDIT_STEPS.length - 1 ? '완료' : '다음';

  // 팝오버 위치 — 클리핑된 영역 중심 기준
  const PW = 210, PH = 160;
  let px, py;
  if (step.side === 'right') {
    px = x2 + 14;
    py = y1;
  } else {
    px = (x1 + x2) / 2 - PW / 2;
    py = y2 + 12;
  }
  px = Math.max(8, Math.min(px, W - PW - 8));
  py = Math.max(8, Math.min(py, H - PH - 8));

  guidePopover.style.left = px + 'px';
  guidePopover.style.top  = py + 'px';

  // 꼬리 방향·위치 설정
  if (step.side === 'right') {
    guidePopover.dataset.tail = 'left';
    const autoY = (y1 + y2) / 2 - py;
    guidePopover.style.setProperty('--tail-y', (step.tailOffset ?? autoY) + 'px');
  } else {
    guidePopover.dataset.tail = 'top';
    const autoX = (x1 + x2) / 2 - px;
    guidePopover.style.setProperty('--tail-x', (step.tailOffset ?? autoX) + 'px');
  }

  guidePopover.classList.remove('hidden');
}

function hideGuide() {
  guideOverlay.classList.add('hidden');
  guideHighlight.classList.add('hidden');
  guidePopover.classList.add('hidden');
  guideOverlay.style.clipPath = '';
}

function startEditGuide() {
  guideStep = 0;
  guideOverlay.classList.remove('hidden');
  showStep(guideStep);
}

guidePrevBtn.addEventListener('click', () => {
  if (guideStep > 0) showStep(--guideStep);
});
guideNextBtn.addEventListener('click', () => {
  if (guideStep < EDIT_STEPS.length - 1) showStep(++guideStep);
  else hideGuide();
});
$('guide-close').addEventListener('click', hideGuide);
$('btn-edit-guide').addEventListener('click', startEditGuide);

guideOverlay.addEventListener('click', (e) => {
  if (!guidePopover.contains(e.target) && !guideHighlight.contains(e.target)) hideGuide();
});

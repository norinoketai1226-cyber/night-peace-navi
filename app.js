const STORAGE_KEY = 'yoruyasumi_state_v1';

const defaultState = {
  wakeTime: '07:00',
  departTime: '08:15',
  sleepHours: 7.5,
  morningPrepMins: 45,
  shiftMinutes: 0,
  lazyMode: false,
  routineSteps: [
    {
      id: 'bath',
      title: '🛁 お風呂・シャワー',
      normalMins: 20,
      lazyMins: 10,
      microAction: 'タオルと着替えを1枚手に取るだけ',
      done: false
    },
    {
      id: 'hair',
      title: '💨 髪を乾かす・保湿',
      normalMins: 10,
      lazyMins: 5,
      microAction: 'ドライヤーのコンセントを挿すだけ',
      done: false
    },
    {
      id: 'teeth',
      title: '🪥 歯磨き・コップ1杯の水',
      normalMins: 5,
      lazyMins: 3,
      microAction: '洗面所の電気をつけるだけ',
      done: false
    },
    {
      id: 'bedprep',
      title: '📱 充電＆明日の安心チェック',
      normalMins: 5,
      lazyMins: 2,
      microAction: 'スマホに充電ケーブルを挿すだけ',
      done: false
    }
  ],
  worries: [],
  top3: ['', '', ''],
  checklist: [
    { id: 'c1', label: '⏰ 明日のアラームをセットした', checked: false },
    { id: 'c2', label: '🔌 スマホを充電器につないだ', checked: false },
    { id: 'c3', label: '👜 明日の持ち物・服をざっくり確認した', checked: false }
  ]
};

let state = loadState();
let activeTimerInterval = null;
let timerSecondsRemaining = 0;
let timerRunning = false;
let currentTimerStepId = null;

// Breathing state
let breathInterval = null;
let breathActive = false;

// Web Audio state
let audioCtx = null;
let noiseNode = null;
let gainNode = null;
let lfoNode = null;

function cloneDefault() {
  return JSON.parse(JSON.stringify(defaultState));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefault();
    const parsed = JSON.parse(raw);
    const base = cloneDefault();
    return {
      ...base,
      ...parsed,
      routineSteps: parsed.routineSteps && parsed.routineSteps.length ? parsed.routineSteps : base.routineSteps,
      checklist: parsed.checklist && parsed.checklist.length ? parsed.checklist : base.checklist
    };
  } catch (e) {
    return cloneDefault();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function showToast(msg) {
  const el = document.getElementById('toastMessage');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 2200);
}

// Time helper functions (minutes from 00:00)
function parseTimeToMins(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function formatMinsToTime(totalMins) {
  const normalized = ((Math.round(totalMins) % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getStepMins(step) {
  return state.lazyMode ? (step.lazyMins || Math.max(2, Math.floor(step.normalMins / 2))) : step.normalMins;
}

function getTotalRoutineMins() {
  return state.routineSteps
    .filter(s => !s.done)
    .reduce((acc, s) => acc + getStepMins(s), 0);
}

function getAllRoutineMins() {
  return state.routineSteps.reduce((acc, s) => acc + getStepMins(s), 0);
}

// Calculate backcast schedule
function computeSchedule() {
  const wakeMins = parseTimeToMins(state.wakeTime);
  const departMins = parseTimeToMins(state.departTime);
  const sleepMins = Math.round(state.sleepHours * 60);

  // Target bedtime = wakeTime - sleepHours + shiftMinutes
  const targetBedMins = wakeMins - sleepMins + state.shiftMinutes;
  const peaceCheckMins = 10; // 10 mins for offloading tomorrow's worries
  const routineTotal = getAllRoutineMins();
  const prepStartMins = targetBedMins - peaceCheckMins - routineTotal;

  // Morning buffer = departMins - wakeMins - morningPrepMins
  let morningWindow = departMins - wakeMins;
  if (morningWindow < 0) morningWindow += 1440;
  const morningBuffer = morningWindow - state.morningPrepMins;

  return {
    wakeMins,
    departMins,
    sleepMins,
    targetBedMins,
    peaceCheckMins,
    routineTotal,
    prepStartMins,
    morningWindow,
    morningBuffer
  };
}

// Calculate how many minutes until a target clock time (handling midnight wrap)
function getMinutesUntil(targetClockMins) {
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const targetNorm = ((Math.round(targetClockMins) % 1440) + 1440) % 1440;
  let diff = targetNorm - nowMins;
  if (diff < -360) diff += 1440;
  if (diff > 1080) diff -= 1440;
  return diff;
}

// Render Top Clock & Reassurance Banner
function updateHeaderAndBanner() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  document.getElementById('liveClock').textContent = `${hh}:${mm}`;

  const sched = computeSchedule();
  const minsToPrep = getMinutesUntil(sched.prepStartMins);
  const minsToBed = getMinutesUntil(sched.targetBedMins);
  const allDone = state.routineSteps.every(s => s.done);

  const banner = document.getElementById('reassuranceBanner');
  const badge = document.getElementById('bannerBadge');
  const mainText = document.getElementById('bannerMainText');
  const subText = document.getElementById('bannerSubText');

  banner.classList.remove('mode-prep', 'mode-sleep');

  // Calculate actual sleep if sleeping in 15 mins or after remaining routine
  const minsToWake = (() => {
    const nowMins = now.getHours() * 60 + now.getMinutes();
    let d = sched.wakeMins - nowMins;
    if (d <= 0) d += 1440;
    return d;
  })();
  const remRoutine = getTotalRoutineMins();
  const achievableSleepMins = Math.max(0, minsToWake - remRoutine - 5);
  const achH = Math.floor(achievableSleepMins / 60);
  const achM = achievableSleepMins % 60;

  if (allDone) {
    banner.classList.add('mode-sleep');
    badge.textContent = '✨ 寝る準備 完了！';
    mainText.textContent = `あとは布団に入るだけ！ (${achH}時間${achM}分 眠れます)`;
    subText.textContent = '「明日の安心」タブで不安を預けて、ゆっくり休みましょう。';
  } else if (minsToPrep > 0) {
    const h = Math.floor(minsToPrep / 60);
    const m = minsToPrep % 60;
    const timeStr = h > 0 ? `${h}時間${m}分` : `${m}分`;
    badge.textContent = '☕ 安心フリータイム';
    mainText.textContent = `${formatMinsToTime(sched.prepStartMins)} の準備開始まで あと ${timeStr}`;
    subText.textContent = `それまでは罪悪感なしで自由に過ごして大丈夫です！`;
  } else if (minsToBed > 0) {
    banner.classList.add('mode-prep');
    const firstTodo = state.routineSteps.find(s => !s.done);
    badge.textContent = '🛁 おやすみ準備タイム';
    mainText.textContent = `今から始めれば ${achH}時間${achM}分 しっかり眠れます`;
    subText.textContent = firstTodo
      ? `まずは「${firstTodo.microAction}」だけでOK！`
      : '1つずつマイペースに進めましょう';
  } else {
    banner.classList.add('mode-prep');
    badge.textContent = '🌙 リカバリー逆算モード';
    mainText.textContent = `今から時短で準備すれば ${achH}時間${achM}分 眠れます！`;
    subText.textContent = '遅れても大丈夫。「時短モード」に切り替えてサッと寝ましょう。';
  }

  // Update Sleep Tab duration pill
  const sleepDurEl = document.getElementById('calcSleepDuration');
  if (sleepDurEl) {
    sleepDurEl.textContent = `${achH}時間${achM}分`;
  }
}

// Render Tab 1: Backcast Timeline
function renderTimelineTab() {
  const sched = computeSchedule();

  document.getElementById('dispWakeTime').textContent = state.wakeTime;
  document.getElementById('dispDepartTime').textContent = state.departTime;
  document.getElementById('dispBedTime').textContent = formatMinsToTime(sched.targetBedMins);

  // Sync inputs only when not actively editing them
  const wakeEl = document.getElementById('inputWakeTime');
  const departEl = document.getElementById('inputDepartTime');
  const sleepEl = document.getElementById('inputSleepHours');
  const prepEl = document.getElementById('inputMorningPrep');

  if (document.activeElement !== wakeEl) wakeEl.value = state.wakeTime;
  if (document.activeElement !== departEl) departEl.value = state.departTime;
  if (document.activeElement !== sleepEl) sleepEl.value = String(state.sleepHours);
  if (document.activeElement !== prepEl) prepEl.value = String(state.morningPrepMins);

  const resetBtn = document.getElementById('btnResetShift');
  if (state.shiftMinutes !== 0) {
    resetBtn.classList.remove('hidden');
    resetBtn.textContent = `元に戻す (+${state.shiftMinutes}分中)`;
  } else {
    resetBtn.classList.add('hidden');
  }

  const shortcutBtn = document.getElementById('btnShortcutMode');
  shortcutBtn.textContent = state.lazyMode ? '⚡ 時短モード適用中' : '⚡ 準備を時短モードに';

  const minsToPrep = getMinutesUntil(sched.prepStartMins);
  const minsToBed = getMinutesUntil(sched.targetBedMins);

  const blocks = [
    {
      time: formatMinsToTime(sched.prepStartMins - 60),
      duration: '〜' + formatMinsToTime(sched.prepStartMins),
      title: '☕ 自由時間（ここまでダラダラOK）',
      desc: `${formatMinsToTime(sched.prepStartMins)} までは何もしなくて大丈夫な時間です`,
      isNow: minsToPrep > 0,
      isMorning: false
    },
    {
      time: formatMinsToTime(sched.prepStartMins),
      duration: `${sched.routineTotal}分間`,
      title: `🛁 寝る準備スタート${state.lazyMode ? '（時短モード）' : ''}`,
      desc: state.routineSteps.map(s => s.title.replace(/^[^\s]+\s/, '')).join(' → '),
      isNow: minsToPrep <= 0 && minsToBed > sched.peaceCheckMins,
      isMorning: false
    },
    {
      time: formatMinsToTime(sched.targetBedMins - sched.peaceCheckMins),
      duration: `${sched.peaceCheckMins}分間`,
      title: '🛡️ 明日の安心セット＆モヤモヤ預け',
      desc: '明日の不安をアプリに書き出して、頭を空っぽにします',
      isNow: minsToBed <= sched.peaceCheckMins && minsToBed > 0,
      isMorning: false
    },
    {
      time: formatMinsToTime(sched.targetBedMins),
      duration: `睡眠 ${ (sched.sleepMins - state.shiftMinutes) / 60 }時間`,
      title: '🌙 布団に入って本日の営業終了',
      desc: '4-7-8呼吸ガイドや雨音でゆっくり目を閉じます',
      isNow: minsToBed <= 0,
      isMorning: false
    },
    {
      time: state.wakeTime,
      duration: `支度 ${state.morningPrepMins}分`,
      title: '☀️ 明日の起床・朝の支度',
      desc: `${state.departTime} の出発まで合計 ${sched.morningWindow}分 あります`,
      isNow: false,
      isMorning: true
    }
  ];

  const listEl = document.getElementById('backcastTimeline');
  listEl.innerHTML = blocks.map(b => `
    <div class="timeline-item ${b.isNow ? 'active-now' : ''} ${b.isMorning ? 'morning-block' : ''}">
      <div class="time-col">
        <span class="time-start">${b.time}</span>
        <span class="time-duration">${b.duration}</span>
      </div>
      <div class="info-col">
        <div class="block-title">
          <span>${b.title}</span>
          ${b.isNow ? '<span class="now-pill">今ここ</span>' : ''}
        </div>
        <p class="block-desc">${b.desc}</p>
      </div>
    </div>
  `).join('');

  // Morning Assurance Card
  const morningCard = document.getElementById('morningAssuranceCard');
  if (sched.morningBuffer >= 15) {
    morningCard.innerHTML = `
      <div class="assurance-header">🌅 明日の朝の安心シミュレーション</div>
      <p class="assurance-body">
        明日 <strong>${state.wakeTime}</strong> に起きれば、支度（${state.morningPrepMins}分）をしても出発（${state.departTime}）まで <strong>あと ${sched.morningBuffer}分の余裕</strong> があります。<br>
        万が一10分寝坊しても十分間に合うので、安心して眠って大丈夫です！
      </p>
    `;
  } else if (sched.morningBuffer >= 0) {
    morningCard.innerHTML = `
      <div class="assurance-header">🌅 明日の朝の安心シミュレーション</div>
      <p class="assurance-body">
        明日 <strong>${state.wakeTime}</strong> に起きれば、出発（${state.departTime}）まで <strong>${sched.morningBuffer}分の余裕</strong> があります。<br>
        今夜のうちに服やカバンを用意しておくと、明日の朝がさらにラクになります✨
      </p>
    `;
  } else {
    morningCard.innerHTML = `
      <div class="assurance-header">💡 明日の朝のゆとりアドバイス</div>
      <p class="assurance-body">
        起床（${state.wakeTime}）から出発（${state.departTime}）までが ${sched.morningWindow}分 です。<br>
        朝の支度を時短するか、起床時刻を少し早めると朝焦らずに済みます。
      </p>
    `;
  }
}

// Render Tab 2: Night Routine
function renderRoutineTab() {
  const remainingSteps = state.routineSteps.filter(s => !s.done);
  const currentStep = remainingSteps[0] || null;
  const doneCount = state.routineSteps.length - remainingSteps.length;

  // Nav badge
  const navBadge = document.getElementById('routineNavBadge');
  navBadge.textContent = remainingSteps.length > 0 ? `${remainingSteps.length}` : '✓';

  // Lazy mode button
  const lazyBtn = document.getElementById('btnToggleLazyMode');
  lazyBtn.classList.toggle('active', state.lazyMode);
  lazyBtn.textContent = state.lazyMode ? '⚡ しんどい日（時短）ON' : '🔋 しんどい日（時短）切替';

  document.getElementById('totalRoutineMins').textContent = getTotalRoutineMins();

  // Hero card update
  const badgeEl = document.getElementById('heroStepBadge');
  const titleEl = document.getElementById('heroStepTitle');
  const microEl = document.getElementById('heroMicroAction');
  const timerDisp = document.getElementById('routineTimerDisplay');
  const timerStatus = document.getElementById('routineTimerStatus');
  const toggleBtn = document.getElementById('btnToggleTimer');

  if (!currentStep) {
    badgeEl.textContent = `🎉 全 ${state.routineSteps.length} ステップ完了！`;
    titleEl.textContent = '寝る準備はすべて終わりました！';
    microEl.textContent = 'あとは「明日の安心」タブをチェックして布団へどうぞ🌙';
    timerDisp.textContent = '00:00';
    timerStatus.textContent = 'おつかれさまでした！';
    toggleBtn.textContent = '🔄 今日のチェックをリセット';
  } else {
    const stepIndex = doneCount + 1;
    badgeEl.textContent = `ステップ ${stepIndex} / ${state.routineSteps.length}`;
    titleEl.textContent = currentStep.title;
    microEl.textContent = currentStep.microAction || 'まずは深呼吸して立ち上がるだけ';

    if (currentTimerStepId !== currentStep.id) {
      stopRoutineTimer();
      currentTimerStepId = currentStep.id;
      timerSecondsRemaining = getStepMins(currentStep) * 60;
    }
    const m = Math.floor(timerSecondsRemaining / 60);
    const s = timerSecondsRemaining % 60;
    timerDisp.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    timerStatus.textContent = timerRunning ? 'カウントダウン中...' : `目安 ${getStepMins(currentStep)}分`;
    toggleBtn.textContent = timerRunning ? '⏸️ 一時停止' : '▶️ このステップを始める';
  }

  // Steps list
  const listEl = document.getElementById('routineStepsList');
  listEl.innerHTML = state.routineSteps.map(step => {
    const isCurrent = currentStep && currentStep.id === step.id;
    const mins = getStepMins(step);
    return `
      <div class="routine-row ${step.done ? 'done' : ''} ${isCurrent ? 'current' : ''}">
        <div class="routine-row-left" data-toggle-step="${step.id}">
          <div class="routine-check">${step.done ? '✓' : ''}</div>
          <div>
            <div class="routine-name">${step.title}</div>
          </div>
        </div>
        <div class="routine-meta">
          <span class="routine-mins-badge">${mins}分</span>
          <button class="btn-del-step" data-del-step="${step.id}" title="削除">✕</button>
        </div>
      </div>
    `;
  }).join('');
}

function toggleRoutineTimer() {
  const remainingSteps = state.routineSteps.filter(s => !s.done);
  if (remainingSteps.length === 0) {
    state.routineSteps.forEach(s => { s.done = false; });
    currentTimerStepId = null;
    saveState();
    renderAll();
    return;
  }

  if (timerRunning) {
    stopRoutineTimer();
    renderRoutineTab();
  } else {
    timerRunning = true;
    renderRoutineTab();
    activeTimerInterval = setInterval(() => {
      if (timerSecondsRemaining > 0) {
        timerSecondsRemaining--;
        const m = Math.floor(timerSecondsRemaining / 60);
        const s = timerSecondsRemaining % 60;
        document.getElementById('routineTimerDisplay').textContent =
          `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      } else {
        playGentleChime();
        completeCurrentStep();
      }
    }, 1000);
  }
}

function stopRoutineTimer() {
  timerRunning = false;
  if (activeTimerInterval) {
    clearInterval(activeTimerInterval);
    activeTimerInterval = null;
  }
}

function completeCurrentStep() {
  stopRoutineTimer();
  const currentStep = state.routineSteps.find(s => !s.done);
  if (currentStep) {
    currentStep.done = true;
    currentTimerStepId = null;
    saveState();
    showToast('✨ 1ステップ完了！えらい！');
    renderAll();
  }
}

// Render Tab 3: Peace of Mind & Anxiety Offload
function renderPeaceTab() {
  // Stored worries
  const wrap = document.getElementById('storedWorriesWrap');
  if (state.worries.length === 0) {
    wrap.innerHTML = '';
  } else {
    wrap.innerHTML = state.worries.map(w => `
      <div class="worry-card">
        <div>
          <div class="worry-card-text">${escapeHtml(w.text)}</div>
          <div class="worry-card-sub">🔒 アプリが保管中（今夜は忘れて大丈夫です）</div>
        </div>
        <button class="btn-del-step" data-del-worry="${w.id}">✕</button>
      </div>
    `).join('');
  }

  // Top 3 inputs
  document.querySelectorAll('.top3-input').forEach(input => {
    const idx = Number(input.dataset.index);
    if (document.activeElement !== input) {
      input.value = state.top3[idx] || '';
    }
  });

  // Checklist
  const checkEl = document.getElementById('peaceChecklist');
  checkEl.innerHTML = state.checklist.map(item => `
    <div class="check-item ${item.checked ? 'checked' : ''}" data-check-id="${item.id}">
      <div class="check-box">${item.checked ? '✓' : ''}</div>
      <span class="check-label">${item.label}</span>
    </div>
  `).join('');
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// 4-7-8 Breathing Guide
function toggleBreathing() {
  const circle = document.getElementById('breathCircle');
  const text = document.getElementById('breathText');
  const sub = document.getElementById('breathSubText');

  if (breathActive) {
    breathActive = false;
    clearTimeout(breathInterval);
    circle.className = 'breath-circle';
    text.textContent = 'タップで開始';
    sub.textContent = '4秒吸って・7秒止めて・8秒かけてゆっくり吐く';
    return;
  }

  breathActive = true;
  runBreathCycle();
}

function runBreathCycle() {
  if (!breathActive) return;
  const circle = document.getElementById('breathCircle');
  const text = document.getElementById('breathText');
  const sub = document.getElementById('breathSubText');

  // Inhale 4s
  circle.className = 'breath-circle inhale';
  text.textContent = '鼻から吸う (4秒)';
  sub.textContent = 'お腹をふくらませるように静かに息を吸います...';

  breathInterval = setTimeout(() => {
    if (!breathActive) return;
    // Hold 7s
    circle.className = 'breath-circle hold';
    text.textContent = '止める (7秒)';
    sub.textContent = '肩の力を抜いて、軽く息をキープします...';

    breathInterval = setTimeout(() => {
      if (!breathActive) return;
      // Exhale 8s
      circle.className = 'breath-circle exhale';
      text.textContent = '口から吐く (8秒)';
      sub.textContent = '「ふぅーっ」と体の中の緊張をすべて吐き出します...';

      breathInterval = setTimeout(() => {
        if (breathActive) runBreathCycle();
      }, 8000);
    }, 7000);
  }, 4000);
}

// Web Audio API Ambient Sound & Chime
function playGentleChime() {
  try {
    const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx = ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(528, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.35);
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);
    osc.connect(g).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 1.2);
  } catch {
    // Ignore audio errors
  }
}

function stopAmbientSound() {
  if (noiseNode) {
    try { noiseNode.stop(); } catch {}
    noiseNode.disconnect();
    noiseNode = null;
  }
  if (lfoNode) {
    try { lfoNode.stop(); } catch {}
    lfoNode.disconnect();
    lfoNode = null;
  }
}

function playAmbientSound(type) {
  stopAmbientSound();
  if (type === 'off') return;

  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // Generate 3 seconds of brown/pink noise buffer
    const bufferSize = audioCtx.sampleRate * 3;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      data[i] = (lastOut + (0.02 * white)) / 1.02;
      lastOut = data[i];
      data[i] *= 2.5;
    }

    noiseNode = audioCtx.createBufferSource();
    noiseNode.buffer = buffer;
    noiseNode.loop = true;

    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = type === 'rain' ? 950 : type === 'waves' ? 450 : 650;

    gainNode = audioCtx.createGain();
    gainNode.gain.value = 0.14;

    if (type === 'waves') {
      lfoNode = audioCtx.createOscillator();
      lfoNode.frequency.value = 0.12; // 8 sec wave cycle
      const lfoGain = audioCtx.createGain();
      lfoGain.gain.value = 0.08;
      lfoNode.connect(lfoGain).connect(gainNode.gain);
      lfoNode.start();
    }

    noiseNode.connect(filter).connect(gainNode).connect(audioCtx.destination);
    noiseNode.start();
  } catch {
    // Ignore if blocked
  }
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === tabId);
  });
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderAll() {
  updateHeaderAndBanner();
  renderTimelineTab();
  renderRoutineTab();
  renderPeaceTab();
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  renderAll();
  setInterval(updateHeaderAndBanner, 15000);

  // Bottom navigation
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Settings drawer toggle
  const toggleBtn = document.getElementById('toggleSettingsBtn');
  const drawer = document.getElementById('settingsDrawer');
  toggleBtn.addEventListener('click', () => {
    const isHidden = drawer.classList.toggle('hidden');
    toggleBtn.textContent = isHidden ? '時間変更 ▼' : '設定を折りたたむ ▲';
  });

  // Summary pills click -> open drawer & focus
  document.querySelectorAll('.clickable-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      drawer.classList.remove('hidden');
      toggleBtn.textContent = '設定を折りたたむ ▲';
      const target = pill.dataset.focus;
      if (target === 'wake') document.getElementById('inputWakeTime').focus();
      if (target === 'depart') document.getElementById('inputDepartTime').focus();
      if (target === 'sleep') document.getElementById('inputSleepHours').focus();
    });
  });

  // +/- 15 min stepper buttons for Wake & Depart times
  document.querySelectorAll('.btn-stepper').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetKey = btn.dataset.stepTarget; // 'wakeTime' or 'departTime'
      const delta = parseInt(btn.dataset.delta, 10) || 0;
      const currentMins = parseTimeToMins(state[targetKey] || '07:00');
      state[targetKey] = formatMinsToTime(currentMins + delta);
      saveState();
      renderAll();
      showToast(`⏰ ${targetKey === 'wakeTime' ? '起床時刻' : '出発時刻'}を ${state[targetKey]} に変更しました`);
    });
  });

  // Time setting changes (listen to both input and change for immediate response)
  function applyTimeSettings() {
    const wakeVal = document.getElementById('inputWakeTime').value;
    const departVal = document.getElementById('inputDepartTime').value;
    if (wakeVal) state.wakeTime = wakeVal;
    if (departVal) state.departTime = departVal;
    state.sleepHours = parseFloat(document.getElementById('inputSleepHours').value) || 7.5;
    state.morningPrepMins = parseInt(document.getElementById('inputMorningPrep').value, 10) || 45;
    saveState();
    renderAll();
  }

  ['inputWakeTime', 'inputDepartTime', 'inputSleepHours', 'inputMorningPrep'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', applyTimeSettings);
    el.addEventListener('change', () => {
      applyTimeSettings();
      showToast('⏰ 逆算スケジュールを更新しました');
    });
  });

  // Rescue buttons
  document.getElementById('btnShift15').addEventListener('click', () => {
    state.shiftMinutes += 15;
    saveState();
    renderAll();
    showToast('🕒 予定を＋15分後ろ倒ししました');
  });

  document.getElementById('btnResetShift').addEventListener('click', () => {
    state.shiftMinutes = 0;
    saveState();
    renderAll();
    showToast('元の目標時間に戻しました');
  });

  document.getElementById('btnShortcutMode').addEventListener('click', () => {
    state.lazyMode = !state.lazyMode;
    currentTimerStepId = null;
    saveState();
    renderAll();
    showToast(state.lazyMode ? '⚡ 時短モードに切り替えました！' : '標準モードに戻しました');
  });

  // Routine controls
  document.getElementById('btnToggleLazyMode').addEventListener('click', () => {
    state.lazyMode = !state.lazyMode;
    currentTimerStepId = null;
    saveState();
    renderAll();
    showToast(state.lazyMode ? '⚡ しんどい日（時短）モードON！' : '標準モードに戻しました');
  });

  document.getElementById('btnToggleTimer').addEventListener('click', toggleRoutineTimer);
  document.getElementById('btnCompleteStep').addEventListener('click', completeCurrentStep);
  document.getElementById('btnSkipStep').addEventListener('click', () => {
    completeCurrentStep();
    showToast('💨 スキップしました（完璧じゃなくてOK！）');
  });

  document.getElementById('routineStepsList').addEventListener('click', (e) => {
    const toggleEl = e.target.closest('[data-toggle-step]');
    const delEl = e.target.closest('[data-del-step]');
    if (toggleEl) {
      const id = toggleEl.dataset.toggleStep;
      const step = state.routineSteps.find(s => s.id === id);
      if (step) {
        step.done = !step.done;
        currentTimerStepId = null;
        saveState();
        renderAll();
      }
    } else if (delEl) {
      const id = delEl.dataset.delStep;
      state.routineSteps = state.routineSteps.filter(s => s.id !== id);
      currentTimerStepId = null;
      saveState();
      renderAll();
    }
  });

  document.getElementById('btnAddStep').addEventListener('click', () => {
    const titleInput = document.getElementById('newStepTitle');
    const minsInput = document.getElementById('newStepMins');
    const title = titleInput.value.trim();
    const mins = Math.max(1, parseInt(minsInput.value, 10) || 5);
    if (!title) return;
    state.routineSteps.push({
      id: 'step_' + Date.now(),
      title: `✨ ${title}`,
      normalMins: mins,
      lazyMins: Math.max(1, Math.floor(mins / 2)),
      microAction: `まずは「${title}」の用意を1つ手に取るだけ`,
      done: false
    });
    titleInput.value = '';
    saveState();
    renderAll();
    showToast('準備ステップを追加しました');
  });

  // Worry offload box
  document.getElementById('btnStoreWorry').addEventListener('click', () => {
    const input = document.getElementById('worryInput');
    const text = input.value.trim();
    if (!text) return;
    state.worries.unshift({
      id: 'w_' + Date.now(),
      text
    });
    input.value = '';
    saveState();
    renderPeaceTab();
    showToast('📦 安心ボックスに預けました！今夜は忘れて大丈夫です');
  });

  document.getElementById('storedWorriesWrap').addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-del-worry]');
    if (delBtn) {
      const id = delBtn.dataset.delWorry;
      state.worries = state.worries.filter(w => w.id !== id);
      saveState();
      renderPeaceTab();
    }
  });

  // Top 3 inputs
  document.querySelectorAll('.top3-input').forEach(input => {
    input.addEventListener('input', () => {
      const idx = Number(input.dataset.index);
      state.top3[idx] = input.value;
      saveState();
    });
  });

  // Checklist
  document.getElementById('peaceChecklist').addEventListener('click', (e) => {
    const row = e.target.closest('[data-check-id]');
    if (!row) return;
    const item = state.checklist.find(c => c.id === row.dataset.checkId);
    if (item) {
      item.checked = !item.checked;
      saveState();
      renderPeaceTab();
    }
  });

  // Shutdown button -> Go to Sleep tab
  document.getElementById('btnStartSleepMode').addEventListener('click', () => {
    playGentleChime();
    switchTab('tab-sleep');
    showToast('🌙 本日の営業を終了しました。おやすみなさい');
  });

  // Breathing circle
  document.getElementById('breathCircle').addEventListener('click', toggleBreathing);

  // Ambient sounds
  document.querySelectorAll('.sound-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sound-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      playAmbientSound(btn.dataset.sound);
    });
  });
});

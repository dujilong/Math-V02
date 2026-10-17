'use strict';

(function () {
  const { ALL_TYPES, TYPE_NAME, BANK_SIZE, SEED, buildQuestions, checkAnswer, publicQuestion, accuracyOf } = window.MathGame;
  const $ = (id) => document.getElementById(id);

  // ---------------- 游戏状态 ----------------
  const state = {
    phase: 'lobby',
    mode: 'timed',
    durationSec: 60,
    targetCount: 10,
    maxNum: 20,
    types: ALL_TYPES.slice(),
    questions: [],
    startAt: 0,
    endAt: 0,
    winner: null,
    endTimer: null,
    tickTimer: null,
    me: { index: 0, correct: 0, wrong: 0, finished: false },
    opp: { index: 0, correct: 0, wrong: 0, finished: false },
  };

  let peer = null;
  let conn = null;
  let typed = '';
  let lock = false;
  let showing = false;

  // ---------------- 连接保活 / 可靠投递 ----------------
  let playerReady = false;          // 参与机是否已发 ready
  let pendingMsg = null;            // 等待手机2 ack 的消息
  let pendingTimer = null;
  let pendingRetries = 0;
  let heartbeatTimer = null;
  let lastPongAt = 0;

  function showScreen(name) { document.body.dataset.view = name; }

  function setAlert(text) {
    const el = $('connbar');
    if (text) { el.textContent = text; el.classList.add('on'); }
    else { el.classList.remove('on'); }
  }

  function hideFlash() {
    showing = false;
    $('flash').classList.remove('on', 'good', 'bad');
  }

  function startHeartbeat() {
    stopHeartbeat();
    lastPongAt = Date.now();
    setAlert('');
    heartbeatTimer = setInterval(() => {
      if (!conn || !conn.open) return;
      const now = Date.now();
      if (now - lastPongAt > 9000) setAlert('与手机2 的连接可能中断，等待其自动重连…');
      send({ type: 'ping', ts: now, phase: state.phase });
    }, 3000);
  }
  function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

  // 关键消息重发直到手机2 确认，避免 DataChannel 假死导致丢包
  function sendReliable(msg) {
    clearPending();
    pendingMsg = msg;
    pendingRetries = 0;
    flushPending();
  }
  function flushPending() {
    if (!pendingMsg) return;
    send(pendingMsg);
    pendingRetries++;
    if (pendingRetries <= 10) {
      pendingTimer = setTimeout(flushPending, 1200);
    } else {
      clearPending();
      setAlert('手机2 未响应，请让手机2 刷新页面重新扫码');
    }
  }
  function clearPending() {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    pendingMsg = null;
    pendingRetries = 0;
  }

  function startPayload() {
    return {
      type: 'start',
      config: {
        mode: state.mode,
        durationSec: state.durationSec,
        targetCount: state.targetCount,
        maxNum: state.maxNum,
        types: state.types,
      },
      question: publicQuestion(state.questions[state.opp.index], state.opp.index),
      oppQuestion: publicQuestion(state.questions[state.me.index], state.me.index),
      startAt: state.startAt,
      endAt: state.endAt,
    };
  }

  function resendCurrentState() {
    if (state.phase === 'playing') send(startPayload());
    else if (state.phase === 'finished') send({ type: 'finished', result: computeResults() });
    else send({ type: 'welcome' });
  }

  // ---------------- PeerJS 连接 ----------------
  function initPeer() {
    $('connStatus').textContent = '正在创建房间…';
    peer = new Peer();

    peer.on('open', (id) => {
      const base = location.origin + location.pathname.replace(/index\.html$/, '');
      const joinUrl = base + 'player.html?room=' + id;
      $('joinUrl').textContent = joinUrl;
      $('qrcode').style.display = 'inline-block';
      new QRCode($('qrcode'), { text: joinUrl, width: 200, height: 200, colorDark: '#1b1040', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
      $('connStatus').textContent = '房间已创建，等待手机2扫码加入…';
      $('connStatus').className = 'conn-status';
    });

    peer.on('connection', (c) => {
      conn = c;
      playerReady = false;
      $('btnStart').disabled = true;
      c.on('open', () => {
        setAlert('');
        $('connStatus').textContent = '手机2 已加入，等待就绪…';
        send({ type: 'welcome' });
        // 重连后立即把当前状态同步给手机2
        resendCurrentState();
      });
      c.on('data', onPlayerData);
      c.on('close', () => {
        stopHeartbeat();
        clearPending();
        playerReady = false;
        if (state.phase !== 'finished') {
          setAlert('手机2 已断开，请重新扫码加入');
          $('btnStart').disabled = true;
        }
      });
      c.on('error', (e) => console.error('host conn error', e));
    });

    peer.on('error', (err) => {
      console.error('Peer 错误:', err);
      setAlert('连接失败，请刷新重试（' + err.type + '）');
    });
  }

  function send(msg) { if (conn && conn.open) conn.send(msg); }

  function onPlayerData(data) {
    if (!data || !data.type) return;
    switch (data.type) {
      case 'ready':
        playerReady = true;
        lastPongAt = Date.now();
        setAlert('');
        $('connStatus').textContent = '手机2 已就绪，可以开始比赛';
        $('connStatus').classList.add('ok');
        if (state.phase === 'lobby') $('btnStart').disabled = false;
        startHeartbeat();
        break;
      case 'pong':
        lastPongAt = Date.now();
        setAlert('');
        if (state.phase === 'lobby' && playerReady) {
          $('connStatus').textContent = '手机2 已就绪，可以开始比赛';
          $('connStatus').classList.add('ok');
        }
        break;
      case 'ack':
        if (pendingMsg && data.of === pendingMsg.type) clearPending();
        break;
      case 'resync':
        resendCurrentState();
        break;
      case 'answer':
        handlePlayerAnswer(data);
        break;
    }
  }

  function handlePlayerAnswer(data) {
    if (state.phase !== 'playing' || state.opp.finished) return;
    const q = state.questions[state.opp.index];
    if (!q || data.index !== state.opp.index) return;

    const ok = checkAnswer(q, data.value);
    if (ok) state.opp.correct++; else state.opp.wrong++;
    state.opp.index++;
    updateOppUI();

    const nextQ = state.questions[state.opp.index] || null;
    send({
      type: 'feedback',
      ok,
      answer: q.type === 'cmp' ? q.answer : String(q.answer),
      correct: state.opp.correct,
      wrong: state.opp.wrong,
      nextQuestion: publicQuestion(nextQ, state.opp.index),
    });

    if (state.mode === 'target' && state.opp.correct >= state.targetCount) {
      finishTarget('B');
    }
  }

  // ---------------- 题目 / 答题 ----------------
  function currentQuestion() { return state.questions[state.me.index] || null; }

  function submitMyAnswer(value) {
    if (lock || state.phase !== 'playing') return;
    const q = currentQuestion();
    if (!q) return;
    lock = true;
    $('pad').querySelectorAll('button').forEach((b) => b.disabled = true);
    $('cmpKeys').querySelectorAll('button').forEach((b) => b.disabled = true);
    if (q.type === 'cmp') { $('slotCmp').textContent = opLabel(value); $('slotCmp').classList.add('filled'); }
    else { $('slot').textContent = value; $('slot').classList.add('filled'); }

    const ok = checkAnswer(q, value);
    if (ok) state.me.correct++; else state.me.wrong++;
    state.me.index++;
    // 把主机自己的进度同步给参与机（参与机看到的对手进度条）
    send({ type: 'oppProgress', correct: state.me.correct, wrong: state.me.wrong });
    updateMyUI();
    showFlash(ok, q.type === 'cmp' ? q.answer : String(q.answer));

    if (state.mode === 'target' && state.me.correct >= state.targetCount) {
      finishTarget('A');
    }
  }

  function opLabel(op) { return op === '>' ? '＞' : op === '<' ? '＜' : '＝'; }

  // ---------------- 开始 / 结束 ----------------
  function startGame() {
    state.questions = buildQuestions(state.maxNum, BANK_SIZE, SEED, state.types);
    state.me = { index: 0, correct: 0, wrong: 0, finished: false };
    state.opp = { index: 0, correct: 0, wrong: 0, finished: false };
    state.phase = 'playing';
    state.winner = null;
    state.startAt = Date.now();
    typed = ''; lock = false;
    hideFlash();

    if (state.mode === 'timed') {
      state.endAt = state.startAt + state.durationSec * 1000;
      state.endTimer = setTimeout(finishTimed, state.durationSec * 1000 + 60);
      state.tickTimer = setInterval(tickClock, 100);
    } else {
      state.endAt = 0;
    }

    showScreen('playing');
    renderPlay();
    renderResultEmpty();
    tickClock();
    sendReliable(startPayload());
  }

  function finishTimed() {
    if (state.phase !== 'playing') return;
    endGame(computeResults());
  }

  function finishTarget(winner) {
    state.me.finished = true;
    state.opp.finished = true;
    endGame(computeResults(winner));
  }

  function endGame(result) {
    clearTimers();
    clearPending();
    state.phase = 'finished';
    state.winner = result.winner;
    hideFlash();
    lock = false;
    showScreen('result');
    renderResult(result);
    sendReliable({ type: 'finished', result });
  }

  function clearTimers() {
    if (state.endTimer) { clearTimeout(state.endTimer); state.endTimer = null; }
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
  }

  function computeResults(targetWinner) {
    const me = state.me, opp = state.opp;
    const a = accuracyOf(me.correct, me.wrong);
    const b = accuracyOf(opp.correct, opp.wrong);
    const result = {
      mode: state.mode,
      me: { correct: me.correct, wrong: me.wrong, accuracy: a, elapsedMs: 0 },
      opp: { correct: opp.correct, wrong: opp.wrong, accuracy: b, elapsedMs: 0 },
      winner: null, tie: false,
    };
    if (state.mode === 'target') {
      result.winner = targetWinner || state.winner;
      result.me.elapsedMs = result.winner === 'A' ? Date.now() - state.startAt : 0;
      result.opp.elapsedMs = result.winner === 'B' ? Date.now() - state.startAt : 0;
    } else {
      if (a > b) result.winner = 'A';
      else if (b > a) result.winner = 'B';
      else result.tie = true;
    }
    return result;
  }

  function resetGame() {
    clearTimers();
    clearPending();
    state.phase = 'lobby';
    state.winner = null;
    state.questions = [];
    state.me = { index: 0, correct: 0, wrong: 0, finished: false };
    state.opp = { index: 0, correct: 0, wrong: 0, finished: false };
    typed = ''; lock = false;
    hideFlash();
    showScreen('lobby');
    if (playerReady && conn && conn.open) {
      $('connStatus').textContent = '手机2 已就绪，可以开始比赛';
      $('connStatus').classList.add('ok');
      $('btnStart').disabled = false;
    } else {
      $('connStatus').textContent = '等待手机2扫码加入…';
      $('connStatus').classList.remove('ok');
      $('btnStart').disabled = true;
    }
    if (conn && conn.open) sendReliable({ type: 'reset' });
  }

  // ---------------- UI 渲染 ----------------
  function flower(cls, big) {
    const size = big ? 'flower-big ' : '';
    return '<svg class="fl ' + size + cls + '" viewBox="0 0 24 24"><g fill="currentColor">' +
      '<ellipse cx="12" cy="5.6" rx="3.2" ry="4.4"/>' +
      '<ellipse cx="12" cy="5.6" rx="3.2" ry="4.4" transform="rotate(72 12 12)"/>' +
      '<ellipse cx="12" cy="5.6" rx="3.2" ry="4.4" transform="rotate(144 12 12)"/>' +
      '<ellipse cx="12" cy="5.6" rx="3.2" ry="4.4" transform="rotate(216 12 12)"/>' +
      '<ellipse cx="12" cy="5.6" rx="3.2" ry="4.4" transform="rotate(288 12 12)"/>' +
      '</g><circle cx="12" cy="12" r="2.8"/></svg>';
  }

  // 每次都按当前题号完整重绘，不做任何“跳过重绘”的提前返回
  function renderPlay() {
    updateMyUI();
    updateOppUI();
    $('pclock').classList.toggle('hide', state.mode !== 'timed');

    const q = currentQuestion();
    if (!q) return;

    const isCmp = q.type === 'cmp';
    $('expr').hidden = isCmp;
    $('cmpWrap').hidden = !isCmp;
    $('pad').style.display = isCmp ? 'none' : 'grid';

    typed = '';
    $('pad').querySelectorAll('button').forEach((b) => b.disabled = false);
    $('cmpKeys').querySelectorAll('button').forEach((b) => b.disabled = false);

    if (isCmp) {
      $('cmpL').textContent = q.left;
      $('cmpR').textContent = q.right;
      $('slotCmp').textContent = '?';
      $('slotCmp').classList.remove('filled');
    } else {
      $('exprText').textContent = q.text;
      $('slot').textContent = '?';
      $('slot').classList.remove('filled');
    }
  }

  function updateMyUI() {
    $('midInfo').textContent = state.mode === 'target'
      ? '已答对 ' + state.me.correct + ' / ' + state.targetCount + ' 题'
      : '已答对 ' + state.me.correct + ' 题';
    $('mini').innerHTML = '<span class="g">' + flower('red') + ' 小红花 × ' + state.me.correct + '</span>' +
      '<span class="g">' + flower('yellow') + ' 小黄花 × ' + state.me.wrong + '</span>';
  }

  function updateOppUI() {
    const opp = state.opp;
    $('oppStat').textContent = opp.correct + ' 对 / ' + opp.wrong + ' 错';
    const pct = state.mode === 'target'
      ? Math.min(100, (opp.correct / state.targetCount) * 100)
      : Math.min(100, opp.correct * 5);
    $('oppBarInner').style.width = pct + '%';
  }

  function tickClock() {
    const ms = Math.max(0, state.endAt - Date.now());
    const sec = Math.ceil(ms / 1000);
    const el = $('pclock');
    el.textContent = String(sec).padStart(2, '0');
    el.classList.toggle('warn', sec <= 10);
  }

  function renderResult(r) {
    showScreen('result');
    const isWin = state.mode === 'target' ? r.winner === 'A' : (r.me.accuracy > r.opp.accuracy || r.tie);
    $('verdict').textContent = isWin ? '你真棒！' : '继续加油！';
    $('verdict').classList.toggle('cheer', !isWin);

    $('rstat').innerHTML = '答对 <b>' + r.me.correct + '</b> 题　答错 <b>' + r.me.wrong + '</b> 题' +
      (r.mode === 'timed' ? '<br>准确率 <b>' + Math.round(r.me.accuracy * 100) + '%</b>' : '');

    let box = '<div class="row"><span>我（选手1）</span><b>' + (isWin ? '你真棒！' : '继续加油！') + '</b></div>' +
      '<div class="row"><span>选手2</span><b>' + (!isWin ? '你真棒！' : '继续加油！') + '</b></div>' +
      '<div class="row"><span>选手1 答题</span><b>' + r.me.correct + ' 对 / ' + r.me.wrong + ' 错</b></div>' +
      '<div class="row"><span>选手2 答题</span><b>' + r.opp.correct + ' 对 / ' + r.opp.wrong + ' 错</b></div>';
    if (r.mode === 'timed') {
      box += '<div class="row"><span>选手1 准确率</span><b>' + Math.round(r.me.accuracy * 100) + '%</b></div>' +
        '<div class="row"><span>选手2 准确率</span><b>' + Math.round(r.opp.accuracy * 100) + '%</b></div>';
    }
    $('resBox').innerHTML = box;
  }

  // 开赛时清空上一局的结果内容，避免残留
  function renderResultEmpty() {
    $('resBox').innerHTML = '';
    $('rstat').innerHTML = '';
  }

  // ---------------- 反馈浮层 ----------------
  function showFlash(ok, answer) {
    showing = true;
    const f = $('flash');
    f.classList.add('on');
    f.classList.toggle('good', ok);
    f.classList.toggle('bad', !ok);
    $('flashIcon').innerHTML = flower(ok ? 'red' : 'yellow', true);
    $('flashMsg').textContent = ok ? '答对啦！' : '答错了';
    $('flashAns').textContent = ok ? '+1 小红花' : '正确答案是 ' + answer;
    $('btnNext').textContent = '下一题 ▶';
  }

  function dismissFlash() {
    if (!showing) return;
    hideFlash();
    lock = false;
    if (state.phase === 'playing') renderPlay();
  }
  // 结束游戏时若浮层还在最上层，点它直接进结果页
  function onFlashButton() {
    if (state.phase === 'finished') { hideFlash(); return; }
    dismissFlash();
  }

  // ---------------- 交互 ----------------
  $('segMode').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#segMode button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    state.mode = b.dataset.val;
    $('optDuration').style.display = state.mode === 'timed' ? '' : 'none';
    $('optTarget').style.display = state.mode === 'target' ? '' : 'none';
  });
  document.querySelectorAll('.opt select').forEach((sel) => {
    sel.addEventListener('change', () => { state[sel.dataset.key] = Number(sel.value); });
  });
  $('btnTypes').addEventListener('click', (e) => { e.stopPropagation(); $('typePanel').hidden = !$('typePanel').hidden; });
  document.addEventListener('click', (e) => {
    if (!$('typePanel').hidden && !e.target.closest('.typewrap')) $('typePanel').hidden = true;
  });
  const collectTypes = () => Array.prototype.filter
    .call(document.querySelectorAll('#typePanel input[type=checkbox]'), (c) => c.checked)
    .map((c) => c.value);
  $('typePanel').addEventListener('change', () => {
    const types = collectTypes();
    if (!types.length) {
      document.querySelectorAll('#typePanel input[type=checkbox]').forEach((c) => c.checked = true);
      state.types = ALL_TYPES.slice();
      $('typeCount').textContent = '5/5';
      return;
    }
    state.types = types;
    $('typeCount').textContent = types.length + '/5';
  });
  $('btnTypeAll').addEventListener('click', () => {
    document.querySelectorAll('#typePanel input[type=checkbox]').forEach((c) => c.checked = true);
    state.types = ALL_TYPES.slice(); $('typeCount').textContent = '5/5';
  });
  $('btnTypeInvert').addEventListener('click', () => {
    document.querySelectorAll('#typePanel input[type=checkbox]').forEach((c) => { c.checked = !c.checked; });
    const types = collectTypes();
    if (!types.length) { document.querySelectorAll('#typePanel input[type=checkbox]').forEach((c) => c.checked = true); state.types = ALL_TYPES.slice(); }
    else state.types = types;
    $('typeCount').textContent = state.types.length + '/5';
  });

  $('btnStart').addEventListener('click', () => {
    if (!conn || !conn.open) { $('connStatus').textContent = '请等待手机2 扫码加入'; return; }
    startGame();
  });
  $('btnAgain').addEventListener('click', resetGame);
  $('btnNext').addEventListener('click', (e) => { e.stopPropagation(); onFlashButton(); });

  $('pad').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || lock) return;
    const k = b.dataset.k;
    if (k === 'del') typed = typed.slice(0, -1);
    else if (k === 'ok') { if (typed) submitMyAnswer(typed); return; }
    else if (typed.length < 4) typed = (typed === '0' ? '' : typed) + k;
    $('slot').textContent = typed === '' ? '?' : typed;
    $('slot').classList.toggle('filled', typed !== '');
  });
  $('cmpKeys').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || lock) return;
    submitMyAnswer(b.dataset.op);
  });
  document.addEventListener('keydown', (e) => {
    if (showing && (e.key === 'Enter' || e.key === ' ')) { onFlashButton(); return; }
    if (document.body.dataset.view !== 'playing' || lock) return;
    if (/^[0-9]$/.test(e.key)) {
      if (!currentQuestion() || currentQuestion().type === 'cmp') return;
      if (typed.length < 4) typed = (typed === '0' ? '' : typed) + e.key;
      $('slot').textContent = typed === '' ? '?' : typed;
      $('slot').classList.toggle('filled', typed !== '');
    } else if (e.key === 'Backspace') {
      typed = typed.slice(0, -1);
      $('slot').textContent = typed === '' ? '?' : typed;
      $('slot').classList.toggle('filled', typed !== '');
    } else if (e.key === 'Enter') {
      if (typed) submitMyAnswer(typed);
    } else if (['>', '<', '='].includes(e.key) && currentQuestion() && currentQuestion().type === 'cmp') {
      submitMyAnswer(e.key);
    }
  });

  initPeer();
})();

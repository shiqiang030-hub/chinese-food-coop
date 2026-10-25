(() => {
  const $ = (id) => document.getElementById(id);
  const codeInput = $('room-code-input');
  const statusLine = $('room-status');

  // ===== 游戏配置 =====
  const STAGES = [
    { name: '备料', icon: '🥬', window: 2200, relay: 1, desc: '动作在两人之间交替，窗口期越来越短' },
    { name: '和面', icon: '🥣', window: 1900, relay: 1, desc: '注意 🔁 接力，传给搭档要接住' },
    { name: '擀皮', icon: '🥟', window: 1600, relay: 1, desc: '时机越靠前，越是完美' },
    { name: '包制', icon: '🥟', window: 1400, relay: 2, desc: '两道接力！手要稳' },
    { name: '下锅', icon: '🍲', window: 1200, relay: 2, desc: '最后一搏，火候就是胜负手' }
  ];
  const TIME_LIMIT = 75;      // 秒
  const MAX_MISS = 6;         // 最大失误数
  const PERFECT_PAD = 0.35;   // 窗口前段判定 Perfect
  const COINS_KEY = 'browsercoop_coins';

  const defaultState = () => ({
    phase: 'idle',            // idle | playing | over
    outcome: null,            // complete | timeout | misses
    stage: 0,
    stageProgress: 0,
    queue: [],
    action: null,
    combo: 0, bestCombo: 0,
    perfect: 0, good: 0, miss: 0,
    score: 0, coins: 0, stars: 0,
    timeLeft: TIME_LIMIT,
    startedAt: 0,
    totalCoins: 0
  });

  let peer = null;
  let connection = null;
  let isHost = false;
  let connected = false;
  let roomCode = '';
  let gameState = defaultState();
  let timerHandle = null;
  let actionTimer = null;
  let toastHandle = null;
  let hostOffset = 0;         // 客人端时间校准（仅用于视觉）

  // ===== 房间工具 =====
  const setStatus = (message) => { statusLine.textContent = message; };
  const showToast = (message) => {
    const toast = $('toast'); toast.textContent = message; toast.classList.add('show');
    clearTimeout(toastHandle); toastHandle = setTimeout(() => toast.classList.remove('show'), 2300);
  };
  const setPartner = (online) => {
    $('partner-state').textContent = online ? '已加入，准备好了' : '还没加入';
    $('partner-dot').classList.toggle('offline', !online);
  };
  const loadCoins = () => { try { return parseInt(localStorage.getItem(COINS_KEY) || '0', 10) || 0; } catch (e) { return 0; } };
  const saveCoins = (v) => { try { localStorage.setItem(COINS_KEY, String(v)); } catch (e) {} return v; };

  // ===== 动作队列 =====
  const buildQueue = (stageIndex) => {
    const cfg = STAGES[stageIndex];
    const q = [];
    const owners = ['host', 'guest'];
    let oi = 0;
    for (let i = 0; i < 4; i++) {
      q.push({ type: 'tap', owner: owners[oi % 2] });
      oi++;
      if (i === 1 && cfg.relay >= 1) q.push({ type: 'relay', sendOwner: owners[oi % 2] });
      if (i === 3 && cfg.relay >= 2) q.push({ type: 'relay', sendOwner: owners[(oi + 1) % 2] });
    }
    return q;
  };

  // ===== 核心流程（房主权威）=====
  const publishState = () => {
    updateGameView();
    if (isHost && connection && connection.open) connection.send({ type: 'state', state: gameState });
  };

  const applyResult = (kind) => {
    const s = gameState;
    if (kind === 'perfect') { s.perfect++; s.combo++; s.stageProgress = Math.min(100, s.stageProgress + 22); s.timeLeft = Math.min(TIME_LIMIT, s.timeLeft + 0.8); }
    else if (kind === 'good') { s.good++; s.combo++; s.stageProgress = Math.min(100, s.stageProgress + 16); s.timeLeft += 0.3; }
    else if (kind === 'relay') { s.perfect++; s.combo += 2; s.stageProgress = Math.min(100, s.stageProgress + 26); s.timeLeft = Math.min(TIME_LIMIT, s.timeLeft + 1.2); }
    else { s.miss++; s.combo = 0; s.stageProgress = Math.max(0, s.stageProgress - 6); s.timeLeft -= 1.5; }
    s.bestCombo = Math.max(s.bestCombo, s.combo);
    s.timeLeft = Math.max(0, Math.min(TIME_LIMIT, s.timeLeft));
    if (s.miss >= MAX_MISS) { endGame('misses'); return; }
    if (s.timeLeft <= 0) { endGame('timeout'); return; }
    flashFeedback(kind);
    scheduleNext();
  };

  const scheduleNext = () => {
    clearTimeout(actionTimer);
    actionTimer = setTimeout(() => {
      if (gameState.phase !== 'playing') return;
      if (gameState.stageProgress >= 100) { advanceStage(); return; }
      nextAction();
    }, 700);
  };

  const nextAction = () => {
    const q = gameState.queue;
    if (!q.length) { advanceStage(); return; }
    const cfg = STAGES[gameState.stage];
    const a = q.shift();
    gameState.action = { ...a, id: Date.now(), startAt: Date.now(), window: cfg.window, phase: 'send', sendAt: 0, done: false };
    armTimeout();
    publishState();
  };

  const armTimeout = () => {
    clearTimeout(actionTimer);
    const a = gameState.action;
    if (!a) return;
    actionTimer = setTimeout(() => {
      if (gameState.phase !== 'playing') return;
      const cur = gameState.action;
      if (!cur || cur.done || cur.id !== a.id) return;
      cur.done = true;
      applyResult('miss');
    }, a.window + 400);
  };

  const advanceStage = () => {
    gameState.stage += 1;
    gameState.stageProgress = 0;
    if (gameState.stage >= STAGES.length) { endGame('complete'); return; }
    gameState.queue = buildQueue(gameState.stage);
    gameState.action = null;
    clearTimeout(actionTimer);
    actionTimer = setTimeout(() => {
      if (gameState.phase !== 'playing') return;
      nextAction();
    }, 1100);
    publishState();
  };

  // ===== 判定（房主侧）=====
  const judgeTap = (owner) => {
    const a = gameState.action;
    if (!a || a.done || a.type !== 'tap' || a.owner !== owner) return;
    const elapsed = Date.now() - a.startAt;
    a.done = true;
    if (elapsed <= a.window) applyResult(elapsed <= a.window * PERFECT_PAD ? 'perfect' : 'good');
    else applyResult('miss');
  };

  const judgeRelaySend = () => {
    const a = gameState.action;
    if (!a || a.done || a.type !== 'relay' || a.phase !== 'send') return;
    a.phase = 'recv';
    a.sendAt = Date.now();
    publishState();
  };

  const judgeRelayRecv = () => {
    const a = gameState.action;
    if (!a || a.done || a.type !== 'relay' || a.phase !== 'recv') return;
    const elapsed = Date.now() - a.startAt;
    a.done = true;
    if (a.sendAt > 0 && elapsed <= a.window) applyResult('relay');
    else applyResult('miss');
  };

  // ===== 开始 / 结束 / 重开 =====
  const startGame = () => {
    if (!isHost || !connected || gameState.phase !== 'idle') return;
    gameState = {
      ...defaultState(),
      phase: 'playing',
      startedAt: Date.now(),
      timeLeft: TIME_LIMIT,
      queue: buildQueue(0),
      totalCoins: loadCoins()
    };
    clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      if (gameState.phase !== 'playing') { clearInterval(timerHandle); return; }
      gameState.timeLeft -= 1;
      if (gameState.timeLeft <= 0) { gameState.timeLeft = 0; endGame('timeout'); return; }
      publishState();
    }, 1000);
    clearTimeout(actionTimer);
    actionTimer = setTimeout(() => {
      if (gameState.phase === 'playing') nextAction();
    }, 1300);
    publishState();
  };

  const endGame = (outcome) => {
    clearInterval(timerHandle);
    clearTimeout(actionTimer);
    const s = gameState;
    s.phase = 'over';
    s.outcome = outcome;
    s.action = null;
    if (outcome === 'complete') {
      s.score = 40 + s.perfect * 5 + s.good * 2 + s.bestCombo * 2 + Math.round(s.timeLeft * 1.2);
      s.stars = s.score >= 150 ? 3 : s.score >= 110 ? 2 : s.score >= 70 ? 1 : 0;
      s.coins = s.perfect * 2 + s.stars * 15;
    } else {
      s.stars = 0;
      s.coins = s.perfect;
    }
    s.totalCoins = saveCoins(s.totalCoins + s.coins);
    publishState();
  };

  const resetGame = () => {
    if (!isHost) { showToast('请让房主发起再挑战'); return; }
    clearInterval(timerHandle);
    clearTimeout(actionTimer);
    const keepCoins = gameState.totalCoins;
    gameState = { ...defaultState(), totalCoins: keepCoins };
    publishState();
  };

  // ===== UI 渲染 =====
  const flashFeedback = (kind) => {
    const el = $('feedback');
    const map = {
      perfect: { cls: 'perfect', text: 'PERFECT 完美！' },
      good: { cls: 'good', text: 'GOOD 不错' },
      miss: { cls: 'miss', text: 'MISS 失误！' },
      relay: { cls: 'relay', text: '默契接力 +26！' }
    };
    const m = map[kind] || map.good;
    el.className = 'feedback ' + m.cls;
    el.textContent = m.text;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'feedback'; el.textContent = ''; }, 750);
  };

  const renderStars = (stars) => {
    const el = $('stars');
    let html = '';
    for (let i = 0; i < 3; i++) {
      html += `<span class="star ${i < stars ? 'on' : 'dim'}" style="animation-delay:${i * 0.22}s">★</span>`;
    }
    el.innerHTML = html;
  };

  const updateGameView = () => {
    const s = gameState;
    const stage = STAGES[Math.min(s.stage, STAGES.length - 1)];

    $('game-card').classList.toggle('hidden', !connected);
    $('game-title').textContent = s.phase === 'over' ? '挑战结束' : '饺子接力挑战';

    const t = Math.max(0, Math.ceil(s.timeLeft));
    $('timer').textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    $('timer').classList.toggle('low', t <= 10);
    $('combo-badge').classList.toggle('hidden', s.combo < 2);
    $('combo-count').textContent = `x${s.combo}`;

    $('stage-name').textContent = s.phase === 'idle' ? '准备开火' : s.phase === 'over' ? '挑战结束' : `${stage.name}`;
    $('stage-progress').style.width = `${s.phase === 'over' && s.outcome === 'complete' ? 100 : Math.min(100, s.stageProgress)}%`;
    $('stage-count').textContent = `${Math.min(s.stage + (s.phase === 'playing' ? 1 : 0), STAGES.length)}/${STAGES.length}`;

    $('action-icon').textContent = s.phase === 'idle' ? '🥢' : s.phase === 'over' ? (s.outcome === 'complete' ? '🎉' : '😵') : stage.icon;
    $('action-kicker').textContent = s.phase === 'playing' ? `STEP 0${s.stage + 1} · ${stage.name}` : s.phase === 'over' ? 'GAME OVER' : 'READY';
    $('action-icon').classList.toggle('own', !!(s.phase === 'playing' && s.action && s.action.type === 'tap' && s.action.owner === (isHost ? 'host' : 'guest')));

    const btn = $('action-button');
    btn.className = 'action-button';
    if (s.phase === 'idle') {
      btn.disabled = false;
      btn.innerHTML = '准备好了，开始做！ <span>✦</span>';
      $('action-hint').textContent = '两个人都准备好后，由房主开火';
      $('chef-turn').textContent = '两个人都准备好后，由房主开火';
    } else if (s.phase === 'over') {
      btn.disabled = true;
      btn.innerHTML = s.outcome === 'complete' ? '这局完成啦 <span>✓</span>' : '这局失败啦 <span>✕</span>';
      $('action-hint').textContent = s.outcome === 'complete' ? '完美收工，看看你们的成绩！' : s.outcome === 'timeout' ? '时间用完了，饺子糊锅了…' : '失误太多，厨房一团糟…';
    } else {
      const a = s.action;
      if (!a) {
        btn.disabled = true;
        btn.innerHTML = '准备下一波… <span>⏳</span>';
        $('action-hint').textContent = '工序衔接中，马上就好';
      } else if (a.type === 'tap') {
        const mine = a.owner === (isHost ? 'host' : 'guest');
        btn.disabled = !mine;
        btn.innerHTML = mine ? '快！点这里！ <span>⚡</span>' : '等待搭档完成…';
        if (mine) btn.classList.add('ready');
        $('action-hint').textContent = mine ? `轮到你了！${Math.round(a.window / 1000)} 秒内出手` : '搭档正在操作，马上传给你';
      } else {
        const sendMine = a.sendOwner === (isHost ? 'host' : 'guest');
        const isSendPhase = a.phase === 'send';
        const mineNow = isSendPhase ? sendMine : !sendMine;
        btn.disabled = !mineNow;
        btn.classList.add('relay');
        if (mineNow) {
          btn.innerHTML = isSendPhase ? '传给搭档！ <span>🔁</span>' : '接住！ <span>🖐️</span>';
          $('action-hint').textContent = isSendPhase ? '把这一棒传出去！' : '快接住搭档传来的！';
        } else {
          btn.innerHTML = isSendPhase ? '搭档正在传来…' : '等搭档接住…';
          $('action-hint').textContent = isSendPhase ? '搭档即将把动作传给你' : '搭档还没接住';
        }
      }
      $('chef-turn').textContent = `本工序 ${STAGES[Math.min(s.stage, STAGES.length - 1)].name} · 连击 x${s.combo}`;
    }

    $('miss-count').textContent = `${s.miss}`;
    $('perfect-count').textContent = `${s.perfect}`;

    $('result').classList.toggle('hidden', s.phase !== 'over');
    if (s.phase === 'over') {
      renderStars(s.stars);
      const ok = s.outcome === 'complete';
      $('result-title').textContent = ok ? (s.stars === 3 ? '神仙搭档！' : s.stars === 2 ? '默契不错！' : '勉强上桌！') : '挑战失败…';
      $('result-copy').textContent = ok
        ? `评分 ${s.score} 分 · 完美 ${s.perfect} · 失误 ${s.miss}`
        : s.outcome === 'timeout' ? '时间耗尽，饺子糊了。再来一次？' : '失误太多，厨房乱了套。再来一次？';
      $('reward-coins').textContent = `+${s.coins}`;
      $('total-coins').textContent = `${s.totalCoins}`;
      const total = s.perfect + s.good + s.miss;
      const sync = total ? Math.round((s.perfect + s.good) / total * 100) : 0;
      $('sync-rate').textContent = `${sync}%`;
      $('best-combo').textContent = `x${s.bestCombo}`;
      $('title-badge').textContent = s.stars === 3 ? '黄金搭档' : s.stars === 2 ? '默契新星' : s.stars === 1 ? '厨房学徒' : '手忙脚乱';
    }
  };

  // ===== 网络与输入 =====
  const handleAction = (message) => {
    if (!message || typeof message !== 'object') return;
    if (isHost) {
      if (message.type === 'start') startGame();
      if (message.type === 'tap' && gameState.phase === 'playing') judgeTap('guest');
      if (message.type === 'relay-send') judgeRelaySend();
      if (message.type === 'relay-recv') judgeRelayRecv();
      if (message.type === 'again') resetGame();
    } else if (message.type === 'state' && message.state) {
      gameState = { ...defaultState(), ...message.state };
      if (message.state.startedAt) hostOffset = message.state.startedAt - Date.now();
      updateGameView();
    }
  };

  const wireConnection = (conn) => {
    connection = conn;
    conn.on('open', () => {
      connected = true;
      $('room-actions').classList.add('hidden');
      $('invite-panel').classList.toggle('hidden', !isHost);
      $('room-code').textContent = roomCode;
      $('you-state').textContent = isHost ? '厨房已开好 · 房主' : '已进入厨房';
      setPartner(true);
      setStatus(isHost ? '搭档到齐了！准备开火。' : '加入成功，等房主开始挑战。');
      if (isHost) { gameState.totalCoins = loadCoins(); conn.send({ type: 'state', state: gameState }); }
      updateGameView();
    });
    conn.on('data', handleAction);
    conn.on('close', () => {
      connected = false; setPartner(false); setStatus('搭档断开了连接；可以重新加入这个房间。'); updateGameView();
    });
    conn.on('error', () => { setStatus('连接出了点问题，请检查房间码和网络后重试。'); });
  };

  const cleanPeer = () => {
    if (peer) peer.destroy();
    peer = null; connection = null; connected = false; isHost = false; roomCode = '';
    clearInterval(timerHandle);
    clearTimeout(actionTimer);
  };

  const onActionButton = () => {
    if (!connected) return;
    const s = gameState;
    if (s.phase === 'idle') {
      if (isHost) startGame(); else if (connection && connection.open) connection.send({ type: 'start' });
      return;
    }
    if (s.phase !== 'playing' || !s.action) return;
    const a = s.action;
    if (isHost) {
      if (a.type === 'tap' && a.owner === 'host') judgeTap('host');
      else if (a.type === 'relay') {
        if (a.phase === 'send' && a.sendOwner === 'host') judgeRelaySend();
        else if (a.phase === 'recv' && a.sendOwner !== 'host') judgeRelayRecv();
      }
    } else if (connection && connection.open) {
      if (a.type === 'tap' && a.owner === 'guest') connection.send({ type: 'tap' });
      else if (a.type === 'relay') {
        if (a.phase === 'send' && a.sendOwner === 'guest') connection.send({ type: 'relay-send' });
        else if (a.phase === 'recv' && a.sendOwner !== 'guest') connection.send({ type: 'relay-recv' });
      }
    }
  };

  // ===== 房间事件 =====
  $('create-room').addEventListener('click', () => {
    if (!window.Peer) { showToast('联机组件没能加载，请检查网络后刷新'); return; }
    cleanPeer();
    isHost = true;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    roomCode = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    $('you-state').textContent = '正在创建…';
    setStatus('正在开厨房……');
    $('create-room').disabled = true;
    peer = new Peer(roomCode, { debug: 1 });
    peer.on('open', () => {
      $('room-code').textContent = roomCode;
      $('invite-panel').classList.remove('hidden');
      $('you-state').textContent = '厨房已开好 · 房主';
      setStatus('房间已创建，把房间码发给搭档。');
      $('create-room').disabled = false;
    });
    peer.on('connection', (conn) => {
      if (connection && connection.open) { conn.close(); showToast('这个房间已经有搭档啦'); return; }
      wireConnection(conn);
    });
    peer.on('error', (error) => {
      $('create-room').disabled = false;
      if (error.type === 'unavailable-id') { setStatus('房间码刚好被占用了，请再创建一次。'); cleanPeer(); }
      else setStatus(`暂时无法创建房间：${error.type || '连接失败'}。`);
    });
  });

  $('join-room').addEventListener('click', () => {
    if (!window.Peer) { showToast('联机组件没能加载，请检查网络后刷新'); return; }
    const code = codeInput.value.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) { showToast('请输入有效的 6 位房间码'); return; }
    cleanPeer(); roomCode = code; setStatus('正在敲门，请稍等……'); $('you-state').textContent = '正在加入…';
    peer = new Peer();
    peer.on('open', () => {
      const conn = peer.connect(roomCode, { reliable: true });
      wireConnection(conn);
      const timeout = setTimeout(() => { if (!connected) setStatus('暂时没找到这个房间，请确认房间码后再试。'); }, 10000);
      conn.on('open', () => clearTimeout(timeout));
    });
    peer.on('error', (error) => setStatus(error.type === 'peer-unavailable' ? '没找到这个房间，请确认房间码或让房主重新开房。' : '连接失败，请检查网络后重试。'));
  });

  $('copy-code').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(roomCode); showToast('房间码已复制'); }
    catch (e) { codeInput.value = roomCode; codeInput.select(); document.execCommand('copy'); showToast('房间码已复制'); }
  });
  $('action-button').addEventListener('click', onActionButton);
  $('play-again').addEventListener('click', () => {
    if (isHost) resetGame(); else if (connection && connection.open) connection.send({ type: 'again' });
  });
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 6); });
})();

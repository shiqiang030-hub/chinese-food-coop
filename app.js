(() => {
  const $ = (id) => document.getElementById(id);
  const codeInput = $('room-code-input');
  const statusLine = $('room-status');
  const stageList = [
    { name: '准备食材', title: '把馅料准备好', description: '把新鲜的菜和香料放进大碗里。', icon: '🥬' },
    { name: '和面团', title: '揉出柔软的面团', description: '两位主厨一起揉，面团会更快变得筋道。', icon: '🥣' },
    { name: '包饺子', title: '把馅料包进面皮', description: '配合默契地包好每一只饺子。', icon: '🥟' },
    { name: '下锅煮', title: '煮到刚刚好', description: '看准时机，一起照看锅里的饺子。', icon: '🍲' },
    { name: '摆盘上桌', title: '摆盘，开饭！', description: '最后一起把热腾腾的饺子端上桌。', icon: '🍽️' }
  ];
  const defaultState = () => ({ started: false, step: 0, progress: 0, score: 0, seconds: 0, finished: false, contributors: [] });
  let peer = null;
  let connection = null;
  let isHost = false;
  let connected = false;
  let roomCode = '';
  let gameState = defaultState();
  let timerHandle = null;
  let toastHandle = null;

  const setStatus = (message) => { statusLine.textContent = message; };
  const showToast = (message) => {
    const toast = $('toast'); toast.textContent = message; toast.classList.add('show');
    clearTimeout(toastHandle); toastHandle = setTimeout(() => toast.classList.remove('show'), 2300);
  };
  const setRole = (role, state) => {
    $('you-state').textContent = state;
    if (role === 'host') $('you-state').textContent = `${state} · 房主`;
  };
  const setPartner = (online) => {
    $('partner-state').textContent = online ? '已加入，准备好了' : '还没加入';
    $('partner-dot').classList.toggle('offline', !online);
  };
  const updateGameView = () => {
    const state = gameState;
    const active = state.started && !state.finished;
    const stage = stageList[Math.min(state.step, stageList.length - 1)];
    $('game-card').classList.toggle('hidden', !connected);
    $('game-title').textContent = state.finished ? '你们完成了这顿饭' : '做一份热腾腾的饺子';
    $('dish-illustration').textContent = state.finished ? '🥟' : stage.icon;
    $('stage-kicker').textContent = state.finished ? 'MEAL COMPLETE' : `STEP 0${state.step + 1} · ${stage.name}`;
    $('stage-title').textContent = state.finished ? '大功告成，开饭啦！' : stage.title;
    $('stage-description').textContent = state.finished ? '你们一起完成了今日特供。' : stage.description;
    $('progress-label').textContent = state.finished ? '100%' : `${Math.min(100, state.progress)}%`;
    $('progress-fill').style.width = `${state.finished ? 100 : Math.min(100, state.progress)}%`;
    $('timer').textContent = `${String(Math.floor(state.seconds / 60)).padStart(2, '0')}:${String(state.seconds % 60).padStart(2, '0')}`;
    $('work-button').disabled = !active;
    $('work-button').innerHTML = !state.started ? '准备好了，开始做！ <span>✦</span>' : active ? '一起动手 <span>✦</span>' : '这顿饭完成啦 <span>✓</span>';
    $('chef-turn').textContent = !state.started ? '两个人都准备好后，由房主开始' : state.finished ? '完美配合！你们是黄金搭档。' : `本步骤需要两个人都动手 · 已完成 ${state.contributors.length}/2 人`;
    $('result').classList.toggle('hidden', !state.finished);
    if (state.finished) {
      const grade = state.seconds < 55 ? 'S' : state.seconds < 85 ? 'A' : 'B';
      $('result-emoji').textContent = grade === 'S' ? '🏆' : '🎉';
      $('result-title').textContent = grade === 'S' ? '神仙搭档！' : '大功告成！';
      $('result-copy').textContent = `合作评分 ${grade} · 用时 ${$('timer').textContent} · 一起完成了 5 道工序`;
    }
  };
  const publishState = () => {
    updateGameView();
    if (isHost && connection && connection.open) connection.send({ type: 'state', state: gameState });
  };
  const resetGame = () => {
    if (!isHost) { showToast('请让房主重新开始这一局'); return; }
    clearInterval(timerHandle); timerHandle = null;
    gameState = defaultState(); publishState();
  };
  const beginGame = (player) => {
    if (!isHost || !connected) return;
    if (!gameState.started) {
      gameState.started = true;
      timerHandle = setInterval(() => {
        if (!gameState.finished) { gameState.seconds += 1; publishState(); }
      }, 1000);
      publishState();
    } else {
      if (gameState.contributors.includes(player)) { showToast('这一步你已经出过力啦，等搭档一起完成'); return; }
      gameState.contributors.push(player);
      gameState.score += 1;
      gameState.progress = gameState.contributors.length * 50;
      if (gameState.contributors.length === 2) {
        gameState.progress = 0;
        gameState.step += 1;
        gameState.contributors = [];
        if (gameState.step >= stageList.length) {
          gameState.finished = true;
          clearInterval(timerHandle); timerHandle = null;
        }
      }
      publishState();
    }
  };
  const handleAction = (message) => {
    if (!message || typeof message !== 'object') return;
    if (isHost) {
      if (message.type === 'start') beginGame('host');
      if (message.type === 'work' && gameState.started && !gameState.finished) beginGame(message.player);
      if (message.type === 'again') resetGame();
    } else if (message.type === 'state' && message.state) {
      gameState = { ...defaultState(), ...message.state };
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
      setStatus(isHost ? '搭档到齐了！可以开火。' : '加入成功，等房主开始做菜。');
      if (isHost) conn.send({ type: 'state', state: gameState });
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
  };

  $('create-room').addEventListener('click', () => {
    if (!window.Peer) { showToast('联机组件没能加载，请检查网络后刷新'); return; }
    cleanPeer();
    isHost = true;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    roomCode = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    setRole('host', '正在创建'); setStatus('正在开厨房……');
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
    cleanPeer(); roomCode = code; setStatus('正在敲门，请稍等……'); setRole('guest', '正在加入');
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
    catch { codeInput.value = roomCode; codeInput.select(); document.execCommand('copy'); showToast('房间码已复制'); }
  });
  $('work-button').addEventListener('click', () => {
    if (!connected) return;
    const type = gameState.started ? 'work' : 'start';
    if (isHost) handleAction({ type, player: 'host' }); else if (connection && connection.open) connection.send({ type, player: 'guest' });
  });
  $('play-again').addEventListener('click', () => {
    if (isHost) resetGame(); else if (connection && connection.open) connection.send({ type: 'again' });
  });
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 6); });
})();

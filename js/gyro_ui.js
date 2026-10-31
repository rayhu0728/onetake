/*
 * 3b 陀螺儀跟拍練習：畫面層（T19）
 * 手機自己播練習影片，提示時間跟著影片走（歌曲時間 = 影片播到哪）。每個運鏡前兩秒，影片中間偏下
 * 出現小小的半透明箭頭與倒數圈；圈滿時箭頭發亮往動作方向衝、那一側的邊緣亮起來，這時就動
 * （2026-10-31 Ray 從草稿選定：反應提示要一眼就懂、不擋畫面）。動作被認出來的當下，影片左上角
 * 會出現「你做了什麼」；對上提示就在右上角顯示準、早、晚、方向錯。結束後有整輪成績與整首時間軸，點時間軸上的點可以從那裡再練。
 * 流程規則都在 GyroPractice（純邏輯）；動作偵測在 GyroDetect；判定在 Judge。不用 innerHTML。
 * localStorage 只存上次成績；選過的影片存在這支手機的瀏覽器資料庫（IndexedDB），不上傳。
 * 網址加 ?preview=start|idle|ready|go|ok|early|wrong|miss|summary 可以不開感測器直接看各個畫面（截圖用）。
 * 本機開發（localhost）可以加 ?video=網址 直接載入影片，不必選檔。
 */
(function () {
  "use strict";
  var GP = window.GyroPractice, GD = window.GyroDetect, GR = window.GyroRecorder, J = window.Judge, PICT = window.GyroPict;
  var $ = function (id) { return document.getElementById(id); };

  var SONGS = window.GyroSongs || [];
  var LAST = "gyro.practice.last";
  var DB_NAME = "onetake", DB_STORE = "videos";
  var KIND_CLASS = { ok: "good", early: "warn", late: "warn", moved: "warn", wrong: "bad", miss: "miss" };
  var KIND_LABEL = [["ok", "準"], ["early", "早"], ["late", "晚"], ["wrong", "方向錯"], ["miss", "沒做到"]];
  var PREROLL_SEC = 3;
  var DUR_TOL_SEC = 1.5;     // 影片長度和歌曲差多少以內算同一部
  var YOU_MS = 1100;         // 「你做了什麼」顯示多久
  var RING = 2 * Math.PI * 42;
  var SIDE = { push: "top", pull: "bottom", pan_left: "left", pan_right: "right" };   // 「動」的時候哪一邊發亮

  var song = SONGS[0] || null;
  var bigOnly = true, soundOn = true;
  var cues = [];
  var video = $("video");
  var useVideo = false, videoReady = false, videoUrl = null;
  var state = "idle";        // idle | preroll | paused | running | done
  var run = null, prior = [], fromMs = 0;
  var detector = GD.createDetector();
  var clock = { base: 0, t0: 0, running: false };
  var vclock = { vt: -1, at: 0 };
  var raf = 0, prerollTimer = null;
  var listening = false, lastEventAt = 0, energy = 0;
  var youUntil = 0;
  var lastTickKey = "", lastGoId = null, cueMove = "", nextMove = "";
  var selectedId = null;
  var audio = null, wakeLock = null;

  // ================================================================ 小工具

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function show(id) { ["start", "run", "summary"].forEach(function (s) { $(s).hidden = s !== id; }); }
  function status(id, msg) { $(id).textContent = msg || ""; }
  function fmt(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function sec(ms) { return (Math.abs(ms) / 1000).toFixed(1) + " 秒"; }
  function durationMs() {
    if (useVideo && isFinite(video.duration) && video.duration > 0) return video.duration * 1000;
    return song && song.durationSec ? song.durationSec * 1000 : 1;
  }
  function allResults() { return prior.concat(run ? run.results() : []); }
  function resultMap() { var m = {}; allResults().forEach(function (r) { m[r.cueId] = r; }); return m; }

  // ================================================================ 聲音與螢幕常亮

  function unlockAudio() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx && !audio) audio = new Ctx();
      if (audio && audio.state === "suspended") audio.resume();
    } catch (e) { audio = null; }
  }

  function tone(freq, dur, vol) {
    if (!audio || !soundOn) return;
    try {
      var o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(audio.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* 沒聲音也照練 */ }
  }
  var sound = {
    tick: function () { tone(660, 0.06, 0.12); },
    go: function () { tone(988, 0.18, 0.45); },
    ok: function () { tone(784, 0.08, 0.2); setTimeout(function () { tone(1046, 0.1, 0.2); }, 90); },
    off: function () { tone(520, 0.14, 0.22); },
    bad: function () { tone(330, 0.2, 0.25); }
  };

  function keepAwake() {
    try {
      if (navigator.wakeLock && !wakeLock) navigator.wakeLock.request("screen").then(function (l) { wakeLock = l; l.addEventListener("release", function () { wakeLock = null; }); }).catch(function () {});
    } catch (e) { /* 不支援就算了 */ }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden" && (state === "running" || state === "preroll")) pause();
    if (document.visibilityState === "visible" && state !== "idle") keepAwake();
  });

  // ================================================================ 歌曲時鐘

  // 有影片：影片播到哪就是歌曲時間（兩次更新之間用經過的時間補，畫面才順）。沒影片：自己計時
  function songMs() {
    var now = performance.now();
    if (useVideo) {
      var vt = video.currentTime * 1000;
      if (video.paused || video.seeking) { vclock.vt = vt; vclock.at = now; return vt; }
      if (vt !== vclock.vt) { vclock.vt = vt; vclock.at = now; }
      return vclock.vt + Math.min(250, now - vclock.at);
    }
    return clock.running ? clock.base + (now - clock.t0) : clock.base;
  }

  function seek(ms) {
    if (useVideo) { try { video.currentTime = ms / 1000; } catch (e) { /* 還沒載好 */ } }
    clock.base = ms; clock.running = false;
  }

  // ================================================================ 感測器

  function onMotion(ev) {
    var now = performance.now();
    lastEventAt = now;
    var s = GR.sampleFrom(ev, now);
    energy = Math.max(GR.energy(s), energy * 0.9);
    if (state !== "running") return;
    var e = detector.push(s);
    if (e && e.move !== "small") onDetect(e);
  }

  // 偵測器用手機的時間；換成歌曲時間再拿去判定
  function onDetect(e) {
    var off = songMs() - performance.now();
    showYou(e.move);
    run.addEvent({ move: e.move, onset: e.onset + off, decidedAt: e.decidedAt + off }, songMs()).forEach(onResult);
  }

  function ensureSensors() {
    status("startStatus", "");
    if (!window.isSecureContext) {
      status("startStatus", "這個網址不是 https，手機不會給感測資料");
      return Promise.resolve(false);
    }
    var needAsk = typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function";
    var ask = needAsk ? DeviceMotionEvent.requestPermission() : Promise.resolve("granted");
    return ask.then(function (st) {
      if (st !== "granted") throw new Error("denied");
      if (!listening) { window.addEventListener("devicemotion", onMotion); listening = true; }
      var start = performance.now();
      return new Promise(function (resolve) {
        (function check() {
          if (lastEventAt > start) return resolve(true);
          if (performance.now() - start > 1500) return resolve(false);
          setTimeout(check, 50);
        })();
      });
    }).then(function (ok) {
      if (!ok) status("startStatus", "收不到感測資料，請用 iPhone 的 Safari 開");
      return ok;
    }).catch(function () {
      status("startStatus", "動作感測被拒絕了。到 設定 > App > Safari > 進階 > 網站資料，刪掉 github.io 再重開頁面");
      return false;
    });
  }

  // ================================================================ 開始、暫停、結束

  // 在按鈕的點擊裡呼叫：iPhone 要在點擊當下先播一下影片，之後才能自動播放
  function unlockVideo() {
    if (!useVideo) return;
    try {
      video.muted = true;
      var p = video.play();
      var done = function () { if (state !== "running") video.pause(); video.muted = false; };
      if (p && p.then) p.then(done).catch(function () { video.muted = false; }); else done();
    } catch (e) { video.muted = false; }
  }

  function begin(withVideo, from) {
    unlockAudio();
    useVideo = withVideo;
    unlockVideo();
    ensureSensors().then(function (ok) {
      if (!ok) { show("start"); return; }
      keepAwake();
      startRun(from, []);
    });
  }

  function startRun(from, keep) {
    stopLoop();
    fromMs = from;
    prior = keep || [];
    run = GP.createRun(cues, { fromMs: from });
    detector.reset();
    lastTickKey = ""; lastGoId = null; nextMove = "";
    $("video").hidden = !useVideo;
    $("clockFace").hidden = useVideo;
    show("run");
    seek(from);
    render(GP.phaseAt(run, from), from);
    prerollThen(play);
  }

  function prerollThen(fn) {
    state = "preroll";
    var n = PREROLL_SEC;
    $("preroll").hidden = false;
    (function step() {
      if (state !== "preroll") return;
      if (n === 0) { $("preroll").hidden = true; return fn(); }
      $("prerollNum").textContent = String(n);
      sound.tick();
      n--;
      prerollTimer = setTimeout(step, 1000);
    })();
  }

  function play() {
    state = "running";
    detector.reset();
    if (useVideo) {
      video.muted = false;
      var p = video.play();
      if (p && p.catch) p.catch(function () { if (state === "running") { state = "paused"; $("tapToPlay").hidden = false; } });
    } else {
      clock.t0 = performance.now(); clock.running = true;
    }
    loop();
  }

  function pause() {
    if (state !== "running" && state !== "preroll") return;
    clearTimeout(prerollTimer);
    $("preroll").hidden = true;
    state = "paused";
    stopLoop();
    if (useVideo) video.pause();
    if (clock.running) { clock.base = songMs(); clock.running = false; }
    $("paused").hidden = false;
  }

  // natural：歌放完了。還沒判的提示算沒做到。中途按「結束看成績」就只算已經判的
  function finish(natural) {
    if (state === "done") return;
    state = "done";
    stopLoop();
    clearTimeout(prerollTimer);
    if (useVideo) video.pause();
    clock.running = false;
    if (natural && run) run.tick(Infinity);
    $("paused").hidden = true;
    $("tapToPlay").hidden = true;
    saveLast();
    showSummary();
  }

  function loop() { stopLoop(); raf = requestAnimationFrame(frame); }
  function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  function frame() {
    raf = 0;
    if (state !== "running") return;
    var now = songMs();
    run.tick(now).forEach(onResult);
    render(GP.phaseAt(run, now), now);
    if (useVideo ? video.ended : now >= durationMs()) return finish(true);
    raf = requestAnimationFrame(frame);
  }

  video.addEventListener("ended", function () { if (state === "running") finish(true); });
  // 系統暫停（來電、拔耳機）時跟著暫停；歌放完時瀏覽器也會先送暫停，那時交給 ended 處理
  video.addEventListener("pause", function () { if (state === "running" && !video.ended) pause(); });

  // ================================================================ 練習中畫面

  function onResult(r) {
    var k = KIND_CLASS[r.kind];
    if (k === "good") sound.ok(); else if (k === "warn") sound.off(); else sound.bad();
    renderScore();
  }

  function showYou(move) {
    PICT.putArrow($("youArrow"), move);
    $("youText").textContent = PICT.NAME[move] || move;
    youUntil = performance.now() + YOU_MS;
  }

  function renderScore() {
    var rs = allResults();
    var ok = rs.filter(function (r) { return r.kind === "ok"; }).length;
    var el = $("score");
    clear(el);
    el.appendChild(document.createTextNode("✓ " + ok));
    var small = document.createElement("small");
    small.textContent = " / " + rs.length;
    el.appendChild(small);
  }

  // 換提示的動作：箭頭、顏色、字、發亮的邊（同一個動作不重畫，動畫才不會被打斷）
  function setCueMove(move) {
    if (move === cueMove) return;
    cueMove = move;
    $("cue").setAttribute("data-move", move);
    $("stage").style.setProperty("--c", PICT.COLOR[move] || "#FFFFFF");
    PICT.putArrow($("cueArrow"), move);
    $("cueWord").textContent = PICT.SHORT[move] || "";
    $("edge").setAttribute("data-side", SIDE[move] || "top");
  }

  function render(p, now) {
    // 提示只在倒數與「動」的時候出現在影片上，其他時候不擋畫面
    var shown = p.phase === "ready" || p.phase === "go";
    if (shown) setCueMove(p.cue.move);
    $("cue").setAttribute("data-phase", shown ? p.phase : "idle");
    var fill = p.phase === "ready" ? p.fraction : 0;
    $("ringFill").style.strokeDasharray = RING.toFixed(2);
    $("ringFill").style.strokeDashoffset = (RING * (1 - Math.max(0, Math.min(1, fill)))).toFixed(2);
    $("edge").classList.toggle("on", p.phase === "go");

    // 結果：右上角小標籤，下一個提示的倒數開始了也照樣顯示到時間到
    var last = run.lastResult();
    var res = $("result");
    if (last && now - last.atMs < GP.DEFAULTS.resultMs) {
      res.hidden = false;
      res.className = "result " + KIND_CLASS[last.kind];
      res.textContent = (last.kind === "ok" ? "✓ " : last.kind === "wrong" ? "✗ " : "") + J.describe(last);
    } else {
      res.hidden = true;
    }

    // 接著：沒有提示在畫面上時，左下角先告訴你下一個是什麼（6 秒內）
    var upcoming = !shown && p.cue && p.cue.t - now < 6000 ? p.cue : null;
    $("nextBox").hidden = !upcoming;
    if (upcoming && upcoming.move !== nextMove) { nextMove = upcoming.move; PICT.putArrow($("nextArrow"), upcoming.move); }

    // 聲音：倒數每一秒嗶一下，發亮時大聲嗶
    if (p.phase === "ready") {
      var key = p.cue.id + ":" + p.count;
      if (key !== lastTickKey) { lastTickKey = key; if (state === "running") sound.tick(); }
    }
    if (p.phase === "go" && lastGoId !== p.cue.id) { lastGoId = p.cue.id; if (state === "running") sound.go(); }

    $("you").hidden = performance.now() > youUntil;
    energy *= 0.92;
    $("meter").style.height = (Math.min(1, energy / 4) * 100).toFixed(0) + "%";
    if (!useVideo) $("clockFace").textContent = fmt(now);
    renderScore();
    drawTimeline($("line"), now);
  }

  // 整首時間軸：灰線是整首歌，藍線是這次練到哪，點是每個提示（顏色＝結果）
  function drawTimeline(c, now) {
    var w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    var ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var dur = durationMs(), pad = 8, y = h / 2;
    var x = function (t) { return pad + (w - pad * 2) * Math.max(0, Math.min(1, t / dur)); };
    var big = h > 40, r = big ? 6 : 4;
    ctx.lineCap = "round";
    ctx.lineWidth = big ? 4 : 3;
    ctx.strokeStyle = css("--line");
    ctx.beginPath(); ctx.moveTo(x(0), y); ctx.lineTo(x(dur), y); ctx.stroke();
    if (typeof now === "number") {
      ctx.strokeStyle = css("--accent");
      ctx.beginPath(); ctx.moveTo(x(fromMs), y); ctx.lineTo(x(now), y); ctx.stroke();
    }
    var res = resultMap();
    cues.forEach(function (cu) {
      var rr = res[cu.id];
      ctx.beginPath();
      ctx.arc(x(cu.t), y, rr ? r : r - 1, 0, Math.PI * 2);
      if (rr) { ctx.fillStyle = css("--" + KIND_CLASS[rr.kind]); ctx.fill(); }
      else { ctx.fillStyle = css("--panel"); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = css("--muted"); ctx.stroke(); }
      if (cu.id === selectedId) {
        ctx.beginPath(); ctx.arc(x(cu.t), y, r + 4, 0, Math.PI * 2);
        ctx.lineWidth = 2; ctx.strokeStyle = css("--text"); ctx.stroke();
      }
    });
    if (typeof now === "number") {
      ctx.fillStyle = css("--text");
      ctx.fillRect(x(now) - 1, 2, 2, h - 4);
    }
  }

  // ================================================================ 暫停選單

  $("pauseBtn").addEventListener("click", pause);
  $("resumeBtn").addEventListener("click", function () {
    $("paused").hidden = true;
    unlockAudio();
    unlockVideo();
    prerollThen(play);
  });
  $("back10Btn").addEventListener("click", function () {
    $("paused").hidden = true;
    unlockAudio();
    unlockVideo();
    var to = Math.max(0, songMs() - 10000);
    var gap = to > 0 ? GP.DEFAULTS.startGapMs : 0;
    // 退回去之前的結果留著；退回去之後的提示重新判
    startRun(to, allResults().filter(function (r) { return r.cueT < to + gap; }));
  });
  $("finishBtn").addEventListener("click", function () { finish(false); });
  $("tapPlayBtn").addEventListener("click", function () {
    $("tapToPlay").hidden = true;
    unlockAudio();
    play();
  });

  // ================================================================ 成績

  function showSummary() {
    show("summary");
    var rs = allResults();
    var sum = J.summarize(rs);
    $("sumTitle").textContent = sum.total ? "準 " + sum.ok + " / " + sum.total : "這次還沒有判到動作";
    var t = GP.tendency(rs);
    $("sumTend").textContent = t === null ? "" : Math.abs(t) < 80 ? "時間抓得剛好" : (t > 0 ? "整體偏晚 " : "整體偏早 ") + sec(t);

    var kinds = $("kinds");
    clear(kinds);
    KIND_LABEL.forEach(function (kl) {
      var d = document.createElement("div");
      d.className = "kind " + KIND_CLASS[kl[0]];
      var b = document.createElement("b"); b.textContent = String(sum[kl[0]] || 0);
      var s = document.createElement("span"); s.textContent = kl[1];
      d.appendChild(b); d.appendChild(s);
      kinds.appendChild(d);
    });

    var by = $("byMove");
    clear(by);
    GP.MOVES.forEach(function (m) {
      var mine = rs.filter(function (r) { return r.expected === m; });
      if (!mine.length) return;
      var fig = document.createElement("figure");
      var pb = document.createElement("div"); pb.className = "arrow-box";
      PICT.putArrow(pb, m);
      var cap = document.createElement("figcaption"); cap.textContent = PICT.NAME[m];
      var b = document.createElement("b"); b.textContent = mine.filter(function (r) { return r.kind === "ok"; }).length + " / " + mine.length;
      fig.appendChild(pb); fig.appendChild(cap); fig.appendChild(b);
      by.appendChild(fig);
    });

    $("sumEnd").textContent = fmt(durationMs());
    selectedId = null;
    renderDetail();
    requestAnimationFrame(function () { drawTimeline($("sumLine"), null); });
  }

  function renderDetail() {
    var c = cues.filter(function (x) { return x.id === selectedId; })[0];
    $("fromHereBtn").hidden = !c;
    if (!c) {
      clear($("detailPict"));
      $("detailTitle").textContent = "點時間軸上的點看細節";
      $("detailSub").textContent = "";
      return;
    }
    var r = resultMap()[c.id];
    PICT.putArrow($("detailPict"), c.move);
    $("detailTitle").textContent = fmt(c.t) + " " + PICT.NAME[c.move];
    $("detailSub").textContent = r ? J.describe(r) : "這次沒練到這裡";
  }

  $("sumLine").addEventListener("click", function (e) {
    var c = $("sumLine"), rect = c.getBoundingClientRect(), px = e.clientX - rect.left;
    var dur = durationMs(), pad = 8, best = null, bestD = 18;
    cues.forEach(function (cu) {
      var d = Math.abs(pad + (rect.width - pad * 2) * Math.min(1, cu.t / dur) - px);
      if (d < bestD) { bestD = d; best = cu; }
    });
    selectedId = best ? best.id : null;
    renderDetail();
    drawTimeline(c, null);
  });
  $("fromHereBtn").addEventListener("click", function () {
    var c = cues.filter(function (x) { return x.id === selectedId; })[0];
    if (c) begin(useVideo, Math.max(0, c.t - 6000));
  });
  $("againBtn").addEventListener("click", function () { begin(useVideo, 0); });
  $("homeBtn").addEventListener("click", function () { state = "idle"; show("start"); renderLast(); });

  function saveLast() {
    var rs = allResults();
    if (!rs.length) return;
    var sum = J.summarize(rs);
    try { localStorage.setItem(LAST, JSON.stringify({ at: new Date().toISOString(), song: song.id, ok: sum.ok, total: sum.total, tend: GP.tendency(rs) })); } catch (e) { /* 忽略 */ }
  }

  function renderLast() {
    var last = null;
    try { last = JSON.parse(localStorage.getItem(LAST) || "null"); } catch (e) { last = null; }
    if (!last || !song || last.song !== song.id) { $("lastRun").textContent = ""; return; }
    var tend = typeof last.tend === "number" && Math.abs(last.tend) >= 80 ? (last.tend > 0 ? "，偏晚 " : "，偏早 ") + sec(last.tend) : "";
    $("lastRun").textContent = "上次：準 " + last.ok + " / " + last.total + tend;
  }

  // ================================================================ 開始頁：歌曲、影片

  function renderCounts() {
    cues = song ? GP.buildCues(song.events, { bigOnly: bigOnly }) : [];
    var box = $("counts");
    clear(box);
    GP.MOVES.forEach(function (m) {
      var n = cues.filter(function (c) { return c.move === m; }).length;
      var fig = document.createElement("figure");
      var pb = document.createElement("div"); pb.className = "arrow-box";
      PICT.putArrow(pb, m);
      var cap = document.createElement("figcaption"); cap.textContent = PICT.NAME[m];
      var b = document.createElement("b"); b.textContent = "×" + n;
      fig.appendChild(pb); fig.appendChild(cap); fig.appendChild(b);
      box.appendChild(fig);
    });
  }

  function setVideoSource(src, label) {
    videoReady = false;
    $("videoInfo").textContent = "讀取中…";
    $("videoInfo").className = "video-info";
    video.src = src;
    video.load();
    video.onloadedmetadata = function () {
      videoReady = true;
      var d = video.duration;
      var want = song && song.durationSec;
      var info = $("videoInfo");
      if (want && Math.abs(d - want) > DUR_TOL_SEC) {
        info.textContent = "⚠ 影片 " + fmt(d * 1000) + "，這首歌是 " + fmt(want * 1000) + "，提示會對不上";
        info.className = "video-info warn";
      } else {
        info.textContent = "✓ " + (label ? label + " " : "") + fmt(d * 1000) + "，長度對";
        info.className = "video-info ok";
      }
      $("pickText").textContent = "換一部影片";
      status("startStatus", "");
    };
    video.onerror = function () {
      videoReady = false;
      $("videoInfo").textContent = "這個檔案播不了，換一個試試";
      $("videoInfo").className = "video-info warn";
    };
  }

  function setVideoBlob(blob, label) {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(blob);
    setVideoSource(videoUrl, label);
  }

  // 選過的影片存在這支手機的瀏覽器裡，下次打開不用再選（瀏覽器清資料就會不見，再選一次就好）
  function idb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error("no idb"));
      var q = indexedDB.open(DB_NAME, 1);
      q.onupgradeneeded = function () { q.result.createObjectStore(DB_STORE); };
      q.onsuccess = function () { resolve(q.result); };
      q.onerror = function () { reject(q.error); };
    });
  }
  function saveVideo(file) {
    idb().then(function (db) {
      db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).put({ blob: file, savedAt: Date.now() }, song.id);
    }).catch(function () { /* 存不了就每次選 */ });
  }
  function loadVideo() {
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        var q = db.transaction(DB_STORE).objectStore(DB_STORE).get(song.id);
        q.onsuccess = function () { resolve(q.result || null); };
        q.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  $("videoFile").addEventListener("change", function () {
    var f = this.files && this.files[0];
    if (!f) return;
    setVideoBlob(f, "");
    saveVideo(f);
  });

  document.querySelectorAll("#sizes button").forEach(function (b) {
    b.addEventListener("click", function () {
      bigOnly = b.getAttribute("data-big") === "1";
      document.querySelectorAll("#sizes button").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      renderCounts();
    });
  });
  $("soundBtn").addEventListener("click", function () {
    soundOn = !soundOn;
    this.setAttribute("aria-pressed", soundOn ? "true" : "false");
    $("soundWave").style.display = soundOn ? "" : "none";
  });
  $("startBtn").addEventListener("click", function () {
    if (!videoReady) {
      status("startStatus", "先按「選練習影片」，或按下面的「沒有影片」");
      return;
    }
    begin(true, 0);
  });
  $("noVideoBtn").addEventListener("click", function () { begin(false, 0); });

  // ================================================================ 啟動

  if (!song) {
    $("songName").textContent = "沒有歌曲資料";
    $("startBtn").disabled = true;
    $("noVideoBtn").disabled = true;
    status("startStatus", "找不到 songs.js（本機開發要先跑 npm run build:site）");
    return;
  }
  $("songName").textContent = song.title + (song.artist ? " · " + song.artist : "");
  renderCounts();
  renderLast();
  if (!window.isSecureContext) status("startStatus", "這個網址不是 https，手機不會給感測資料");

  var params = new URLSearchParams(location.search);
  var devVideo = params.get("video");
  var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (devVideo && local) setVideoSource(devVideo, "");
  else loadVideo().then(function (rec) { if (rec && rec.blob && !videoReady) setVideoBlob(rec.blob, "上次的影片"); });

  var preview = params.get("preview");
  if (preview && preview !== "start") runPreview(preview);

  // ---------------- 預覽模式（不開感測器，看各畫面；給截圖與檢查用） ----------------
  function runPreview(which) {
    useVideo = false;
    run = GP.createRun(cues);
    prior = [];
    fromMs = 0;
    $("video").hidden = true;
    $("clockFace").hidden = false;
    // 找一個後面空得夠久的提示，結果才不會被下一個倒數蓋掉
    var i = 2;
    while (i < cues.length - 1 && cues[i + 1].t - cues[i].t < 4000) i++;
    var c = cues[i];
    for (var k = 0; k < i; k++) {
      var other = k % 4 === 3 ? (cues[k].move === "push" ? "pull" : "push") : cues[k].move;
      run.addEvent({ move: other, onset: cues[k].t + (k % 3 - 1) * 200, decidedAt: cues[k].t + 600 }, cues[k].t + 600);
    }
    if (which === "summary") {
      cues.slice(i).forEach(function (cu, n) {
        if (n % 5 === 4) return;
        var mv = n % 7 === 6 ? (cu.move === "pan_left" ? "pan_right" : "pan_left") : cu.move;
        run.addEvent({ move: mv, onset: cu.t + ((n * 137) % 900) - 300, decidedAt: cu.t + 700 }, cu.t + 700);
      });
      run.tick(Infinity);
      return showSummary();
    }
    show("run");
    var now = c.t;
    if (which === "idle") now = cues[i].t - 3500;
    else if (which === "ready") now = c.t - 1200;
    else if (which === "go") now = c.t + 200;
    else {
      var ev = which === "ok" ? { move: c.move, onset: c.t + 120 }
        : which === "early" ? { move: c.move, onset: c.t - 450 }
        : which === "wrong" ? { move: c.move === "push" ? "pull" : "push", onset: c.t + 100 } : null;
      if (ev) { ev.decidedAt = ev.onset + 600; run.addEvent(ev, c.t + 700); showYou(ev.move); youUntil = Infinity; }
      else run.tick(c.t + 1501);
      now = which === "miss" ? c.t + 1700 : c.t + 900;
    }
    energy = which === "go" || which === "ok" ? 3 : 0.4;
    render(GP.phaseAt(run, now), now);
  }
})();

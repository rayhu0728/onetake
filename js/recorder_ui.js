/*
 * 手機動作錄製：畫面層（T17，2026-10-31 依 Ray 的回饋重做體驗）
 * 原則：用俯視動畫示範動作、動的當下有即時活動線、每一步狀態清楚、先試一次、錄完可點格重錄。
 * 資料規則都在 GyroRecorder（純邏輯）。不用 innerHTML；localStorage 只當方便用的暫存。
 * 網址加 ?preview=ready|go|ok|retry|practice|summary 可以不開感測器直接看各個畫面（截圖用）。
 */
(function () {
  "use strict";
  var GR = window.GyroRecorder;
  var STORE = "gyro_rec.session";
  var SVGNS = "http://www.w3.org/2000/svg";
  var $ = function (id) { return document.getElementById(id); };

  var settings = GR.parseSettings(location.search);
  var MOVE_NAME = { push: "推近", pull: "拉遠", pan_left: "左搖", pan_right: "右搖", still: "拿穩不動" };
  var MOVE_HINT = { push: "手機往前送", pull: "手機往自己收", pan_left: "原地往左轉", pan_right: "原地往右轉", still: "什麼都不做" };
  var FEEDBACK = {
    ok: ["✓ 收到了", "ok"],
    nomove: ["線幾乎沒跳，好像沒做到動作", "retry"],
    shaky: ["拿穩的時候有晃到", "retry"],
    nodata: ["沒收到感測資料", "retry"]
  };
  var PRACTICE_ORDER = ["push", "pan_left", "still", "pull", "pan_right"];
  var TRACE_MAX = 6;

  var grip = "手持";
  var mode = "idle";        // idle | practice | real
  var session = null;
  var practiceNo = 0;
  var current = null;       // 正在錄的 {item, t0, samples, cueMs, run}
  var live = [];            // 這一個動作的即時活動量 [{t, e}]
  var runId = 0, timer = null, listening = false, lastEventAt = 0;
  var audio = null, wakeLock = null;

  // ================================================================ 俯視示意圖

  function svgEl(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(n);
    return n;
  }

  var ARROW = {
    push: "M166 112 L166 64 M152 78 L166 64 L180 78",
    pull: "M166 64 L166 112 M152 98 L166 112 L180 98",
    pan_left: "M157 46 A135 135 0 0 0 43 46 M59 49 L43 46 L51 32",
    pan_right: "M43 46 A135 135 0 0 1 157 46 M141 49 L157 46 L149 32",
    still: "M166 68 L166 76 M166 100 L166 108 M146 88 L154 88 M178 88 L186 88"
  };

  // 從上往下看：下面是人（頭與肩），前面是手機和它拍的方向（扇形），旁邊的箭頭是動作
  function pictogram(move, animate) {
    // 取景只框住人、手機與箭頭，小圖也看得清楚
    var svg = svgEl("svg", { viewBox: "22 22 170 174", class: "pict", "aria-hidden": "true" });
    svgEl("circle", { cx: 100, cy: 168, r: 74, class: "pict-floor" }, svg);
    var rig = svgEl("g", {}, svg);
    var cone = svgEl("path", { d: "M100 100 L70 44 L130 44 Z", class: "pict-cone" }, rig);
    svgEl("rect", { x: 72, y: 97, width: 56, height: 14, rx: 3, class: "pict-phone" }, rig);
    svgEl("path", { d: "M64 194 Q100 170 136 194", class: "pict-body" }, svg);
    svgEl("circle", { cx: 100, cy: 166, r: 18, class: "pict-head" }, svg);
    svgEl("path", { d: ARROW[move], fill: "none", stroke: "currentColor", "stroke-width": 8, "stroke-linecap": "round", "stroke-linejoin": "round", class: "pict-arrow" }, svg);
    if (move === "still") svgEl("circle", { cx: 166, cy: 88, r: 9, fill: "none", stroke: "currentColor", "stroke-width": 6 }, svg);
    if (animate) addMotion(rig, cone, move);
    return svg;
  }

  function addMotion(rig, cone, move) {
    var timing = { keyTimes: "0;0.25;0.55;0.8;1", dur: "1.8s", repeatCount: "indefinite" };
    if (move === "push" || move === "pull") {
      var d = move === "push" ? -30 : 22;
      svgEl("animateTransform", Object.assign({ attributeName: "transform", type: "translate", values: "0 0;0 0;0 " + d + ";0 " + d + ";0 0" }, timing), rig);
    } else if (move === "pan_left" || move === "pan_right") {
      var deg = move === "pan_left" ? -32 : 32;
      svgEl("animateTransform", Object.assign({ attributeName: "transform", type: "rotate", values: "0 100 168;0 100 168;" + deg + " 100 168;" + deg + " 100 168;0 100 168" }, timing), rig);
    } else {
      svgEl("animate", { attributeName: "opacity", values: "0.35;0.12;0.35", dur: "1.8s", repeatCount: "indefinite" }, cone);
    }
  }

  function putPict(box, move, animate) {
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(pictogram(move, animate));
  }

  // ================================================================ 小工具

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function show(id) { ["start", "run", "summary"].forEach(function (s) { $(s).hidden = s !== id; }); }
  function schedule(fn, ms) { clearTimeout(timer); timer = setTimeout(fn, ms); }
  function stopCurrent() { runId++; current = null; clearTimeout(timer); timer = null; }

  function status(id, msg) { $(id).textContent = msg || ""; }

  // ================================================================ 聲音與螢幕常亮

  function unlockAudio() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx && !audio) audio = new Ctx();
      if (audio && audio.state === "suspended") audio.resume();
    } catch (e) { audio = null; }
  }

  function tone(freq, dur, vol) {
    if (!audio) return;
    try {
      var o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(audio.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* 沒聲音也照錄 */ }
  }
  var sound = {
    tick: function () { tone(660, 0.06, 0.12); },
    go: function () { tone(988, 0.18, 0.45); },
    ok: function () { tone(784, 0.08, 0.2); setTimeout(function () { tone(1046, 0.1, 0.2); }, 90); },
    retry: function () { tone(330, 0.2, 0.25); }
  };

  function keepAwake() {
    try {
      if (navigator.wakeLock && !wakeLock) navigator.wakeLock.request("screen").then(function (l) { wakeLock = l; l.addEventListener("release", function () { wakeLock = null; }); }).catch(function () {});
    } catch (e) { /* 不支援就算了 */ }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && mode !== "idle") keepAwake();
    if (document.visibilityState === "hidden" && current) pause(); // 切走 App 時，錄到一半的那個不算，回來按繼續
  });

  // ================================================================ 感測器

  function onMotion(ev) {
    var now = performance.now();
    lastEventAt = now;
    if (!current) return;
    var s = GR.sampleFrom(ev, now - current.t0);
    current.samples.push(s);
    live.push({ t: s.t, e: GR.energy(s) });
  }

  function ensureSensors() {
    unlockAudio();
    status("startStatus", "");
    if (!window.isSecureContext) {
      status("startStatus", "這個網址不是 https，手機不會給感測資料");
      return Promise.resolve(false);
    }
    var needAsk = typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function";
    var ask = needAsk ? DeviceMotionEvent.requestPermission() : Promise.resolve("granted");
    return ask.then(function (state) {
      if (state !== "granted") throw new Error("denied");
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
      else keepAwake();
      return ok;
    }).catch(function () {
      status("startStatus", "動作感測被拒絕了。到 設定 > App > Safari > 進階 > 網站資料，刪掉 github.io 再重開頁面");
      return false;
    });
  }

  // ================================================================ 錄製頁畫面

  function setPhase(phase, item, big) {
    $("card").setAttribute("data-phase", phase);
    $("big").textContent = big || "";
    putPict($("pictBox"), item.move, phase === "ready");
    $("moveName").textContent = MOVE_NAME[item.move];
    $("moveHint").textContent = MOVE_HINT[item.move];
    if (phase === "ready" || phase === "go") {
      $("feedback").textContent = "";
      $("feedback").className = "feedback";
      $("retryActions").hidden = true;
      $("practiceActions").hidden = true;
    }
  }

  function setBar(fraction) { $("bar").style.width = (Math.max(0, Math.min(1, fraction)) * 100).toFixed(1) + "%"; }

  function drawTrace() {
    var c = $("trace");
    var w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    var ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var total = (settings.countdownSec + settings.postSec) * 1000;
    var cueX = settings.countdownSec * 1000 / total * w;
    ctx.fillStyle = css("--accent-soft");
    ctx.fillRect(cueX, 0, w - cueX, h);           // 嗶之後的區域
    ctx.fillStyle = css("--go");
    ctx.fillRect(cueX - 1, 0, 2, h);               // 嗶的那一刻
    ctx.strokeStyle = css("--accent");
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.beginPath();
    live.forEach(function (p, i) {
      var x = Math.min(w, p.t / total * w);
      var y = h - 4 - Math.min(1, p.e / TRACE_MAX) * (h - 8);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
  }

  function renderChips() {
    var box = $("chips");
    clear(box);
    if (mode !== "real" || !session) return;
    var prog = GR.progressByMove(session);
    GR.MOVES.forEach(function (m) {
      var chip = document.createElement("div");
      chip.className = "chip";
      chip.setAttribute("aria-label", MOVE_NAME[m] + " " + prog[m].done + "/" + prog[m].total);
      var pb = document.createElement("div");
      pb.className = "pict-box";
      putPict(pb, m, false);
      chip.appendChild(pb);
      var pips = document.createElement("div");
      pips.className = "pips";
      for (var i = 0; i < prog[m].total; i++) {
        var p = document.createElement("span");
        p.className = "pip" + (i < prog[m].done ? " on" : "");
        pips.appendChild(p);
      }
      chip.appendChild(pips);
      box.appendChild(chip);
    });
  }

  // ================================================================ 錄一個動作

  function runTake(item) {
    stopCurrent();
    var myRun = runId;
    current = { item: item, t0: performance.now(), samples: [], cueMs: null, run: myRun };
    live = [];
    var cd = settings.countdownSec * 1000, post = settings.postSec * 1000;
    var lastCount = null;
    show("run");
    renderChips();
    setPhase("ready", item, String(Math.ceil(cd / 1000)));

    (function tick() {
      if (!current || current.run !== myRun || runId !== myRun) return;
      var el = performance.now() - current.t0;
      drawTrace();
      if (el < cd) {
        var count = Math.ceil((cd - el) / 1000);
        if (count !== lastCount) { lastCount = count; $("big").textContent = String(count); sound.tick(); }
        setBar(el / cd);
        return setTimeout(tick, 20);
      }
      if (current.cueMs === null) {
        current.cueMs = el;
        setPhase("go", item, item.move === "still" ? "穩住" : "動！");
        sound.go();
      }
      if (el < cd + post) {
        setBar((el - cd) / post);
        return setTimeout(tick, 20);
      }
      finishTake();
    })();
  }

  function finishTake() {
    var done = current;
    current = null;
    drawTrace();
    setBar(1);
    var kind;
    if (mode === "practice") {
      kind = GR.takeFeedback({ move: done.item.move, samples: GR.trimTake(done.samples, done.cueMs, settings.preSec, settings.postSec) }).kind;
    } else {
      session = GR.addTake(session, done.item, done.samples, done.cueMs);
      save();
      kind = GR.takeFeedback(GR.takeByIndex(session, done.item.index)).kind;
      renderChips();
    }
    var good = kind === "ok";
    setPhase(good ? "ok" : "retry", done.item, good ? "✓" : "?");
    $("feedback").textContent = FEEDBACK[kind][0];
    $("feedback").className = "feedback " + FEEDBACK[kind][1];
    if (good) sound.ok(); else sound.retry();

    if (mode === "practice") {
      $("practiceActions").hidden = false;
      return;
    }
    if (good) schedule(next, settings.restSec * 1000);
    else { $("retryActions").hidden = false; $("retryActions").setAttribute("data-index", String(done.item.index)); }
  }

  function next() {
    var item = GR.nextItem(session);
    if (item) runTake(item); else showSummary();
  }

  // ================================================================ 試一次、正式錄、暫停

  function startPractice() {
    mode = "practice";
    var move = PRACTICE_ORDER[practiceNo % PRACTICE_ORDER.length];
    practiceNo++;
    runTake({ index: -1, move: move });
  }

  function startReal(existing) {
    mode = "real";
    session = existing || GR.createSession(settings, { device: "", grip: grip, createdAt: new Date().toISOString() });
    save();
    next();
  }

  function pause() {
    if (mode === "idle") return;
    stopCurrent();
    $("paused").hidden = false;
    $("undoBtn").hidden = mode !== "real" || GR.lastTakeIndex(session) === null;
  }

  $("pauseBtn").addEventListener("click", pause);
  $("resumeRunBtn").addEventListener("click", function () {
    $("paused").hidden = true;
    unlockAudio();
    if (mode === "practice") startPractice(); else next();
  });
  $("undoBtn").addEventListener("click", function () {
    $("paused").hidden = true;
    session = GR.removeTake(session, GR.lastTakeIndex(session));
    save();
    next();
  });

  $("redoBtn").addEventListener("click", function () {
    var idx = Number($("retryActions").getAttribute("data-index"));
    session = GR.removeTake(session, idx);
    save();
    runTake(session.plan[idx]);
  });
  $("skipBtn").addEventListener("click", next);
  $("goRealBtn").addEventListener("click", function () { startReal(null); });
  $("practiceAgainBtn").addEventListener("click", startPractice);

  $("practiceBtn").addEventListener("click", function () { ensureSensors().then(function (ok) { if (ok) startPractice(); }); });
  $("startBtn").addEventListener("click", function () { clearStore(); ensureSensors().then(function (ok) { if (ok) startReal(null); }); });
  $("resumeBtn").addEventListener("click", function () {
    var saved = load();
    if (saved && GR.progress(saved).finished) { session = saved; showSummary(); return; }   // 已錄完：直接看總覽、存檔
    ensureSensors().then(function (ok) { if (ok) startReal(saved); });
  });

  document.querySelectorAll("#grips button").forEach(function (b) {
    b.addEventListener("click", function () {
      grip = b.getAttribute("data-grip");
      document.querySelectorAll("#grips button").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    });
  });

  // ================================================================ 總覽與存檔

  function drawSpark(canvas, values, warn) {
    var w = canvas.clientWidth || 60, h = canvas.clientHeight || 32, dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var cueX = settings.preSec / (settings.preSec + settings.postSec) * w;
    ctx.fillStyle = css("--go");
    ctx.fillRect(cueX - 0.5, 0, 1, h);
    ctx.strokeStyle = warn ? css("--warn") : css("--accent");
    ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach(function (v, i) {
      var x = values.length > 1 ? i / (values.length - 1) * w : 0;
      var y = h - 2 - Math.min(1, v / TRACE_MAX) * (h - 4);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
  }

  function showSummary() {
    stopCurrent();
    mode = "real";
    show("summary");
    var grid = $("grid");
    clear(grid);
    var retryCount = 0;
    GR.MOVES.forEach(function (m) {
      var row = document.createElement("div");
      row.className = "grid-row";
      var head = document.createElement("div");
      head.className = "pict-box";
      head.setAttribute("aria-label", MOVE_NAME[m]);
      putPict(head, m, false);
      row.appendChild(head);
      session.plan.filter(function (p) { return p.move === m; }).forEach(function (p, n) {
        var t = GR.takeByIndex(session, p.index);
        var kind = t ? GR.takeFeedback(t).kind : null;
        var cell = document.createElement("button");
        cell.type = "button";
        cell.className = "cell" + (!t ? " empty" : kind !== "ok" ? " retry" : "");
        cell.setAttribute("aria-label", MOVE_NAME[m] + " 第 " + (n + 1) + " 次" + (kind && kind !== "ok" ? "，可能要重錄" : "") + "，點一下重錄");
        if (kind && kind !== "ok") retryCount++;
        var cv = document.createElement("canvas");
        cell.appendChild(cv);
        cell.addEventListener("click", function () {
          session = GR.removeTake(session, p.index);
          save();
          ensureSensors().then(function (ok) { if (ok) runTake(p); });
        });
        row.appendChild(cell);
        requestAnimationFrame(function () { drawSpark(cv, t ? GR.traceOf(t, 30, settings.preSec, settings.postSec) : [], kind && kind !== "ok"); });
      });
      grid.appendChild(row);
    });
    $("sumTitle").textContent = session.takes.length + " 個動作錄好了" + (retryCount ? "，" + retryCount + " 個可能要重錄" : "");
    var canShare = !!(navigator.canShare && typeof File === "function" && navigator.canShare({ files: [new File(["{}"], "a.json", { type: "application/json" })] }));
    $("shareBtn").hidden = !canShare;
    $("saveHint").hidden = !canShare;
    $("saveBtn").className = canShare ? "" : "primary";
  }

  function file() {
    var name = GR.filename(new Date());
    return { name: name, blob: new Blob([GR.toJSON(session)], { type: "application/json" }) };
  }

  $("shareBtn").addEventListener("click", function () {
    var f = file();
    navigator.share({ files: [new File([f.blob], f.name, { type: "application/json" })], title: f.name })
      .then(function () { status("sumStatus", "已送出 " + f.name); })
      .catch(function () { /* 使用者取消 */ });
  });
  $("saveBtn").addEventListener("click", function () {
    var f = file();
    var a = document.createElement("a");
    a.href = URL.createObjectURL(f.blob);
    a.download = f.name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    status("sumStatus", "已存成 " + f.name + "，在「檔案」App 的下載項目");
  });
  $("againBtn").addEventListener("click", function () {
    if (!confirm("清掉這一輪重錄？還沒傳出去的資料會不見。")) return;
    clearStore(); session = null; mode = "idle"; show("start"); $("resumeBtn").hidden = true;
  });

  // ================================================================ 暫存

  function save() { try { localStorage.setItem(STORE, GR.toJSON(session)); } catch (e) { /* 忽略 */ } }
  function load() {
    try { var raw = localStorage.getItem(STORE); if (!raw) return null; var r = GR.fromJSON(raw); return r.ok ? r.session : null; }
    catch (e) { return null; }
  }
  function clearStore() { try { localStorage.removeItem(STORE); } catch (e) { /* 忽略 */ } }

  // ================================================================ 啟動

  var demo = $("demo");
  ["push", "pull", "pan_left", "pan_right", "still"].forEach(function (m) {
    var fig = document.createElement("figure");
    var pb = document.createElement("div");
    pb.className = "pict-box";
    putPict(pb, m, true);
    var cap = document.createElement("figcaption");
    cap.textContent = MOVE_NAME[m];
    fig.appendChild(pb); fig.appendChild(cap);
    demo.appendChild(fig);
  });

  var prev = load();
  if (prev && prev.takes.length) {
    var pr = GR.progress(prev);
    $("resumeBtn").hidden = false;
    $("resumeBtn").textContent = pr.finished ? "看上次錄好的 " + pr.done + " 個" : "接續上次（已錄 " + pr.done + " / " + pr.total + "）";
  }
  if (!window.isSecureContext) status("startStatus", "這個網址不是 https，手機不會給感測資料");

  // ---------------- 預覽模式（不開感測器，看各畫面；給截圖與檢查用） ----------------
  var preview = new URLSearchParams(location.search).get("preview");
  if (preview) runPreview(preview);

  function fakeSamples(move, moved) {
    var out = [];
    for (var t = -settings.preSec * 1000; t <= settings.postSec * 1000; t += 16) {
      var bump = moved && t > 250 && t < 900 ? Math.sin((t - 250) / 650 * Math.PI) : 0;
      var turn = move === "pan_left" || move === "pan_right";
      out.push({ t: Math.round(t), a: [0.05, 0.04, turn ? 0.2 * bump : 2.6 * bump], g: null, r: [1, turn ? 90 * bump : 4 * bump, 1] });
    }
    return out;
  }

  function runPreview(which) {
    var item = { index: 0, move: which === "practice" ? "pan_left" : "push" };
    mode = which === "practice" ? "practice" : "real";
    session = GR.createSession(settings, { grip: "手持" });
    for (var i = 0; i < 7; i++) session = GR.addTake(session, session.plan[i], fakeSamples(session.plan[i].move, true).map(function (s) { return { t: s.t + 3000, a: s.a, g: s.g, r: s.r }; }), 3000);
    if (which === "summary") {
      while (GR.nextItem(session)) {
        var it = GR.nextItem(session);
        var moved = it.index % 9 !== 4;
        session = GR.addTake(session, it, fakeSamples(it.move, moved).map(function (s) { return { t: s.t + 3000, a: s.a, g: s.g, r: s.r }; }), 3000);
      }
      return showSummary();
    }
    show("run");
    renderChips();
    var total = settings.countdownSec * 1000;
    var fs = fakeSamples(item.move, which !== "retry" && which !== "ready");
    live = fs.map(function (s) { return { t: s.t + total, e: GR.energy(s) }; })
      .filter(function (p) { return which === "ready" ? p.t < total * 0.66 : which === "go" ? p.t < total + 700 : true; });
    if (which === "ready") { setPhase("ready", item, "2"); setBar(0.4); }
    else if (which === "go") { setPhase("go", item, "動！"); setBar(0.3); }
    else if (which === "ok" || which === "practice") {
      setPhase("ok", item, "✓"); setBar(1);
      $("feedback").textContent = FEEDBACK.ok[0]; $("feedback").className = "feedback ok";
      if (which === "practice") $("practiceActions").hidden = false;
    } else if (which === "retry") {
      setPhase("retry", item, "?"); setBar(1);
      $("feedback").textContent = FEEDBACK.nomove[0]; $("feedback").className = "feedback retry";
      $("retryActions").hidden = false;
    }
    requestAnimationFrame(drawTrace);
  }
})();

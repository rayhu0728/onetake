/*
 * 手機動作錄製：畫面層（T17）
 * 感測器、聲音、計時與畫面切換。資料規則都在 GyroRecorder（純邏輯）。
 * 不用 innerHTML；localStorage 只當方便用的暫存，壞掉或被清掉也能照常錄。
 */
(function () {
  "use strict";
  var GR = window.GyroRecorder;
  var STORE = "gyro_rec.session";
  var RING = 565.5;
  var $ = function (id) { return document.getElementById(id); };

  var settings = GR.parseSettings(location.search);
  var grip = "手持橫拿";
  var session = null;
  var listening = false;
  var paused = false;
  var take = null;          // 正在錄的這一個：{item, t0, samples, cueMs, run}
  var runId = 0;            // 每次開始一個動作就加一；舊的計時迴圈看到編號變了就自己停
  var timer = null;         // 唯一的「下一個動作」計時器

  function schedule(fn, ms) {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  }
  function cancelScheduled() { clearTimeout(timer); timer = null; }
  var lastEventAt = 0;
  var audio = null;
  var wakeLock = null;

  // ---------- 感測器 ----------
  function onMotion(ev) {
    var now = performance.now();
    lastEventAt = now;
    var s = GR.sampleFrom(ev, take ? now - take.t0 : 0);
    if (take) take.samples.push(s);
    showBars(s);
  }

  function showBars(s) {
    var acc = s.a ? Math.sqrt(s.a[0] * s.a[0] + s.a[1] * s.a[1] + s.a[2] * s.a[2]) : 0;
    var rot = s.r ? Math.sqrt(s.r[0] * s.r[0] + s.r[1] * s.r[1] + s.r[2] * s.r[2]) : 0;
    $("barAcc").style.width = Math.min(100, acc / 6 * 100).toFixed(0) + "%";
    $("barRot").style.width = Math.min(100, rot / 200 * 100).toFixed(0) + "%";
  }

  function enableSensors() {
    var needAsk = typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function";
    var ask = needAsk ? DeviceMotionEvent.requestPermission() : Promise.resolve("granted");
    return ask.then(function (state) {
      if (state !== "granted") throw new Error("denied");
      if (!listening) { window.addEventListener("devicemotion", onMotion); listening = true; }
    });
  }

  function waitForData(ms) {
    var start = performance.now();
    return new Promise(function (resolve) {
      (function check() {
        if (lastEventAt > start) return resolve(true);
        if (performance.now() - start > ms) return resolve(false);
        setTimeout(check, 50);
      })();
    });
  }

  // ---------- 聲音與螢幕常亮 ----------
  function unlockAudio() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx && !audio) audio = new Ctx();
      if (audio && audio.state === "suspended") audio.resume();
    } catch (e) { audio = null; }
  }

  function beep() {
    if (!audio) return;
    try {
      var o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.4, audio.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.15);
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.16);
    } catch (e) { /* 沒聲音也照錄 */ }
  }

  function keepAwake() {
    try {
      if (navigator.wakeLock && !wakeLock) navigator.wakeLock.request("screen").then(function (l) { wakeLock = l; l.addEventListener("release", function () { wakeLock = null; }); }).catch(function () {});
    } catch (e) { /* 不支援就算了 */ }
  }
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible" && session && !GR.progress(session).finished) keepAwake(); });

  // ---------- 暫存 ----------
  function save() { try { localStorage.setItem(STORE, GR.toJSON(session)); } catch (e) { /* 忽略 */ } }
  function load() {
    try {
      var raw = localStorage.getItem(STORE);
      if (!raw) return null;
      var r = GR.fromJSON(raw);
      return r.ok ? r.session : null;
    } catch (e) { return null; }
  }
  function clearStore() { try { localStorage.removeItem(STORE); } catch (e) { /* 忽略 */ } }

  // ---------- 畫面 ----------
  function show(id) {
    ["start", "run", "done"].forEach(function (s) { $(s).hidden = s !== id; });
  }

  function status(id, msg, kind) {
    var el = $(id);
    el.textContent = msg || "";
    el.className = "status" + (kind ? " " + kind : "");
  }

  function showMove(move) {
    document.querySelectorAll("#stage .icon").forEach(function (svg) { svg.hidden = svg.getAttribute("data-move") !== move; });
  }

  function renderDots() {
    var dots = $("dots");
    while (dots.firstChild) dots.removeChild(dots.firstChild);
    var done = {};
    session.takes.forEach(function (t) { done[t.index] = true; });
    var next = GR.nextItem(session);
    session.plan.forEach(function (p) {
      var d = document.createElement("span");
      d.className = "dot" + (done[p.index] ? " done" : "") + (next && next.index === p.index ? " now" : "");
      dots.appendChild(d);
    });
    var pr = GR.progress(session);
    $("runInfo").textContent = pr.done + " / " + pr.total;
  }

  function setRing(fraction) {
    $("ring").setAttribute("stroke-dashoffset", (RING * (1 - Math.max(0, Math.min(1, fraction)))).toFixed(1));
  }

  // ---------- 錄一個動作 ----------
  function runNext() {
    cancelScheduled();
    if (paused) return;
    var item = GR.nextItem(session);
    if (!item) return finish();
    renderDots();
    showMove(item.move);
    $("stage").classList.remove("cue");
    var myRun = ++runId;
    take = { item: item, t0: performance.now(), samples: [], cueMs: null, run: myRun };
    var cd = settings.countdownSec * 1000, post = settings.postSec * 1000;

    // 用計時器推進（每 20 毫秒一次），不用 requestAnimationFrame：
    // 後者在分頁到背景或省電模式時會停或降速，倒數就不準。
    (function frame() {
      if (!take || take.run !== myRun || runId !== myRun) return;
      var el = performance.now() - take.t0;
      if (el < cd) {
        setRing(1 - el / cd);
        $("count").textContent = String(Math.ceil((cd - el) / 1000));
        return setTimeout(frame, 20);
      }
      if (take.cueMs === null) {
        take.cueMs = el;
        $("stage").classList.add("cue");
        $("count").textContent = "";
        setRing(1);
        beep();
        // iPhone 不支援震動；其他手機要使用者點過畫面才能震
        var activated = !navigator.userActivation || navigator.userActivation.hasBeenActive;
        if (navigator.vibrate && activated) { try { navigator.vibrate(60); } catch (e) { /* 忽略 */ } }
      }
      if (el < cd + post) {
        setRing(1 - (el - cd) / post);
        return setTimeout(frame, 20);
      }
      var done = take;
      take = null;
      session = GR.addTake(session, done.item, done.samples, done.cueMs);
      save();
      $("stage").classList.remove("cue");
      renderDots();
      // 休息時先換成下一個動作的圖示，讓人提早知道接下來做什麼
      var upcoming = GR.nextItem(session);
      if (upcoming) { showMove(upcoming.move); setRing(1); $("count").textContent = ""; }
      schedule(runNext, settings.restSec * 1000);
    })();
  }

  function stopCurrent() {
    runId++;
    take = null;
    cancelScheduled();
  }

  function finish() {
    stopCurrent();
    show("done");
    var noData = session.takes.filter(function (t) { var s = GR.summarizeTake(t); return !s.hasAcc && !s.hasRot; }).length;
    var rates = session.takes.map(function (t) { return GR.summarizeTake(t).rateHz; }).filter(function (r) { return r > 0; });
    var avgRate = rates.length ? rates.reduce(function (a, b) { return a + b; }, 0) / rates.length : 0;
    $("doneTitle").textContent = session.takes.length + " 個動作錄好了";
    $("doneInfo").textContent = "每秒約 " + Math.round(avgRate) + " 筆感測資料" + (noData ? "，其中 " + noData + " 個沒有資料" : "");
    $("shareBtn").hidden = !(navigator.canShare && typeof File === "function" && navigator.canShare({ files: [new File(["{}"], "a.json", { type: "application/json" })] }));
  }

  // ---------- 存檔 ----------
  function file() {
    var name = GR.filename(new Date());
    return { name: name, blob: new Blob([GR.toJSON(session)], { type: "application/json" }) };
  }

  $("saveBtn").addEventListener("click", function () {
    var f = file();
    var a = document.createElement("a");
    a.href = URL.createObjectURL(f.blob);
    a.download = f.name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    status("doneStatus", "已存成 " + f.name + "，在「檔案」App 的下載項目裡", "ok");
  });

  $("shareBtn").addEventListener("click", function () {
    var f = file();
    var fileObj = new File([f.blob], f.name, { type: "application/json" });
    navigator.share({ files: [fileObj], title: f.name }).then(function () {
      status("doneStatus", "已分享 " + f.name, "ok");
    }).catch(function () { /* 使用者取消 */ });
  });

  // ---------- 開始、接續、暫停、重錄 ----------
  function begin(existing) {
    unlockAudio();
    status("startStatus", "");
    if (!window.isSecureContext) {
      status("startStatus", "這個網址不是 https，手機不會給感測資料", "warn");
      return;
    }
    enableSensors().then(function () {
      $("liveBars").hidden = false;
      return waitForData(1500);
    }).then(function (ok) {
      if (!ok) { status("startStatus", "收不到感測資料，請用 iPhone 的 Safari 開", "warn"); return; }
      session = existing || GR.createSession(settings, { device: "", grip: grip, createdAt: new Date().toISOString() });
      save();
      keepAwake();
      paused = false;
      $("pauseBtn").textContent = "暫停";
      show("run");
      runNext();
    }).catch(function () {
      status("startStatus", "動作感測被拒絕了。到 設定 > App > Safari > 進階 > 網站資料，刪掉這個網站再重開頁面", "warn");
    });
  }

  $("startBtn").addEventListener("click", function () { clearStore(); begin(null); });
  $("resumeBtn").addEventListener("click", function () { begin(load()); });
  $("againBtn").addEventListener("click", function () { stopCurrent(); clearStore(); session = null; show("start"); $("resumeBtn").hidden = true; });

  $("pauseBtn").addEventListener("click", function () {
    if (!paused) {
      paused = true;
      stopCurrent();             // 錄到一半的那個不算
      $("stage").classList.remove("cue");
      $("count").textContent = "";
      setRing(0);
      $("pauseBtn").textContent = "繼續";
    } else {
      paused = false;
      $("pauseBtn").textContent = "暫停";
      unlockAudio();
      runNext();
    }
  });

  $("redoBtn").addEventListener("click", function () {
    var last = GR.lastTakeIndex(session);
    if (last === null) return;
    stopCurrent();
    session = GR.removeTake(session, last);
    save();
    renderDots();
    if (!paused) schedule(runNext, 300);
  });

  document.querySelectorAll("#grips button").forEach(function (b) {
    b.addEventListener("click", function () {
      grip = b.getAttribute("data-grip");
      document.querySelectorAll("#grips button").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    });
  });

  // ---------- 啟動 ----------
  var prev = load();
  if (prev && !GR.progress(prev).finished && prev.takes.length) {
    $("resumeBtn").hidden = false;
    $("resumeBtn").textContent = "接續上次（已錄 " + prev.takes.length + " 個）";
  }
  if (!window.isSecureContext) status("startStatus", "這個網址不是 https，手機不會給感測資料", "warn");
})();

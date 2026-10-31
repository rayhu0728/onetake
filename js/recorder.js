/*
 * 手機動作錄製：純邏輯（T17）
 * 負責練習順序、每一次動作（take）的資料、修剪、統計與存檔格式。不碰 DOM、不碰感測器。
 * 錄下來的資料給 T18 調動作辨識規則用。
 * UMD：瀏覽器掛 window.GyroRecorder，Node 用 require()。零相依。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GyroRecorder = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = 1;
  var MOVES = ["push", "pull", "pan_left", "pan_right", "still"];
  var DEFAULTS = { reps: 5, countdownSec: 3, preSec: 1, postSec: 2.5, restSec: 1.5, seed: 7 };
  var LIMITS = {
    reps: [1, 20], countdownSec: [1, 5], preSec: [0, 3], postSec: [0.5, 6], restSec: [0, 5], seed: [0, 1000000]
  };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function round3(v) { return Math.round(v * 1000) / 1000; }
  function isFiniteNumber(v) { return typeof v === "number" && isFinite(v); }

  // ---------- 設定：網址參數可覆寫，超出範圍就夾回去 ----------
  function parseSettings(query) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = DEFAULTS[k]; });
    var q = typeof query === "string" ? query.replace(/^\?/, "") : "";
    if (!q) return out;
    q.split("&").forEach(function (pair) {
      var kv = pair.split("=");
      var k = decodeURIComponent(kv[0] || "");
      if (!(k in DEFAULTS)) return;
      var v = Number(decodeURIComponent(kv[1] || ""));
      if (!isFiniteNumber(v)) return;
      if (k === "reps" || k === "seed") v = Math.round(v);
      out[k] = clamp(v, LIMITS[k][0], LIMITS[k][1]);
    });
    return out;
  }

  // ---------- 練習順序：每種動作 reps 次，打亂但同一種不連續超過 2 次 ----------
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makePlan(reps, seed) {
    var bag = [];
    MOVES.forEach(function (m) { for (var i = 0; i < reps; i++) bag.push(m); });
    var rand = rng(seed);
    for (var attempt = 0; attempt < 200; attempt++) {
      for (var i = bag.length - 1; i > 0; i--) {
        var j = Math.floor(rand() * (i + 1));
        var tmp = bag[i]; bag[i] = bag[j]; bag[j] = tmp;
      }
      if (maxRun(bag) <= 2) break;
    }
    return bag.map(function (m, i) { return { index: i, move: m }; });
  }

  function maxRun(list) {
    var best = 0, run = 0;
    for (var i = 0; i < list.length; i++) {
      run = i > 0 && list[i] === list[i - 1] ? run + 1 : 1;
      if (run > best) best = run;
    }
    return best;
  }

  // ---------- 一筆感測資料 ----------
  function vec(o, a, b, c) {
    if (!o) return null;
    var x = o[a], y = o[b], z = o[c];
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) return null;
    return [round3(x), round3(y), round3(z)];
  }

  // ev 是 DeviceMotionEvent 或同形狀的物件；tMs 是相對於這次動作開始的毫秒數
  function sampleFrom(ev, tMs) {
    return {
      t: Math.round(tMs),
      a: vec(ev && ev.acceleration, "x", "y", "z"),
      g: vec(ev && ev.accelerationIncludingGravity, "x", "y", "z"),
      r: vec(ev && ev.rotationRate, "alpha", "beta", "gamma")
    };
  }

  // ---------- 一整輪 ----------
  function createSession(settings, meta) {
    var s = settings || DEFAULTS;
    meta = meta || {};
    return {
      version: VERSION,
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : "",
      device: typeof meta.device === "string" ? meta.device : "",
      grip: typeof meta.grip === "string" ? meta.grip : "",
      settings: { reps: s.reps, countdownSec: s.countdownSec, preSec: s.preSec, postSec: s.postSec, restSec: s.restSec, seed: s.seed },
      plan: makePlan(s.reps, s.seed),
      takes: []
    };
  }

  function nextItem(session) {
    var done = {};
    session.takes.forEach(function (t) { done[t.index] = true; });
    for (var i = 0; i < session.plan.length; i++) if (!done[session.plan[i].index]) return session.plan[i];
    return null;
  }

  function progress(session) {
    var next = nextItem(session);
    return { done: session.takes.length, total: session.plan.length, next: next, finished: next === null };
  }

  // 只留下提示前 preSec 到提示後 postSec 的資料，時間改成以提示為 0
  function trimTake(samples, cueMs, preSec, postSec) {
    var lo = cueMs - preSec * 1000, hi = cueMs + postSec * 1000;
    return samples.filter(function (s) { return s.t >= lo && s.t <= hi; })
      .map(function (s) { return { t: s.t - Math.round(cueMs), a: s.a, g: s.g, r: s.r }; });
  }

  function addTake(session, item, samples, cueMs) {
    if (!item || item.index === undefined) throw new Error("沒有要錄的動作");
    if (!isFiniteNumber(cueMs)) throw new Error("提示時間必須是數字");
    var out = JSON.parse(JSON.stringify(session));
    out.takes = out.takes.filter(function (t) { return t.index !== item.index; });
    out.takes.push({ index: item.index, move: item.move, samples: trimTake(samples, cueMs, session.settings.preSec, session.settings.postSec) });
    out.takes.sort(function (x, y) { return x.index - y.index; });
    return out;
  }

  function removeTake(session, index) {
    var out = JSON.parse(JSON.stringify(session));
    out.takes = out.takes.filter(function (t) { return t.index !== index; });
    return out;
  }

  function lastTakeIndex(session) {
    // 「上一個」是照計畫順序最後完成的那一個
    var doneIdx = session.takes.map(function (t) { return t.index; });
    return doneIdx.length ? Math.max.apply(null, doneIdx) : null;
  }

  // ---------- 統計 ----------
  function norm(v) { return v ? Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) : 0; }

  function summarizeTake(take) {
    var s = take.samples;
    if (!s.length) return { n: 0, rateHz: 0, peakAcc: 0, peakRot: 0, hasAcc: false, hasRot: false };
    var span = (s[s.length - 1].t - s[0].t) / 1000;
    var peakAcc = 0, peakRot = 0, hasAcc = false, hasRot = false;
    s.forEach(function (x) {
      if (x.a) { hasAcc = true; peakAcc = Math.max(peakAcc, norm(x.a)); }
      if (x.r) { hasRot = true; peakRot = Math.max(peakRot, norm(x.r)); }
    });
    return {
      n: s.length,
      rateHz: span > 0 ? round3((s.length - 1) / span) : 0,
      peakAcc: round3(peakAcc), peakRot: round3(peakRot), hasAcc: hasAcc, hasRot: hasRot
    };
  }

  // ---------- 即時活動量：畫面上那條會跳的線 ----------
  // 加速度（m/s²）加上轉速（度／秒）除以 30，讓「推一下」和「轉一下」的高度差不多
  function energy(s) {
    if (!s) return 0;
    return round3((s.a ? norm(s.a) : 0) + (s.r ? norm(s.r) / 30 : 0));
  }

  // 每種動作錄了幾個、總共要幾個
  function progressByMove(session) {
    var out = {};
    MOVES.forEach(function (m) { out[m] = { done: 0, total: 0 }; });
    session.plan.forEach(function (p) { out[p.move].total++; });
    session.takes.forEach(function (t) { if (out[t.move]) out[t.move].done++; });
    return out;
  }

  // 總覽頁的小線圖：把提示前 preSec 到提示後 postSec 切成 buckets 段，每段取最大活動量
  function traceOf(take, buckets, preSec, postSec) {
    var n = buckets || 40, lo = -preSec * 1000, hi = postSec * 1000, w = (hi - lo) / n;
    var out = [];
    for (var i = 0; i < n; i++) out.push(0);
    (take.samples || []).forEach(function (s) {
      if (s.t < lo || s.t > hi) return;
      var k = Math.min(n - 1, Math.floor((s.t - lo) / w));
      out[k] = Math.max(out[k], energy(s));
    });
    return out;
  }

  function takeByIndex(session, index) {
    for (var i = 0; i < session.takes.length; i++) if (session.takes[i].index === index) return session.takes[i];
    return null;
  }

  // ---------- 錄完一個動作後的快速回饋 ----------
  // 只看提示之後的資料有沒有明顯的移動或轉動。門檻是暫定值（T18 用真實資料再調）：
  // 加速度 1.0 m/s²、轉速 30 度／秒。
  var MOVE_ACC = 1.0, MOVE_ROT = 30;

  function takeFeedback(take) {
    var after = (take.samples || []).filter(function (s) { return s.t >= 0; });
    var hasData = after.some(function (s) { return s.a || s.r; });
    if (!hasData) return { kind: "nodata", moved: false, peakAcc: 0, peakRot: 0 };
    var peakAcc = 0, peakRot = 0;
    after.forEach(function (s) {
      if (s.a) peakAcc = Math.max(peakAcc, norm(s.a));
      if (s.r) peakRot = Math.max(peakRot, norm(s.r));
    });
    var moved = peakAcc >= MOVE_ACC || peakRot >= MOVE_ROT;
    var kind;
    if (take.move === "still") kind = moved ? "shaky" : "ok";
    else kind = moved ? "ok" : "nomove";
    return { kind: kind, moved: moved, peakAcc: round3(peakAcc), peakRot: round3(peakRot) };
  }

  // ---------- 存檔 ----------
  function toJSON(session) { return JSON.stringify(session); }

  function fromJSON(text) {
    var o;
    try { o = JSON.parse(text); } catch (e) { return { ok: false, session: null, errors: ["不是合法的 JSON：" + e.message] }; }
    var errors = [];
    if (!o || typeof o !== "object") errors.push("必須是物件");
    else {
      if (o.version !== VERSION) errors.push("不支援的版本 " + String(o.version));
      if (!Array.isArray(o.plan)) errors.push("缺少 plan");
      if (!Array.isArray(o.takes)) errors.push("缺少 takes");
      else o.takes.forEach(function (t, i) {
        if (MOVES.indexOf(t.move) < 0) errors.push("第 " + (i + 1) + " 個動作種類不合法：" + String(t.move));
        if (!Array.isArray(t.samples)) errors.push("第 " + (i + 1) + " 個動作缺少 samples");
      });
    }
    return errors.length ? { ok: false, session: null, errors: errors } : { ok: true, session: o, errors: [] };
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function filename(date) {
    var d = date instanceof Date ? date : new Date();
    return "motion_" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "_" + pad2(d.getHours()) + pad2(d.getMinutes()) + ".json";
  }

  return {
    VERSION: VERSION, MOVES: MOVES.slice(), DEFAULTS: JSON.parse(JSON.stringify(DEFAULTS)),
    parseSettings: parseSettings, makePlan: makePlan, maxRun: maxRun,
    sampleFrom: sampleFrom, createSession: createSession, nextItem: nextItem, progress: progress,
    trimTake: trimTake, addTake: addTake, removeTake: removeTake, lastTakeIndex: lastTakeIndex,
    summarizeTake: summarizeTake, takeFeedback: takeFeedback, energy: energy, progressByMove: progressByMove,
    traceOf: traceOf, takeByIndex: takeByIndex, toJSON: toJSON, fromJSON: fromJSON, filename: filename
  };
});

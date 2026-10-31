/*
 * 3b 陀螺儀練習：流程純邏輯（T19）
 * - buildCues：從運鏡事件挑出要提示的（只挑手機認得出的推、拉、左搖、右搖；可只挑大幅；太近的合併）
 * - createRun：一次練習。吃偵測到的動作（GyroDetect 的事件），對上提示就用 Judge 判定；時間過了沒做算沒做到
 * - phaseAt：這一刻畫面該顯示什麼（倒數、動、結果、等下一個、結束）
 * - tendency：整體偏早還是偏晚；songFromSheet：打包網站時把事件譜縮成只剩運鏡時間點
 * 時間一律是「歌曲時間」毫秒（影片播到哪）。不碰 DOM、不碰感測器。
 * UMD：瀏覽器掛 window.GyroPractice（要先載入 judge.js），Node 用 require()。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("../judge.js"));
  } else {
    root.GyroPractice = factory(root.Judge);
  }
})(typeof self !== "undefined" ? self : this, function (Judge) {
  "use strict";

  var MOVES = ["push", "pull", "pan_left", "pan_right"];
  var DEFAULTS = {
    bigOnly: true,     // 只提示大幅運鏡
    minGapMs: 1800,    // 兩個提示至少隔多久（手機要等上一個動作停下來才認得下一個）
    leadMs: 2000,      // 提前多久開始倒數
    goMs: 700,         // 「動！」顯示多久
    resultMs: 1300,    // 結果顯示多久
    startGapMs: 1000   // 從中間開始練時，太近的第一個提示跳過（來不及準備）
  };

  function merge(extra) {
    var o = {};
    Object.keys(DEFAULTS).forEach(function (k) { o[k] = DEFAULTS[k]; });
    if (extra) Object.keys(extra).forEach(function (k) { if (k in DEFAULTS) o[k] = extra[k]; });
    return o;
  }

  // 支援兩種格式：事件譜的 camera 事件（t 為秒），或打包後的精簡格式 {t 秒, move, size, minor}
  function normalize(e) {
    if (!e || typeof e.t !== "number" || !isFinite(e.t)) return null;
    var move = e.camera ? e.camera.move : e.move;
    var size = e.camera ? e.camera.size : e.size;
    var minor = e.auto ? !!e.auto.minor : !!e.minor;
    return { t: Math.round(e.t * 1000), move: move, size: size === "big" ? "big" : "small", minor: minor };
  }

  function buildCues(events, options) {
    var o = merge(options);
    var list = (events || []).map(normalize).filter(function (e) {
      return e && MOVES.indexOf(e.move) >= 0 && !e.minor && (!o.bigOnly || e.size === "big");
    });
    // 同一時間：左右搖排前面（手機轉的時候判成搖，和偵測的優先順序一致）
    list.sort(function (a, b) {
      if (a.t !== b.t) return a.t - b.t;
      var pa = a.move.indexOf("pan") === 0 ? 0 : 1, pb = b.move.indexOf("pan") === 0 ? 0 : 1;
      return pa - pb;
    });
    var out = [];
    list.forEach(function (e) {
      var last = out[out.length - 1];
      if (!last || e.t - last.t >= o.minGapMs) out.push({ id: out.length, t: e.t, move: e.move, size: e.size });
    });
    return out;
  }

  function createRun(cues, options) {
    var o = merge(options);
    var jo = { tolMs: options && options.tolMs, earlyWindowMs: options && options.earlyWindowMs, lateWindowMs: options && options.lateWindowMs };
    var J = Judge.DEFAULTS;
    var early = typeof jo.earlyWindowMs === "number" ? jo.earlyWindowMs : J.earlyWindowMs;
    var late = typeof jo.lateWindowMs === "number" ? jo.lateWindowMs : J.lateWindowMs;
    var fromMs = options && typeof options.fromMs === "number" ? options.fromMs : 0;
    var inRun = (cues || []).filter(function (c) { return c.t >= fromMs + (fromMs > 0 ? o.startGapMs : 0); })
      .slice().sort(function (a, b) { return a.t - b.t; });
    var results = {};
    var order = [];

    function pending() { return inRun.filter(function (c) { return !results[c.id]; }); }

    function finalize(c, r, atMs) {
      r.cueId = c.id; r.cueT = c.t; r.atMs = atMs;
      results[c.id] = r;
      order.push(r);
      return r;
    }

    // 偵測到一個動作；回傳因此定案的結果（0 或 1 個）
    function addEvent(ev, nowMs) {
      if (!ev || ev.move === "small" || typeof ev.onset !== "number") return [];
      var target = null;
      pending().some(function (c) {
        var d = ev.onset - c.t;
        if (d >= -early && d <= late) { target = c; return true; }
        return false;
      });
      if (!target) return [];
      var r = Judge.judgeCue(target, [ev], jo);
      return [finalize(target, r, typeof nowMs === "number" ? nowMs : ev.decidedAt)];
    }

    // 時間往前走；回傳因為超過時間而定案為「沒做到」的結果
    function tick(nowMs) {
      var out = [];
      pending().forEach(function (c) {
        if (nowMs > c.t + late) out.push(finalize(c, { kind: "miss", expected: c.move, got: null, deltaMs: null, index: null }, nowMs));
      });
      return out;
    }

    return {
      cues: function () { return inRun.slice(); },
      addEvent: addEvent,
      tick: tick,
      result: function (id) { return results[id] || null; },
      results: function () { return inRun.map(function (c) { return results[c.id]; }).filter(Boolean); },
      lastResult: function () { return order.length ? order[order.length - 1] : null; },
      summary: function () { return Judge.summarize(inRun.map(function (c) { return results[c.id]; }).filter(Boolean)); },
      done: function () { return pending().length === 0; }
    };
  }

  // 畫面狀態。優先順序：動 > 倒數 > 結果 > 等下一個 > 結束
  function phaseAt(run, nowMs, options) {
    var o = merge(options);
    var next = null;
    run.cues().some(function (c) {
      if (!run.result(c.id) && c.t + o.goMs > nowMs) { next = c; return true; }
      return false;
    });
    if (next && nowMs >= next.t) return { phase: "go", cue: next };
    var until = next ? next.t - nowMs : null;
    if (next && until <= o.leadMs) {
      return { phase: "ready", cue: next, count: Math.ceil(until / 1000), fraction: 1 - until / o.leadMs };
    }
    var last = run.lastResult();
    if (last && nowMs - last.atMs < o.resultMs) return { phase: "result", result: last, cue: next };
    if (next) return { phase: "idle", cue: next, inMs: until };
    return { phase: "end" };
  }

  // 整體偏早還是偏晚：有時間差的結果（準、早、晚）取平均，正的是晚。沒有就回 null
  function tendency(results) {
    var d = (results || []).filter(function (r) {
      return r && (r.kind === "ok" || r.kind === "early" || r.kind === "late") && typeof r.deltaMs === "number";
    }).map(function (r) { return r.deltaMs; });
    if (!d.length) return null;
    return Math.round(d.reduce(function (a, b) { return a + b; }, 0) / d.length);
  }

  // 事件譜（data/*.camera.json）→ 網站用的歌曲資料。只留歌名、長度與運鏡時間點（D14），
  // 不留影片檔名、跳位外觀等其他欄位
  function songFromSheet(id, sheet) {
    var song = (sheet && sheet.song) || {};
    var media = (sheet && sheet.media) || {};
    var events = ((sheet && sheet.events) || []).filter(function (e) { return e && e.kind === "camera" && e.camera; })
      .map(normalize).filter(Boolean)
      .map(function (e) { return { t: e.t / 1000, move: e.move, size: e.size, minor: e.minor }; });
    return {
      id: String(id),
      title: typeof song.title === "string" ? song.title : "",
      artist: typeof song.artist === "string" ? song.artist : "",
      durationSec: typeof media.durationSec === "number" ? media.durationSec : null,
      events: events
    };
  }

  return {
    DEFAULTS: merge(), MOVES: MOVES.slice(), normalize: normalize, buildCues: buildCues, createRun: createRun,
    phaseAt: phaseAt, tendency: tendency, songFromSheet: songFromSheet
  };
});

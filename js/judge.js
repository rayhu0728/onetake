/*
 * 提示判定（T18；3b 陀螺儀練習與 3 方向鍵節奏遊戲共用）
 * 把「該做什麼、什麼時候做」（提示）和「實際做了什麼、什麼時候開始」（事件）對起來，給出：
 *   ok 準、early 早、late 晚、wrong 方向錯、miss 沒做、moved 該拿穩卻動了
 * 時間單位一律毫秒，提示和事件要用同一個時鐘。
 * UMD：瀏覽器掛 window.Judge，Node 用 require()。零相依。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Judge = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULTS = {
    tolMs: 250,          // 跟提示差這麼多以內算準（含等於）
    earlyWindowMs: 800,  // 提示前多久開始的動作還算是在回應這個提示
    lateWindowMs: 1500   // 提示後多久以內開始的動作還算
  };
  var MOVES = ["push", "pull", "pan_left", "pan_right", "still"];
  var NAME = { push: "推近", pull: "拉遠", pan_left: "左搖", pan_right: "右搖", still: "拿穩" };

  function merge(extra) {
    var o = {};
    Object.keys(DEFAULTS).forEach(function (k) { o[k] = extra && typeof extra[k] === "number" ? extra[k] : DEFAULTS[k]; });
    return o;
  }

  function inWindow(ev, cue, o) {
    var d = ev.onset - cue.t;
    return d >= -o.earlyWindowMs && d <= o.lateWindowMs;
  }

  // 一個提示對一串事件（used：已經被別的提示用掉的事件索引）
  function judgeCue(cue, events, options, used) {
    var o = merge(options);
    if (!cue || MOVES.indexOf(cue.move) < 0 || typeof cue.t !== "number") throw new Error("提示格式不對");
    used = used || {};
    var cands = [];
    (events || []).forEach(function (e, i) {
      if (used[i] || !e || e.move === "small" || typeof e.onset !== "number") return;
      if (inWindow(e, cue, o)) cands.push({ e: e, i: i, d: e.onset - cue.t });
    });
    cands.sort(function (x, y) { return Math.abs(x.d) - Math.abs(y.d); });

    if (cue.move === "still") {
      return cands.length ? { kind: "moved", expected: "still", got: cands[0].e.move, deltaMs: cands[0].d, index: cands[0].i }
                          : { kind: "ok", expected: "still", got: null, deltaMs: null, index: null };
    }
    if (!cands.length) return { kind: "miss", expected: cue.move, got: null, deltaMs: null, index: null };
    var same = cands.filter(function (c) { return c.e.move === cue.move; });
    if (!same.length) return { kind: "wrong", expected: cue.move, got: cands[0].e.move, deltaMs: cands[0].d, index: cands[0].i };
    var c = same[0];
    var kind = Math.abs(c.d) <= o.tolMs ? "ok" : c.d < 0 ? "early" : "late";
    return { kind: kind, expected: cue.move, got: c.e.move, deltaMs: c.d, index: c.i };
  }

  // 一整串提示：照時間順序判，每個事件最多用一次
  function judgeAll(cues, events, options) {
    var used = {};
    return (cues || []).slice().sort(function (a, b) { return a.t - b.t; }).map(function (cue) {
      var r = judgeCue(cue, events, options, used);
      if (r.index !== null) used[r.index] = true;
      r.cueT = cue.t;
      return r;
    });
  }

  function summarize(results) {
    var s = { total: 0, ok: 0, early: 0, late: 0, wrong: 0, miss: 0, moved: 0, meanAbsDeltaMs: null };
    var sum = 0, n = 0;
    (results || []).forEach(function (r) {
      s.total++;
      s[r.kind]++;
      if ((r.kind === "ok" || r.kind === "early" || r.kind === "late") && typeof r.deltaMs === "number") { sum += Math.abs(r.deltaMs); n++; }
    });
    if (n) s.meanAbsDeltaMs = Math.round(sum / n);
    return s;
  }

  // 給畫面用的一句話（越短越好）
  function describe(r) {
    var sec = function (ms) { return (Math.abs(ms) / 1000).toFixed(1) + " 秒"; };
    switch (r.kind) {
      case "ok": return r.expected === "still" ? "穩住了" : "準";
      case "early": return "早 " + sec(r.deltaMs);
      case "late": return "晚 " + sec(r.deltaMs);
      case "wrong": return "方向錯：做成" + (NAME[r.got] || r.got);
      case "miss": return "沒做到";
      case "moved": return "該拿穩，卻動了";
      default: return "";
    }
  }

  return { DEFAULTS: merge(), judgeCue: judgeCue, judgeAll: judgeAll, summarize: summarize, describe: describe };
});

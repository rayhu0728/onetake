/*
 * 手機動作即時偵測（T18）
 * 一筆一筆吃感測資料（DeviceMotionEvent 轉成的 {t, a, g, r}），偵測到一個動作就回傳一個事件：
 *   { move: "push"|"pull"|"pan_left"|"pan_right"|"small", onset, decidedAt, yawDeg, peakFwd }
 * 規則依 Ray 的第一份 iPhone 手持資料（docs/tests/T17_first_recording.md）：
 *   - 左右轉：轉速向量投影到重力方向後積分成轉角；超過 panDeg 算搖，負的是左搖。投影讓手機怎麼拿都適用。
 *   - 前後：機身 z 軸加速度。最大值超過 fwdPeak 時，看第一下用力的正負：正的是推近、負的是拉遠。
 *   - 都不夠大就是 "small"（小晃動，呼叫端通常忽略）。
 * iPhone Safari 的 rotationRate：alpha、beta、gamma 依序當 x、y、z 軸（和 W3C 規格不同，實測得出）。
 * UMD：瀏覽器掛 window.GyroDetect，Node 用 require()。零相依，不碰 DOM。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GyroDetect = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULTS = {
    onAcc: 0.6,          // 開始：前後加速度超過這個值（m/s²）
    onRot: 25,           // 開始：左右轉速超過這個值（度／秒）
    onCount: 2,          // 連續幾筆超過才算開始
    offAcc: 0.35,        // 停止：加速度低於這個值
    offRot: 12,          // 停止：轉速低於這個值
    quietMs: 300,        // 安靜多久算停下來
    maxMs: 1200,         // 從開始最多看多久就下判定
    panDeg: 30,          // 轉角超過幾度算搖
    fwdPeak: 0.8,        // 前後用力最大值超過多少算推拉
    gravityAlpha: 0.05,  // 重力方向的平滑程度（不動時才更新）
    maxGapMs: 50,        // 兩筆之間最多算幾毫秒（避免斷訊時一次積分太多）
    rotationOrder: "ios" // "ios"：alpha/beta/gamma = x/y/z；"spec"：alpha = z、beta = x、gamma = y
  };

  function merge(base, extra) {
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    if (extra) Object.keys(extra).forEach(function (k) { if (k in base) out[k] = extra[k]; });
    return out;
  }

  function isVec(v) { return Array.isArray(v) && v.length === 3 && v.every(function (x) { return typeof x === "number" && isFinite(x); }); }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function unit(v) { var n = Math.sqrt(dot(v, v)); return n > 1e-6 ? [v[0] / n, v[1] / n, v[2] / n] : null; }
  function sign(x) { return x > 0 ? 1 : x < 0 ? -1 : 0; }

  // 轉速向量（機身 x、y、z 軸，度／秒）
  function omegaOf(r, order) {
    if (!isVec(r)) return null;
    return order === "spec" ? [r[1], r[2], r[0]] : [r[0], r[1], r[2]];
  }

  function classify(m, o) {
    if (Math.abs(m.yawDeg) >= o.panDeg) return m.yawDeg < 0 ? "pan_left" : "pan_right";
    if (m.peakFwd >= o.fwdPeak && m.first !== 0) return m.first > 0 ? "push" : "pull";
    return "small";
  }

  function createDetector(options) {
    var o = merge(DEFAULTS, options);
    var st;

    function reset() {
      st = { g: null, lastT: null, hits: 0, pend: null, moving: null, cooling: false, lastActive: null };
    }
    reset();

    // 吃一筆；偵測到一個動作時回傳事件，否則回傳 null
    function push(s) {
      if (!s || typeof s.t !== "number" || !isFinite(s.t)) return null;
      var dt = st.lastT === null ? 0 : Math.min(o.maxGapMs, Math.max(0, s.t - st.lastT)) / 1000;
      st.lastT = s.t;

      // 重力方向：只在沒在動的時候慢慢更新
      if (isVec(s.g)) {
        if (!st.g) st.g = s.g.slice();
        else if (!st.moving && !st.cooling && !st.pend) {
          for (var i = 0; i < 3; i++) st.g[i] += o.gravityAlpha * (s.g[i] - st.g[i]);
        }
      }
      var gu = st.g ? unit(st.g) : null;
      var w = omegaOf(s.r, o.rotationOrder);
      var yaw = gu && w ? dot(w, gu) : 0;
      var fwd = isVec(s.a) ? s.a[2] : 0;
      var over = Math.abs(fwd) > o.onAcc || Math.abs(yaw) > o.onRot;
      var active = Math.abs(fwd) > o.offAcc || Math.abs(yaw) > o.offRot;

      // 判定完的動作還沒停：等它安靜下來，不重複算
      if (st.cooling) {
        if (active) st.lastActive = s.t;
        if (s.t - st.lastActive >= o.quietMs) { st.cooling = false; st.hits = 0; st.pend = null; }
        return null;
      }

      if (!st.moving) {
        if (!over) { st.hits = 0; st.pend = null; return null; }
        st.hits++;
        if (!st.pend) st.pend = { onset: s.t, yawDeg: 0, peakFwd: 0, first: 0, lastActive: s.t };
        accumulate(st.pend, fwd, yaw, dt, s.t);
        if (st.hits >= o.onCount) { st.moving = st.pend; st.pend = null; }
        return null;
      }

      var m = st.moving;
      accumulate(m, fwd, yaw, dt, s.t);
      if (active) m.lastActive = s.t;
      var quiet = s.t - m.lastActive >= o.quietMs;
      var tooLong = s.t - m.onset >= o.maxMs;
      if (!quiet && !tooLong) return null;

      var ev = { move: classify(m, o), onset: m.onset, decidedAt: s.t, yawDeg: Math.round(m.yawDeg * 10) / 10, peakFwd: Math.round(m.peakFwd * 100) / 100 };
      st.moving = null;
      st.hits = 0;
      if (tooLong && !quiet) { st.cooling = true; st.lastActive = m.lastActive; }
      return ev;
    }

    function accumulate(m, fwd, yaw, dt, t) {
      m.yawDeg += yaw * dt;
      if (Math.abs(fwd) > m.peakFwd) m.peakFwd = Math.abs(fwd);
      if (m.first === 0 && Math.abs(fwd) > o.onAcc) m.first = sign(fwd);
    }

    return {
      push: push,
      reset: reset,
      isMoving: function () { return !!st.moving || !!st.pend; },
      options: function () { return merge(o); }
    };
  }

  // 一次跑完一串資料，回傳所有事件（測試與離線分析用）
  function detectAll(samples, options) {
    var d = createDetector(options);
    var out = [];
    (samples || []).forEach(function (s) { var e = d.push(s); if (e) out.push(e); });
    return out;
  }

  return { DEFAULTS: merge(DEFAULTS), createDetector: createDetector, detectAll: detectAll, classify: classify, omegaOf: omegaOf };
});

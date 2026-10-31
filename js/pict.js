/*
 * 俯視示意圖（錄製頁與練習頁共用，T17、T19）
 * 從上往下看：下面是人（頭與肩），前面是手機和它拍的方向（扇形），旁邊的箭頭是動作。
 * animate 為 true 時，手機會照動作動起來（推近往前、左搖往左轉…）。
 * 這是畫面元件（用 createElementNS 建 SVG），不用 innerHTML。瀏覽器掛 window.GyroPict。
 */
(function (root) {
  "use strict";
  var SVGNS = "http://www.w3.org/2000/svg";
  var NAME = { push: "推近", pull: "拉遠", pan_left: "左搖", pan_right: "右搖", still: "拿穩不動" };
  var HINT = { push: "手機往前送", pull: "手機往自己收", pan_left: "原地往左轉", pan_right: "原地往右轉", still: "什麼都不做" };
  var ARROW = {
    push: "M166 112 L166 64 M152 78 L166 64 L180 78",
    pull: "M166 64 L166 112 M152 98 L166 112 L180 98",
    pan_left: "M157 46 A135 135 0 0 0 43 46 M59 49 L43 46 L51 32",
    pan_right: "M43 46 A135 135 0 0 1 157 46 M141 49 L157 46 L149 32",
    still: "M166 68 L166 76 M166 100 L166 108 M146 88 L154 88 M178 88 L186 88"
  };

  function el(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(n);
    return n;
  }

  function addMotion(rig, cone, move) {
    var timing = { keyTimes: "0;0.25;0.55;0.8;1", dur: "1.8s", repeatCount: "indefinite" };
    var a = function (extra) { var o = {}; Object.keys(timing).forEach(function (k) { o[k] = timing[k]; }); Object.keys(extra).forEach(function (k) { o[k] = extra[k]; }); return o; };
    if (move === "push" || move === "pull") {
      var d = move === "push" ? -30 : 22;
      el("animateTransform", a({ attributeName: "transform", type: "translate", values: "0 0;0 0;0 " + d + ";0 " + d + ";0 0" }), rig);
    } else if (move === "pan_left" || move === "pan_right") {
      var deg = move === "pan_left" ? -32 : 32;
      el("animateTransform", a({ attributeName: "transform", type: "rotate", values: "0 100 168;0 100 168;" + deg + " 100 168;" + deg + " 100 168;0 100 168" }), rig);
    } else {
      el("animate", { attributeName: "opacity", values: "0.35;0.12;0.35", dur: "1.8s", repeatCount: "indefinite" }, cone);
    }
  }

  function pictogram(move, animate) {
    var svg = el("svg", { viewBox: "22 22 170 174", class: "pict", "aria-hidden": "true" });
    el("circle", { cx: 100, cy: 168, r: 74, class: "pict-floor" }, svg);
    var rig = el("g", {}, svg);
    var cone = el("path", { d: "M100 100 L70 44 L130 44 Z", class: "pict-cone" }, rig);
    el("rect", { x: 72, y: 97, width: 56, height: 14, rx: 3, class: "pict-phone" }, rig);
    el("path", { d: "M64 194 Q100 170 136 194", class: "pict-body" }, svg);
    el("circle", { cx: 100, cy: 166, r: 18, class: "pict-head" }, svg);
    el("path", { d: ARROW[move] || "", fill: "none", stroke: "currentColor", "stroke-width": 8, "stroke-linecap": "round", "stroke-linejoin": "round", class: "pict-arrow" }, svg);
    if (move === "still") el("circle", { cx: 166, cy: 88, r: 9, fill: "none", stroke: "currentColor", "stroke-width": 6 }, svg);
    if (animate) addMotion(rig, cone, move);
    return svg;
  }

  function put(box, move, animate) {
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(pictogram(move, animate));
  }

  // ---- 練習中的反應提示（T19 改版，2026-10-31 Ray 選定）：三層箭頭，一眼就懂，不用解讀 ----
  // 推近往上（往前）、拉遠往下（往後）、左右搖往左右。每種動作有自己的顏色。
  // 2026-10-31 Ray 試用：太淡 → 改深一點的顏色
  var COLOR = { push: "#FF8A00", pull: "#00A6E0", pan_left: "#9B5CFF", pan_right: "#9B5CFF" };
  var SHORT = { push: "推", pull: "拉", pan_left: "左", pan_right: "右" };
  var CHEVRON = {
    push: { vb: "0 -6 120 142", w: 16, d: ["M14 54 L60 12 L106 54", "M14 90 L60 48 L106 90", "M14 126 L60 84 L106 126"] },
    pull: { vb: "0 -6 120 142", w: 16, d: ["M14 76 L60 118 L106 76", "M14 40 L60 82 L106 40", "M14 4 L60 46 L106 4"] },
    pan_left: { vb: "0 0 300 180", w: 30, d: ["M90 14 L24 90 L90 166", "M170 14 L104 90 L170 166", "M250 14 L184 90 L250 166"] },
    pan_right: { vb: "0 0 300 180", w: 30, d: ["M210 14 L276 90 L210 166", "M130 14 L196 90 L130 166", "M50 14 L116 90 L50 166"] }
  };

  function arrow(move) {
    var c = CHEVRON[move];
    var svg = el("svg", { viewBox: c ? c.vb : "0 0 10 10", class: "arrow", "aria-hidden": "true" });
    if (!c) return svg;
    [1, 0.6, 0.3].forEach(function (op, i) {
      el("path", { d: c.d[i], fill: "none", stroke: "currentColor", "stroke-width": c.w, "stroke-linecap": "round", "stroke-linejoin": "round", opacity: op }, svg);
    });
    return svg;
  }

  function putArrow(box, move) {
    while (box.firstChild) box.removeChild(box.firstChild);
    if (move) box.appendChild(arrow(move));
    box.style.color = COLOR[move] || "";
  }

  root.GyroPict = { NAME: NAME, HINT: HINT, pictogram: pictogram, put: put, COLOR: COLOR, SHORT: SHORT, arrow: arrow, putArrow: putArrow };
})(typeof self !== "undefined" ? self : this);

(function () {
  "use strict";

  var STYLE_ID = "legacy-market-analysis-enhance-style";
  var PANEL_TITLE = "多周期趋势矩阵";
  var ACTIVE_TAB = "市场分析";
  var runtime = {
    rafId: 0,
  };

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function getActiveTab() {
    return document.querySelector("[role='tab'][aria-selected='true'], [role='tab'][data-state='active']");
  }

  function isMarketActive() {
    var tab = getActiveTab();
    return !!tab && normalizeText(tab.textContent) === ACTIVE_TAB;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "[data-legacy-trend-strength]{display:inline-flex;align-items:center;gap:4px;}",
      "[data-legacy-trend-strength] .legacy-strength-value{font-variant-numeric:tabular-nums;}",
    ].join("");
    document.head.appendChild(style);
  }

  function formatStrengthValue(raw) {
    var value = Number(raw);
    if (!Number.isFinite(value)) return null;
    return Math.round(value) + "%";
  }

  function updateStrengthNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.getAttribute("data-legacy-strength-formatted") === "true") return;

    var text = normalizeText(node.textContent);
    var match = text.match(/^强度[:：]?\s*([0-9]+(?:\.[0-9]+)?)%$/);
    if (!match) return;

    var formatted = formatStrengthValue(match[1]);
    if (!formatted) return;

    node.setAttribute("data-legacy-strength-formatted", "true");
    node.setAttribute("data-legacy-trend-strength", "true");
    node.innerHTML = '<span class="legacy-strength-label">强度:</span><span class="legacy-strength-value">' + formatted + "</span>";
  }

  function findTrendMatrixHosts() {
    return Array.prototype.slice
      .call(document.querySelectorAll("div, section, article"))
      .filter(function (node) {
        if (!node || !node.getBoundingClientRect) return false;
        var rect = node.getBoundingClientRect();
        if (rect.width < 240 || rect.height < 120) return false;
        return normalizeText(node.textContent).indexOf(PANEL_TITLE) !== -1;
      });
  }

  function enhanceTrendMatrix() {
    if (!isMarketActive()) return;
    ensureStyles();
    findTrendMatrixHosts().forEach(function (host) {
      Array.prototype.slice.call(host.querySelectorAll("p, span, div")).forEach(updateStrengthNode);
    });
  }

  function scheduleEnhance() {
    if (runtime.rafId) return;
    runtime.rafId = window.requestAnimationFrame(function () {
      runtime.rafId = 0;
      enhanceTrendMatrix();
    });
  }

  document.addEventListener("DOMContentLoaded", scheduleEnhance);
  window.addEventListener("load", scheduleEnhance);
  window.addEventListener("resize", scheduleEnhance);
  document.addEventListener(
    "click",
    function () {
      window.setTimeout(scheduleEnhance, 0);
    },
    true
  );
})();

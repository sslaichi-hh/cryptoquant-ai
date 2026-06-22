(function () {
  "use strict";

  var EMBED_ID = "legacy-diagnostics-embed";
  var STYLE_ID = EMBED_ID + "-styles";
  var EMBED_SRC = "/?source=1&embed=diagnostics&legacyVisual=1";
  var MARKERS = ["阻断明细表", "步骤详情", "最近周期", "影子总览", "影子持仓", "影子平仓"];

  var runtime = {
    root: null,
    iframe: null,
    hiddenHost: null,
    hiddenDisplay: "",
    lastAppliedHeight: 0,
    syncRaf: 0,
    retryTimer: 0,
    retryCount: 0,
  };

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function getActiveTab() {
    return document.querySelector("[role='tab'][aria-selected='true'], [role='tab'][data-state='active']");
  }

  function isDiagnosticsActive() {
    var tab = getActiveTab();
    return !!tab && normalizeText(tab.textContent) === "策略诊断";
  }

  function getMain() {
    var mains = Array.prototype.slice.call(document.querySelectorAll("main"));
    var visible = mains.filter(function (node) {
      if (!node || !node.getBoundingClientRect) return false;
      var rect = node.getBoundingClientRect();
      return rect.width > 360 && rect.height > 220;
    });
    return visible.length ? visible[visible.length - 1] : null;
  }

  function countMarkers(node) {
    if (!node || !node.textContent) return 0;
    var text = normalizeText(node.textContent);
    return MARKERS.reduce(function (count, marker) {
      return text.indexOf(marker) !== -1 ? count + 1 : count;
    }, 0);
  }

  function getNodeDepth(node, root) {
    var depth = 0;
    var current = node;
    while (current && current !== root) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  }

  function findDiagnosticsHost(main) {
    if (!main) return null;

    var nodes = Array.prototype.slice.call(main.querySelectorAll("section, div")).filter(function (node) {
      if (!node || node.id === EMBED_ID) return false;
      if (runtime.root && runtime.root.contains(node)) return false;
      if (!node.getBoundingClientRect) return false;
      var rect = node.getBoundingClientRect();
      if (rect.width < 320 || rect.height < 120) return false;
      return countMarkers(node) >= 2;
    });

    if (!nodes.length) {
      nodes = Array.prototype.slice.call(main.querySelectorAll("section, div")).filter(function (node) {
        if (!node || node.id === EMBED_ID) return false;
        if (runtime.root && runtime.root.contains(node)) return false;
        if (!node.getBoundingClientRect) return false;
        var rect = node.getBoundingClientRect();
        if (rect.width < 320 || rect.height < 120) return false;
        return countMarkers(node) >= 1;
      });
    }

    if (!nodes.length) return null;

    nodes.sort(function (left, right) {
      var leftScore = countMarkers(left);
      var rightScore = countMarkers(right);
      if (leftScore !== rightScore) return rightScore - leftScore;

      var leftDepth = getNodeDepth(left, main);
      var rightDepth = getNodeDepth(right, main);
      if (leftDepth !== rightDepth) return rightDepth - leftDepth;

      var leftRect = left.getBoundingClientRect();
      var rightRect = right.getBoundingClientRect();
      return leftRect.width * leftRect.height - rightRect.width * rightRect.height;
    });

    return nodes[0] || null;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "#" + EMBED_ID + "{display:none;width:100%;min-width:0;align-self:stretch;margin-top:24px;}",
      "#" + EMBED_ID + "[data-grid-parent='true']{grid-column:1 / -1;}",
      "#" + EMBED_ID + " iframe{display:block;width:100%;height:320px;border:0;background:transparent;overflow:hidden;}",
    ].join("");
    document.head.appendChild(style);
  }

  function clearRetryTimer() {
    if (!runtime.retryTimer) return;
    window.clearTimeout(runtime.retryTimer);
    runtime.retryTimer = 0;
  }

  function scheduleSync() {
    if (runtime.syncRaf) return;
    runtime.syncRaf = window.requestAnimationFrame(function () {
      runtime.syncRaf = 0;
      syncEmbed();
    });
  }

  function ensureRoot(host) {
    ensureStyles();
    if (!runtime.root) {
      runtime.root = document.createElement("div");
      runtime.root.id = EMBED_ID;
      runtime.root.setAttribute("data-legacy-diagnostics-embed", "true");

      runtime.iframe = document.createElement("iframe");
      runtime.iframe.src = EMBED_SRC;
      runtime.iframe.setAttribute("title", "CryptoQuantAI 策略诊断");
      runtime.iframe.setAttribute("scrolling", "no");
      runtime.iframe.style.height = "320px";
      runtime.root.appendChild(runtime.iframe);
    }

    if (!host || !host.parentElement) return null;
    var parent = host.parentElement;
    var parentDisplay = "";
    try {
      parentDisplay = window.getComputedStyle(parent).display;
    } catch (_error) {
      parentDisplay = "";
    }
    if (parentDisplay.indexOf("grid") !== -1) runtime.root.setAttribute("data-grid-parent", "true");
    else runtime.root.removeAttribute("data-grid-parent");

    if (runtime.root.parentElement !== parent || runtime.root.previousElementSibling !== host) {
      parent.insertBefore(runtime.root, host.nextSibling);
    }

    return runtime.root;
  }

  function hideHost(host) {
    if (!host || runtime.hiddenHost === host) return;
    restoreHost();
    runtime.hiddenHost = host;
    runtime.hiddenDisplay = host.style.display || "";
    host.style.display = "none";
  }

  function restoreHost() {
    if (!runtime.hiddenHost) return;
    if (runtime.hiddenHost.isConnected) {
      if (!runtime.hiddenDisplay) runtime.hiddenHost.style.removeProperty("display");
      else runtime.hiddenHost.style.display = runtime.hiddenDisplay;
    }
    runtime.hiddenHost = null;
    runtime.hiddenDisplay = "";
  }

  function showEmbed(host) {
    var root = ensureRoot(host);
    if (!root) return;
    hideHost(host);
    root.style.display = "block";
  }

  function hideEmbed() {
    restoreHost();
    if (runtime.root) runtime.root.style.display = "none";
  }

  function syncEmbed() {
    if (!isDiagnosticsActive()) {
      clearRetryTimer();
      runtime.retryCount = 0;
      hideEmbed();
      return;
    }

    if (runtime.hiddenHost && runtime.hiddenHost.isConnected) {
      clearRetryTimer();
      runtime.retryCount = 0;
      showEmbed(runtime.hiddenHost);
      return;
    }

    var main = getMain();
    var host = findDiagnosticsHost(main);
    if (!host) {
      hideEmbed();
      if (runtime.retryCount < 24 && !runtime.retryTimer) {
        runtime.retryCount += 1;
        runtime.retryTimer = window.setTimeout(function () {
          runtime.retryTimer = 0;
          scheduleSync();
        }, 250);
      }
      return;
    }

    clearRetryTimer();
    runtime.retryCount = 0;
    showEmbed(host);
  }

  function handleHeightMessage(event) {
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== "cq-legacy-diagnostics-height") return;
    if (!runtime.iframe) return;
    var height = Number(event.data.height);
    if (!Number.isFinite(height) || height <= 0) return;
    var nextHeight = Math.ceil(height);
    if (Math.abs(nextHeight - runtime.lastAppliedHeight) < 2) return;
    runtime.lastAppliedHeight = nextHeight;
    runtime.iframe.style.height = nextHeight + "px";
  }

  document.addEventListener("DOMContentLoaded", function () {
    scheduleSync();
  });

  window.addEventListener("load", scheduleSync);
  window.addEventListener("resize", scheduleSync);
  document.addEventListener(
    "click",
    function () {
      window.setTimeout(scheduleSync, 0);
    },
    true
  );
  window.addEventListener("message", handleHeightMessage);
})();

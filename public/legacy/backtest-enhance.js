(function () {
  "use strict";

  var EMBED_ID = "legacy-backtest-embed";
  var STYLE_ID = EMBED_ID + "-styles";
  var EMBED_SRC = "/?source=1&embed=backtest&legacyVisual=1";
  var BACKTEST_LABELS = ["策略验证", "绛栫暐楠岃瘉"];
  var BACKTEST_MARKERS = [
    "策略验证层",
    "Equity Curve",
    "Professional Audit",
    "单次回测",
    "Walk-forward",
    "虚拟余额",
    "回测结论",
    "权益曲线",
  ];

  var runtime = {
    root: null,
    iframe: null,
    hiddenHost: null,
    hiddenDisplay: "",
    lastAppliedHeight: 0,
    syncRaf: 0,
    mutationTimer: 0,
    suppressMutationsUntil: 0,
    retryTimer: 0,
    retryCount: 0,
    observer: null,
  };

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function hasAny(text, values) {
    return values.some(function (value) {
      return text.indexOf(value) !== -1;
    });
  }

  function getActiveTab() {
    return document.querySelector("[role='tab'][aria-selected='true'], [role='tab'][data-state='active']");
  }

  function getMain() {
    var mains = Array.prototype.slice.call(document.querySelectorAll("main"));
    var visible = mains.filter(function (node) {
      if (!node || !node.getBoundingClientRect) return false;
      var rect = node.getBoundingClientRect();
      return rect.width > 360 && rect.height > 220;
    });
    if (visible.length) return visible[visible.length - 1];

    var candidates = Array.prototype.slice.call(document.querySelectorAll("[class*='overflow-y-auto'], [class*='space-y']"));
    var usable = candidates.filter(function (node) {
      if (!node || !node.getBoundingClientRect) return false;
      var rect = node.getBoundingClientRect();
      return rect.width > 360 && rect.height > 220 && countMarkers(node) >= 1;
    });
    return usable.length ? usable[usable.length - 1] : null;
  }

  function countMarkers(node) {
    if (!node || !node.textContent) return 0;
    var text = normalizeText(node.textContent);
    return BACKTEST_MARKERS.reduce(function (count, marker) {
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

  function isBacktestActive() {
    var activeTab = getActiveTab();
    var activeText = normalizeText(activeTab && activeTab.textContent);
    if (hasAny(activeText, BACKTEST_LABELS)) return true;

    var main = getMain();
    var mainText = normalizeText(main && main.textContent);
    return hasAny(mainText, BACKTEST_LABELS) || countMarkers(main) >= 2;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "html,body,#root{height:auto!important;min-height:100%!important;overflow-y:auto!important;}",
      "#" + EMBED_ID + "{display:none;width:100%;min-width:0;align-self:stretch;margin:0;overflow:visible;}",
      "#" + EMBED_ID + "[data-grid-parent='true']{grid-column:1 / -1;}",
      "#" + EMBED_ID + " iframe{display:block;width:100%;min-height:640px;height:640px;border:0;background:transparent;overflow:hidden;}",
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

  function scheduleMutationSync() {
    if (Date.now() < runtime.suppressMutationsUntil) return;
    if (runtime.mutationTimer) window.clearTimeout(runtime.mutationTimer);
    runtime.mutationTimer = window.setTimeout(function () {
      runtime.mutationTimer = 0;
      scheduleSync();
    }, 80);
  }

  function findBacktestHost(main) {
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
        if (rect.width < 320 || rect.height < 80) return false;
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
      if (leftDepth !== rightDepth) return leftDepth - rightDepth;

      var leftRect = left.getBoundingClientRect();
      var rightRect = right.getBoundingClientRect();
      return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
    });

    return nodes[0] || null;
  }

  function ensureRoot(host) {
    ensureStyles();
    if (!runtime.root) {
      runtime.root = document.createElement("div");
      runtime.root.id = EMBED_ID;
      runtime.root.setAttribute("data-legacy-backtest-embed", "true");

      runtime.iframe = document.createElement("iframe");
      runtime.iframe.src = EMBED_SRC;
      runtime.iframe.setAttribute("title", "CryptoQuantAI Walk-forward 策略验证");
      runtime.iframe.setAttribute("scrolling", "no");
      runtime.iframe.style.height = "640px";
      runtime.iframe.style.overflow = "hidden";
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
      runtime.suppressMutationsUntil = Date.now() + 120;
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
    if (!isBacktestActive()) {
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
    var host = findBacktestHost(main);
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
    if (!event.data || event.data.type !== "cq-legacy-backtest-height") return;
    if (!runtime.iframe) return;
    var height = Number(event.data.height);
    if (!Number.isFinite(height) || height <= 0) return;
    var nextHeight = Math.max(640, Math.ceil(height) + 24);
    if (Math.abs(nextHeight - runtime.lastAppliedHeight) < 2) return;
    runtime.lastAppliedHeight = nextHeight;
    runtime.iframe.style.height = nextHeight + "px";
    runtime.root.style.minHeight = nextHeight + "px";
  }

  function observeLegacyChanges() {
    if (runtime.observer || !document.body || typeof MutationObserver === "undefined") return;
    runtime.observer = new MutationObserver(scheduleMutationSync);
    runtime.observer.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener("DOMContentLoaded", function () {
    observeLegacyChanges();
    scheduleSync();
  });
  window.addEventListener("load", function () {
    observeLegacyChanges();
    scheduleSync();
  });
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

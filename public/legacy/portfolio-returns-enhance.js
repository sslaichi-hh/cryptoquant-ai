(function () {
  "use strict";

  var EMBED_ID = "legacy-portfolio-returns-embed";
  var STYLE_ID = EMBED_ID + "-styles";
  var EMBED_SRC = "/?source=1&embed=portfolio-returns&legacyVisual=1";
  var PORTFOLIO_LABELS = [
    "投资组合",
    "鎶曡祫缁勫悎",
    "閹舵洝绁紒鍕値",
  ];
  var PORTFOLIO_MARKERS = [
    "账户权益",
    "当前持仓",
    "最近已实现盈亏",
    "璐︽埛鏉冪泭",
    "褰撳墠鎸佷粨",
    "鏈€杩戝凡瀹炵幇鐩堜簭",
    "鐠愶附鍩涢弶鍐抄",
    "瑜版挸澧犻幐浣风波",
    "閺堚偓鏉╂垵鍑＄€圭偟骞囬惄鍫滅碍",
  ];

  var runtime = {
    root: null,
    iframe: null,
    anchor: null,
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
    return visible.length ? visible[visible.length - 1] : null;
  }

  function countMarkers(node) {
    if (!node || !node.textContent) return 0;
    var text = normalizeText(node.textContent);
    return PORTFOLIO_MARKERS.reduce(function (count, marker) {
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

  function isPortfolioActive() {
    var activeTab = getActiveTab();
    var activeText = normalizeText(activeTab && activeTab.textContent);
    if (hasAny(activeText, PORTFOLIO_LABELS)) return true;

    var main = getMain();
    var mainText = normalizeText(main && main.textContent);
    return hasAny(mainText, PORTFOLIO_LABELS) || countMarkers(main) >= 2;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "#" + EMBED_ID + "{display:none;width:100%;min-width:0;align-self:stretch;margin:24px 0;}",
      "#" + EMBED_ID + "[data-grid-parent='true']{grid-column:1 / -1;}",
      "#" + EMBED_ID + " iframe{display:block;width:100%;min-height:360px;height:360px;border:0;background:transparent;overflow:auto;}",
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

  function findPortfolioAnchor(main) {
    if (!main) return null;

    var nodes = Array.prototype.slice.call(main.querySelectorAll("section, div")).filter(function (node) {
      if (!node || node.id === EMBED_ID) return false;
      if (runtime.root && runtime.root.contains(node)) return false;
      if (!node.getBoundingClientRect) return false;
      var rect = node.getBoundingClientRect();
      if (rect.width < 320 || rect.height < 80) return false;
      return countMarkers(node) >= 1;
    });

    if (!nodes.length) {
      var children = Array.prototype.slice.call(main.children).filter(function (node) {
        if (!node || node.id === EMBED_ID) return false;
        if (!node.getBoundingClientRect) return false;
        var rect = node.getBoundingClientRect();
        return rect.width > 320 && rect.height > 40;
      });
      return children[0] || main;
    }

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

    return nodes[0] || main;
  }

  function isCurrentAnchorUsable(main) {
    var anchor = runtime.anchor;
    if (!anchor || !anchor.isConnected || !main || !main.contains(anchor)) return false;
    if (runtime.root && runtime.root.contains(anchor)) return false;
    return anchor === main || countMarkers(anchor) >= 1 || countMarkers(main) >= 2;
  }

  function ensureRoot(anchor) {
    ensureStyles();
    if (!runtime.root) {
      runtime.root = document.createElement("div");
      runtime.root.id = EMBED_ID;
      runtime.root.setAttribute("data-legacy-portfolio-returns-embed", "true");

      runtime.iframe = document.createElement("iframe");
      runtime.iframe.src = EMBED_SRC;
      runtime.iframe.setAttribute("title", "CryptoQuantAI 自动交易收益分析");
      runtime.iframe.setAttribute("scrolling", "auto");
      runtime.iframe.style.height = "360px";
      runtime.root.appendChild(runtime.iframe);
    }

    if (!anchor) return null;
    var parent = anchor.parentElement || anchor;
    var parentDisplay = "";
    try {
      parentDisplay = window.getComputedStyle(parent).display;
    } catch (_error) {
      parentDisplay = "";
    }
    if (parentDisplay.indexOf("grid") !== -1) runtime.root.setAttribute("data-grid-parent", "true");
    else runtime.root.removeAttribute("data-grid-parent");

    runtime.anchor = anchor;
    var alreadyPlaced = anchor === parent
      ? runtime.root.parentElement === parent
      : runtime.root.parentElement === parent && runtime.root.previousElementSibling === anchor;
    if (alreadyPlaced) return runtime.root;

    runtime.suppressMutationsUntil = Date.now() + 120;
    if (anchor === parent) {
      if (runtime.root.parentElement !== parent) parent.appendChild(runtime.root);
    } else if (runtime.root.parentElement !== parent || runtime.root.previousElementSibling !== anchor) {
      parent.insertBefore(runtime.root, anchor.nextSibling);
    }

    return runtime.root;
  }

  function showEmbed(anchor) {
    var root = ensureRoot(anchor);
    if (!root) return;
    root.style.display = "block";
  }

  function hideEmbed() {
    if (runtime.root) runtime.root.style.display = "none";
  }

  function syncEmbed() {
    if (!isPortfolioActive()) {
      clearRetryTimer();
      runtime.retryCount = 0;
      hideEmbed();
      return;
    }

    var main = getMain();
    var anchor = isCurrentAnchorUsable(main) ? runtime.anchor : findPortfolioAnchor(main);
    if (!anchor) {
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
    showEmbed(anchor);
  }

  function handleHeightMessage(event) {
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== "cq-legacy-portfolio-returns-height") return;
    if (!runtime.iframe) return;
    var height = Number(event.data.height);
    if (!Number.isFinite(height) || height <= 0) return;
    var nextHeight = Math.ceil(height);
    if (Math.abs(nextHeight - runtime.lastAppliedHeight) < 2) return;
    runtime.lastAppliedHeight = nextHeight;
    runtime.iframe.style.height = nextHeight + "px";
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

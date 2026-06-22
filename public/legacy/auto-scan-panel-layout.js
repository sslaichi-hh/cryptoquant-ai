(function () {
  "use strict";

  var PANEL_ID = "auto-scan-profiles-panel";
  var SETTINGS_DIALOG_LABEL = "\u7cfb\u7edf\u914d\u7f6e";
  var ACTIVE_STRATEGIES_LABEL = "\u6d3b\u8dc3\u7b56\u7565\u9009\u62e9";
  var THRESHOLD_LABEL = "\u81ea\u52a8\u4ea4\u6613\u89e6\u53d1\u9608\u503c";
  var SYNC_INTERVAL_MS = 2000;
  var scheduled = false;

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(node) {
    if (!node) return false;
    var style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    var rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getRootMount() {
    return document.getElementById("root");
  }

  function hidePanel(panel) {
    if (!panel) return;
    panel.dataset.location = "hidden";
    panel.style.display = "none";
    var root = getRootMount();
    if (root && panel.parentElement !== root) {
      root.appendChild(panel);
    }
  }

  function findSettingsDialog() {
    var dialogs = document.querySelectorAll("dialog, [role='dialog']");
    for (var i = 0; i < dialogs.length; i += 1) {
      if (!isVisible(dialogs[i])) continue;
      var text = normalizeText(dialogs[i].textContent);
      if (text.indexOf(SETTINGS_DIALOG_LABEL) !== -1) return dialogs[i];
    }
    return null;
  }

  function findHeading(dialog, label) {
    if (!dialog) return null;
    var headings = dialog.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']");
    for (var i = 0; i < headings.length; i += 1) {
      if (normalizeText(headings[i].textContent).indexOf(label) !== -1) {
        return headings[i];
      }
    }
    return null;
  }

  function getAncestorChain(node, stopNode) {
    var chain = [];
    var current = node;
    while (current && current !== stopNode) {
      chain.push(current);
      current = current.parentElement;
    }
    if (stopNode) chain.push(stopNode);
    return chain;
  }

  function findLowestCommonParent(first, second, stopNode) {
    var firstChain = getAncestorChain(first, stopNode);
    var secondChain = getAncestorChain(second, stopNode);
    for (var i = 0; i < firstChain.length; i += 1) {
      if (secondChain.indexOf(firstChain[i]) !== -1) return firstChain[i];
    }
    return stopNode || null;
  }

  function getBranchChild(commonParent, node) {
    var current = node;
    var child = node;
    while (current && current.parentElement && current.parentElement !== commonParent) {
      current = current.parentElement;
      child = current;
    }
    return child;
  }

  function findSectionAnchors(dialog) {
    var activeHeading = findHeading(dialog, ACTIVE_STRATEGIES_LABEL);
    if (!activeHeading) return { activeRoot: null, thresholdRoot: null };

    var thresholdHeading = findHeading(dialog, THRESHOLD_LABEL);
    if (!thresholdHeading) {
      return { activeRoot: activeHeading.parentElement || activeHeading, thresholdRoot: null };
    }

    var commonParent = findLowestCommonParent(activeHeading, thresholdHeading, dialog);
    return {
      activeRoot: getBranchChild(commonParent, activeHeading),
      thresholdRoot: getBranchChild(commonParent, thresholdHeading),
    };
  }

  function syncPanelLayout() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    var dialog = findSettingsDialog();
    if (!dialog) {
      hidePanel(panel);
      return;
    }

    var anchors = findSectionAnchors(dialog);
    if (!anchors.activeRoot) {
      hidePanel(panel);
      return;
    }

    panel.dataset.location = "settings";
    panel.style.display = "block";
    panel.style.width = "100%";
    panel.style.maxWidth = "none";
    panel.style.minWidth = "0";
    panel.style.margin = "0";

    if (
      anchors.thresholdRoot &&
      anchors.thresholdRoot.parentElement &&
      panel.parentElement === anchors.thresholdRoot.parentElement &&
      panel.nextElementSibling === anchors.thresholdRoot
    ) {
      return;
    }

    if (!anchors.thresholdRoot && panel.parentElement === anchors.activeRoot.parentElement && panel.previousElementSibling === anchors.activeRoot) {
      return;
    }

    if (anchors.thresholdRoot && anchors.thresholdRoot.parentElement) {
      anchors.thresholdRoot.parentElement.insertBefore(panel, anchors.thresholdRoot);
    } else {
      anchors.activeRoot.insertAdjacentElement("afterend", panel);
    }
  }

  function queueSync() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      syncPanelLayout();
    });
  }

  document.addEventListener("DOMContentLoaded", queueSync);
  window.addEventListener("load", queueSync);
  window.addEventListener("resize", queueSync);
  window.addEventListener("auto-scan-panel-mounted", queueSync);
  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      if (target.closest("button, [role='button']")) {
        setTimeout(queueSync, 80);
      }
    },
    true
  );
  setInterval(queueSync, SYNC_INTERVAL_MS);
})();

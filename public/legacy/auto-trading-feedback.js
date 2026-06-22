(function () {
  "use strict";

  var BANNER_ID = "legacy-auto-trading-feedback";
  var ACTION_PATHS = [
    "/api/auto-trading/start",
    "/api/auto-trading/stop",
    "/api/auto-trading/run-once",
  ];

  function getUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function isAutoTradingAction(url) {
    return ACTION_PATHS.some(function (path) {
      return url.indexOf(path) !== -1;
    });
  }

  function isAutoTradingStatus(url) {
    return url.indexOf("/api/auto-trading/status") !== -1;
  }

  function ensureStyles() {
    if (document.getElementById("legacy-auto-trading-feedback-style")) return;
    var style = document.createElement("style");
    style.id = "legacy-auto-trading-feedback-style";
    style.textContent = [
      "#" + BANNER_ID + "{margin-top:8px;max-width:560px;border-radius:12px;border:1px solid rgba(244,63,94,.35);background:rgba(127,29,29,.35);color:#fecdd3;padding:10px 12px;font-size:12px;line-height:1.5;box-shadow:0 12px 32px rgba(0,0,0,.25)}",
      "#" + BANNER_ID + "[data-kind='success']{border-color:rgba(52,211,153,.35);background:rgba(6,78,59,.32);color:#bbf7d0}",
      "#" + BANNER_ID + " strong{display:block;margin-bottom:2px;color:#fff;font-size:12px}",
    ].join("");
    document.head.appendChild(style);
  }

  function findAutoTradingContainer() {
    var label = document.getElementById("auto-trading-label");
    if (label) {
      var current = label;
      while (current && current !== document.body) {
        if (current.querySelector && current.querySelector("[role='switch']")) return current;
        current = current.parentElement;
      }
      return label.parentElement;
    }

    var switches = document.querySelectorAll("button[role='switch']");
    for (var i = 0; i < switches.length; i += 1) {
      var node = switches[i];
      var parent = node.parentElement;
      while (parent && parent !== document.body) {
        if ((parent.textContent || "").indexOf("自动交易") !== -1) return parent;
        parent = parent.parentElement;
      }
    }
    return document.getElementById("root") || document.body;
  }

  function showFeedback(message, kind) {
    if (!message) return;
    ensureStyles();
    var container = findAutoTradingContainer();
    if (!container) return;

    var banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement("div");
      banner.id = BANNER_ID;
    }
    banner.dataset.kind = kind || "error";
    banner.innerHTML =
      "<strong>" +
      (kind === "success" ? "自动交易请求已提交" : "自动交易无法启动") +
      "</strong><span></span>";
    banner.querySelector("span").textContent = message;

    if (container.nextElementSibling !== banner) {
      container.insertAdjacentElement("afterend", banner);
    }
  }

  function clearFeedback() {
    var banner = document.getElementById(BANNER_ID);
    if (banner) banner.remove();
  }

  function messageFromPayload(payload, fallback) {
    if (!payload || typeof payload !== "object") return fallback;
    if (payload.error) return String(payload.error);
    if (payload.lastError) return String(payload.lastError);
    if (payload.exchangeConnectivity && payload.exchangeConnectivity.error) {
      return String(payload.exchangeConnectivity.error);
    }
    return fallback;
  }

  function inspectAutoTradingResponse(url, response) {
    var clone;
    try {
      clone = response.clone();
    } catch (_error) {
      return;
    }

    clone
      .json()
      .then(function (payload) {
        if (!response.ok) {
          showFeedback(messageFromPayload(payload, response.statusText || "请求失败"), "error");
          return;
        }

        if (isAutoTradingStatus(url) && payload && payload.state === "error" && payload.lastError) {
          showFeedback(payload.lastError, "error");
          return;
        }

        if (isAutoTradingAction(url)) {
          if (payload && payload.state === "error" && payload.lastError) {
            showFeedback(payload.lastError, "error");
          } else {
            clearFeedback();
          }
        }
      })
      .catch(function () {});
  }

  if (!window.fetch || window.__cqAutoTradingFeedbackInstalled) return;
  window.__cqAutoTradingFeedbackInstalled = true;

  var originalFetch = window.fetch.bind(window);
  window.fetch = function () {
    var args = Array.prototype.slice.call(arguments);
    var url = getUrl(args[0]);
    var watch = isAutoTradingAction(url) || isAutoTradingStatus(url);

    return originalFetch
      .apply(window, args)
      .then(function (response) {
        if (watch) inspectAutoTradingResponse(url, response);
        return response;
      })
      .catch(function (error) {
        if (watch) {
          showFeedback(error && error.message ? error.message : "请求失败，请检查后端服务和网络。", "error");
        }
        throw error;
      });
  };
})();

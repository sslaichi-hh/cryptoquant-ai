(function () {
  "use strict";

  var PANEL_ID = "auto-scan-profiles-panel";
  var STYLE_ID = PANEL_ID + "-styles";
  var SETTINGS_BUTTON_LABEL = "\u7cfb\u7edf\u8bbe\u7f6e";
  var SAVE_LOCK = false;
  var panelInstance = null;
  var loadPromise = null;
  var panelState = {
    config: {},
    status: {},
    rows: [],
  };
  var defaults = {
    BTC: ["15m", "1h"],
    ETH: ["15m", "1h"],
    SOL: ["1h"],
    DOGE: ["1h"],
  };
  var symbols = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "DOGE/USDT"];
  var timeframes = ["15m", "1h"];

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function ensurePanelStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "#" + PANEL_ID + "{display:none;width:100%;max-width:none;min-width:0;box-sizing:border-box;}",
      "#" + PANEL_ID + "[data-location='settings']{display:block;margin-top:24px;padding-top:24px;border-top:1px solid rgba(63,63,70,0.72);}",
      "#" + PANEL_ID + " [data-role='header']{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;}",
      "#" + PANEL_ID + " [data-role='title-wrap']{flex:1 1 520px;min-width:0;}",
      "#" + PANEL_ID + " [data-role='title']{margin:0;font-size:18px;font-weight:800;color:#fafafa;}",
      "#" + PANEL_ID + " [data-role='subtitle']{margin:8px 0 0;max-width:none;word-break:break-word;font-size:12px;line-height:1.6;color:#a1a1aa;}",
      "#" + PANEL_ID + " [data-role='state']{flex:0 0 auto;align-self:flex-start;display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:16px;border:1px solid rgba(99,102,241,0.25);background:rgba(67,56,202,0.12);font-size:12px;font-weight:700;color:#c7d2fe;}",
      "#" + PANEL_ID + " [data-role='profiles']{display:grid;gap:12px;margin-top:20px;}",
      "#" + PANEL_ID + " [data-role='profile-row']{display:grid;grid-template-columns:minmax(220px,260px) minmax(0,1fr);gap:16px;align-items:center;padding:16px;border-radius:18px;border:1px solid rgba(39,39,42,1);background:rgba(9,9,11,0.45);}",
      "#" + PANEL_ID + " [data-role='profile-left']{display:flex;align-items:center;gap:12px;min-width:0;flex-wrap:wrap;}",
      "#" + PANEL_ID + " [data-role='profile-title']{font-size:15px;font-weight:800;color:#f4f4f5;}",
      "#" + PANEL_ID + " [data-role='profile-desc']{margin-top:4px;font-size:12px;}",
      "#" + PANEL_ID + " [data-role='profile-times']{display:flex;gap:10px;flex-wrap:wrap;min-width:0;justify-content:flex-end;}",
      "#" + PANEL_ID + " [data-role='footer']{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:18px;}",
      "#" + PANEL_ID + " [data-role='summary']{flex:1 1 320px;min-width:0;font-size:12px;color:#a1a1aa;}",
      "#" + PANEL_ID + " [data-role='actions']{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;}",
      "#" + PANEL_ID + " [data-role='message']{font-size:12px;color:#a1a1aa;min-height:18px;}",
      "#" + PANEL_ID + " [data-role='save']{height:40px;padding:0 18px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 10px 24px rgba(79,70,229,0.25);}",
      "@media (max-width: 1180px){#" + PANEL_ID + " [data-role='profile-row']{grid-template-columns:1fr;}#" + PANEL_ID + " [data-role='profile-times']{justify-content:flex-start;}}",
      "@media (max-width: 960px){#" + PANEL_ID + " [data-role='header']{flex-direction:column;align-items:stretch;}#" + PANEL_ID + " [data-role='state']{align-self:flex-start;}#" + PANEL_ID + " [data-role='footer']{flex-direction:column;align-items:stretch;}#" + PANEL_ID + " [data-role='actions']{justify-content:space-between;}#" + PANEL_ID + " [data-role='title-wrap']{flex-basis:auto;}}",
      "@media (max-width: 720px){#" + PANEL_ID + " [data-role='actions']{flex-direction:column;align-items:stretch;}#" + PANEL_ID + " [data-role='save']{width:100%;}}"
    ].join("");
    document.head.appendChild(style);
  }

  function getToken() {
    try {
      return sessionStorage.getItem("operator_token") || "";
    } catch (_error) {
      return "";
    }
  }

  function withAuthHeaders(extra) {
    var headers = new Headers(extra || {});
    var token = getToken();
    if (token) headers.set("Authorization", "Bearer " + token);
    return headers;
  }

  function fetchJson(url, options) {
    return fetch(url, {
      credentials: "same-origin",
      ...(options || {}),
      headers: withAuthHeaders(options && options.headers),
    }).then(function (response) {
      if (!response.ok) {
        return response
          .json()
          .catch(function () {
            return { error: "Request failed" };
          })
          .then(function (payload) {
            throw new Error(payload.error || ("HTTP " + response.status));
          });
      }
      return response.json();
    });
  }

  function getDefaultProfiles() {
    return symbols.map(function (symbol) {
      var key = symbol.split("/")[0];
      return { symbol: symbol, timeframes: (defaults[key] || ["1h"]).slice() };
    });
  }

  function shouldRepairLegacyProfiles(config) {
    if (!config || Number(config.scanProfilesVersion || 0) >= 2) return false;
    if (!Array.isArray(config.scanProfiles) || !config.scanProfiles.length) return true;
    var profiles = config.scanProfiles
      .map(function (profile) {
        return {
          symbol: String((profile && profile.symbol) || "").toUpperCase(),
          timeframes: Array.isArray(profile && profile.timeframes)
            ? profile.timeframes.map(function (value) {
                return String(value || "").trim();
              }).filter(Boolean)
            : [],
        };
      })
      .filter(function (profile) {
        return !!profile.symbol;
      });
    var bySymbol = {};
    profiles.forEach(function (profile) {
      bySymbol[profile.symbol] = profile.timeframes;
    });
    var hasAllSymbols = symbols.every(function (symbol) {
      return Array.isArray(bySymbol[symbol]);
    });
    var singleOneHour = profiles.length > 0 && profiles.every(function (profile) {
      return profile.timeframes.length === 1 && profile.timeframes[0] === "1h";
    });
    return !hasAllSymbols && singleOneHour;
  }

  function normalizeConfig(config) {
    var scanProfiles =
      shouldRepairLegacyProfiles(config)
        ? getDefaultProfiles()
        : Array.isArray(config && config.scanProfiles) && config.scanProfiles.length
        ? config.scanProfiles
        : getDefaultProfiles();
    var bySymbol = {};
    scanProfiles.forEach(function (profile) {
      if (!profile || !profile.symbol) return;
      bySymbol[String(profile.symbol).toUpperCase()] = {
        symbol: String(profile.symbol).toUpperCase(),
        timeframes: Array.isArray(profile.timeframes)
          ? profile.timeframes.filter(function (value) {
              return timeframes.indexOf(String(value)) !== -1;
            })
          : [],
      };
    });
    return symbols.map(function (symbol) {
      var item = bySymbol[symbol];
      var enabled = !!item;
      var selected =
        enabled && item.timeframes.length
          ? item.timeframes.slice()
          : (defaults[symbol.split("/")[0]] || ["1h"]).slice();
      return {
        symbol: symbol,
        enabled: enabled,
        timeframes: selected,
      };
    });
  }

  function serializeProfiles(rows) {
    return rows
      .filter(function (row) {
        return row.enabled;
      })
      .map(function (row) {
        var selected = row.timeframes.filter(function (value) {
          return timeframes.indexOf(value) !== -1;
        });
        return {
          symbol: row.symbol,
          timeframes: selected.length ? selected : ["1h"],
        };
      });
  }

  function createCheckbox(checked, disabled) {
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!checked;
    input.disabled = !!disabled;
    input.style.cssText = "width:16px;height:16px;accent-color:#6366f1;cursor:pointer;";
    if (disabled) input.style.cursor = "not-allowed";
    return input;
  }

  function createTag(label, active) {
    var span = document.createElement("span");
    span.textContent = label;
    span.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;min-width:52px;height:28px;padding:0 10px;" +
      "border-radius:999px;border:1px solid " +
      (active ? "rgba(99,102,241,0.45)" : "rgba(63,63,70,0.9)") +
      ";" +
      "background:" +
      (active ? "rgba(99,102,241,0.16)" : "rgba(24,24,27,0.92)") +
      ";" +
      "color:" +
      (active ? "#c7d2fe" : "#a1a1aa") +
      ";font-size:12px;font-weight:700;";
    return span;
  }

  function buildPanel() {
    var panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.dataset.location = "hidden";
    panel.style.cssText = "display:none;width:100%;box-sizing:border-box;";

    var header = document.createElement("div");
    header.setAttribute("data-role", "header");

    var titleWrap = document.createElement("div");
    titleWrap.setAttribute("data-role", "title-wrap");

    var title = document.createElement("h3");
    title.setAttribute("data-role", "title");
    title.textContent = "\u81ea\u52a8\u4ea4\u6613\u626b\u63cf\u914d\u7f6e";

    var subtitle = document.createElement("p");
    subtitle.setAttribute("data-role", "subtitle");
    subtitle.textContent =
      "BTC/ETH \u652f\u6301 15m + 1h\uff0cSOL/DOGE \u9ed8\u8ba4 1h\u3002\u4fdd\u5b58\u540e\u7acb\u5373\u843d\u5e93\uff0c\u8fd0\u884c\u4e2d\u7684\u5f15\u64ce\u4ece\u4e0b\u4e00\u8f6e\u5f00\u59cb\u751f\u6548\u3002";

    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    var stateBox = document.createElement("div");
    stateBox.setAttribute("data-role", "state");
    stateBox.textContent = "\u52a0\u8f7d\u4e2d...";

    header.appendChild(titleWrap);
    header.appendChild(stateBox);
    panel.appendChild(header);

    var list = document.createElement("div");
    list.setAttribute("data-role", "profiles");
    panel.appendChild(list);

    var footer = document.createElement("div");
    footer.setAttribute("data-role", "footer");

    var summary = document.createElement("div");
    summary.setAttribute("data-role", "summary");
    footer.appendChild(summary);

    var actions = document.createElement("div");
    actions.setAttribute("data-role", "actions");

    var message = document.createElement("div");
    message.setAttribute("data-role", "message");

    var save = document.createElement("button");
    save.type = "button";
    save.setAttribute("data-role", "save");
    save.textContent = "\u4fdd\u5b58\u626b\u63cf\u914d\u7f6e";

    actions.appendChild(message);
    actions.appendChild(save);
    footer.appendChild(actions);
    panel.appendChild(footer);

    return panel;
  }

  function renderProfiles(panel, rows) {
    var list = panel.querySelector("[data-role='profiles']");
    list.innerHTML = "";

    rows.forEach(function (row, index) {
      var item = document.createElement("div");
      item.setAttribute("data-role", "profile-row");

      var left = document.createElement("div");
      left.setAttribute("data-role", "profile-left");

      var toggle = createCheckbox(row.enabled, false);
      toggle.addEventListener("change", function () {
        panelState.rows[index].enabled = toggle.checked;
        if (panelState.rows[index].enabled && panelState.rows[index].timeframes.length === 0) {
          panelState.rows[index].timeframes = (defaults[row.symbol.split("/")[0]] || ["1h"]).slice();
        }
        renderProfiles(panel, panelState.rows);
        renderSummary(panel, panelState.rows);
      });

      var textWrap = document.createElement("div");
      var title = document.createElement("div");
      title.setAttribute("data-role", "profile-title");
      title.textContent = row.symbol;

      var desc = document.createElement("div");
      desc.setAttribute("data-role", "profile-desc");
      desc.textContent = row.enabled ? "\u5df2\u542f\u7528" : "\u672a\u542f\u7528";
      desc.style.color = row.enabled ? "#34d399" : "#71717a";

      textWrap.appendChild(title);
      textWrap.appendChild(desc);
      left.appendChild(toggle);
      left.appendChild(textWrap);

      var right = document.createElement("div");
      right.setAttribute("data-role", "profile-times");

      timeframes.forEach(function (timeframe) {
        var button = document.createElement("label");
        button.style.cssText =
          "display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;" +
          "border:1px solid " + (row.enabled ? "rgba(63,63,70,0.9)" : "rgba(39,39,42,1)") + ";" +
          "background:" + (row.enabled ? "rgba(24,24,27,0.92)" : "rgba(24,24,27,0.45)") + ";" +
          "color:" + (row.enabled ? "#d4d4d8" : "#71717a") + ";font-size:12px;font-weight:700;";

        var checkbox = createCheckbox(row.timeframes.indexOf(timeframe) !== -1, !row.enabled);
        checkbox.addEventListener("change", function () {
          if (!panelState.rows[index].enabled) return;
          var current = panelState.rows[index].timeframes.slice();
          if (checkbox.checked) {
            if (current.indexOf(timeframe) === -1) current.push(timeframe);
          } else {
            current = current.filter(function (value) {
              return value !== timeframe;
            });
            if (current.length === 0) {
              checkbox.checked = true;
              return;
            }
          }
          panelState.rows[index].timeframes = current.sort();
          renderProfiles(panel, panelState.rows);
          renderSummary(panel, panelState.rows);
        });

        button.appendChild(checkbox);
        button.appendChild(createTag(timeframe, row.timeframes.indexOf(timeframe) !== -1 && row.enabled));
        right.appendChild(button);
      });

      item.appendChild(left);
      item.appendChild(right);
      list.appendChild(item);
    });
  }

  function renderSummary(panel, rows) {
    var enabledRows = rows.filter(function (row) {
      return row.enabled;
    });
    var targetCount = enabledRows.reduce(function (sum, row) {
      return sum + row.timeframes.length;
    }, 0);
    var summary = panel.querySelector("[data-role='summary']");
    summary.textContent =
      "\u542f\u7528\u5e01\u79cd " + enabledRows.length + " \u4e2a\uff0c\u626b\u63cf\u76ee\u6807 " + targetCount + " \u4e2a";
  }

  function setPanelState(panel, text) {
    var node = panel.querySelector("[data-role='state']");
    if (node) node.textContent = text;
  }

  function setPanelMessage(panel, text, kind) {
    var node = panel.querySelector("[data-role='message']");
    if (!node) return;
    node.textContent = text || "";
    node.style.color =
      kind === "error" ? "#fb7185" : kind === "success" ? "#34d399" : "#a1a1aa";
  }

  function getPanel() {
    if (!panelInstance) {
      ensurePanelStyles();
      panelInstance = buildPanel();
      bindSave(panelInstance);
    }
    return panelInstance;
  }

  function attach(panel) {
    var root = document.getElementById("root");
    if (!root || !panel) return false;
    if (!panel.isConnected) {
      panel.dataset.location = "hidden";
      panel.style.display = "none";
      root.appendChild(panel);
    }
    return true;
  }

  function refreshPanelData(panel, force) {
    if (!panel || !getToken()) return Promise.resolve();
    if (loadPromise) return loadPromise;
    if (!force && panel.dataset.loaded === "true") return Promise.resolve();

    setPanelState(panel, "\u52a0\u8f7d\u4e2d...");
    setPanelMessage(panel, "", "muted");

    loadPromise = fetchJson("/api/auto-trading/config")
      .then(function (payload) {
        panelState.config = payload && payload.config ? payload.config : {};
        panelState.status = payload && payload.status ? payload.status : {};
        panelState.rows = normalizeConfig(panelState.config);
        renderProfiles(panel, panelState.rows);
        renderSummary(panel, panelState.rows);
        setPanelState(panel, "\u5f15\u64ce\u72b6\u6001: " + (panelState.status.state || "unknown"));
        panel.dataset.loaded = "true";
      })
      .catch(function (error) {
        setPanelState(panel, "\u914d\u7f6e\u52a0\u8f7d\u5931\u8d25");
        setPanelMessage(
          panel,
          error && error.message ? error.message : "\u65e0\u6cd5\u8bfb\u53d6\u81ea\u52a8\u4ea4\u6613\u914d\u7f6e",
          "error"
        );
      })
      .finally(function () {
        loadPromise = null;
      });

    return loadPromise;
  }

  function bindSave(panel) {
    if (panel.dataset.bound === "true") return;
    panel.dataset.bound = "true";

    var saveButton = panel.querySelector("[data-role='save']");
    saveButton.addEventListener("click", function () {
      if (SAVE_LOCK) return;
      var scanProfiles = serializeProfiles(panelState.rows);
      if (!scanProfiles.length) {
        setPanelMessage(panel, "\u81f3\u5c11\u542f\u7528\u4e00\u4e2a\u5e01\u79cd\u3002", "error");
        return;
      }

      SAVE_LOCK = true;
      saveButton.disabled = true;
      saveButton.style.opacity = "0.65";
      setPanelMessage(panel, "\u4fdd\u5b58\u4e2d...", "muted");

      fetchJson("/api/auto-trading/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandbox: !!panelState.config.sandbox,
          scanProfilesVersion: 2,
          strategyIds: Array.isArray(panelState.config.strategyIds)
            ? panelState.config.strategyIds
            : ["trend-breakout", "mean-reversion"],
          riskConfigSnapshot: panelState.config.riskConfigSnapshot || {},
          shadowMode: panelState.config.shadowMode !== false,
          scanProfiles: scanProfiles,
        }),
      })
        .then(function (nextPayload) {
          panelState.config =
            nextPayload && nextPayload.config ? nextPayload.config : panelState.config;
          panelState.status =
            nextPayload && nextPayload.status ? nextPayload.status : panelState.status;
          panelState.rows = normalizeConfig(panelState.config);
          renderProfiles(panel, panelState.rows);
          renderSummary(panel, panelState.rows);
          setPanelState(panel, "\u5f15\u64ce\u72b6\u6001: " + (panelState.status.state || "unknown"));
          panel.dataset.loaded = "true";
          setPanelMessage(
            panel,
            panelState.status.state === "running"
              ? "\u65b0\u914d\u7f6e\u5df2\u4fdd\u5b58\uff0c\u5c06\u4ece\u4e0b\u4e00\u8f6e\u626b\u63cf\u5f00\u59cb\u4f7f\u7528\u3002"
              : "\u626b\u63cf\u914d\u7f6e\u5df2\u4fdd\u5b58\u3002",
            "success"
          );
        })
        .catch(function (error) {
          setPanelMessage(
            panel,
            error && error.message ? error.message : "\u4fdd\u5b58\u5931\u8d25",
            "error"
          );
        })
        .finally(function () {
          SAVE_LOCK = false;
          saveButton.disabled = false;
          saveButton.style.opacity = "1";
        });
    });
  }

  function enhance(force) {
    if (!getToken()) return;
    var panel = getPanel();
    if (!attach(panel)) return;
    refreshPanelData(panel, !!force);
  }

  document.addEventListener("DOMContentLoaded", function () {
    enhance(false);
  });
  window.addEventListener("load", function () {
    enhance(false);
  });
  window.addEventListener("auto-scan-panel-mounted", function () {
    enhance(false);
  });
  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var button = target.closest("button, [role='button']");
      if (!button) return;
      var text = normalizeText(button.textContent);
      if (text.indexOf(SETTINGS_BUTTON_LABEL) !== -1) {
        setTimeout(function () {
          enhance(true);
        }, 100);
      }
    },
    true
  );
  setInterval(function () {
    if (getToken()) {
      enhance(false);
    }
  }, 5000);
})();

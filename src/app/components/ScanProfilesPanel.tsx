import React from "react";
import clsx from "clsx";

import type { AutoTradingConfig } from "../api";
import {
  draftToProfiles,
  profilesToDraft,
  type ScanProfileDraft,
} from "../utils";
import { AUTO_TRADING_ALLOWED_TIMEFRAMES } from "../../lib/tradingRuntime";
import { cardClassName } from "../utils";
import { SectionTitle } from "./common";

export function ScanProfilesPanel({
  config,
  saving,
  onSave,
}: {
  config: AutoTradingConfig | null;
  saving: boolean;
  onSave: (profiles: AutoTradingConfig["scanProfiles"]) => Promise<void>;
}) {
  const [draft, setDraft] = React.useState<ScanProfileDraft[]>(() => profilesToDraft(config));

  React.useEffect(() => {
    setDraft(profilesToDraft(config));
  }, [config]);

  const enabledTargets = draft.reduce((acc, row) => acc + (row.enabled ? row.timeframes.length : 0), 0);

  return (
    <section className={cardClassName()}>
      <SectionTitle
        title="自动交易扫描配置"
        subtitle="BTC/ETH 默认勾选 15m + 1h，SOL/DOGE 默认勾选 1h。保存后立即写入后端，下一轮自动交易生效。"
        action={
          <div className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-200">
            扫描目标 {enabledTargets}
          </div>
        }
      />

      <div className="space-y-3">
        {draft.map((row, rowIndex) => (
          <div
            key={row.symbol}
            className="grid gap-4 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 md:grid-cols-[220px_1fr]"
          >
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={row.enabled}
                onChange={(event) => {
                  setDraft((current) =>
                    current.map((item, index) =>
                      index === rowIndex
                        ? {
                            ...item,
                            enabled: event.target.checked,
                            timeframes:
                              event.target.checked && item.timeframes.length === 0 ? ["1h"] : item.timeframes,
                          }
                        : item
                    )
                  );
                }}
                className="h-4 w-4 accent-indigo-500"
              />
              <div>
                <div className="font-medium text-zinc-50">{row.symbol}</div>
                <div className="text-xs text-zinc-500">{row.enabled ? "已启用" : "未启用"}</div>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              {AUTO_TRADING_ALLOWED_TIMEFRAMES.map((timeframe) => {
                const active = row.timeframes.includes(timeframe);
                return (
                  <label
                    key={timeframe}
                    className={clsx(
                      "inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm transition",
                      row.enabled
                        ? "border-zinc-700 bg-zinc-900 text-zinc-200"
                        : "border-zinc-800 bg-zinc-950 text-zinc-600"
                    )}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-indigo-500"
                      disabled={!row.enabled}
                      checked={active}
                      onChange={(event) => {
                        setDraft((current) =>
                          current.map((item, index) => {
                            if (index !== rowIndex) return item;
                            let timeframes = item.timeframes;
                            if (event.target.checked) {
                              timeframes = Array.from(new Set([...item.timeframes, timeframe])).sort();
                            } else {
                              timeframes = item.timeframes.filter((value) => value !== timeframe);
                              if (timeframes.length === 0) return item;
                            }
                            return { ...item, timeframes };
                          })
                        );
                      }}
                    />
                    <span>{timeframe}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center justify-between gap-4">
        <div className="text-sm text-zinc-500">
          相关性规则保持不变：BTC/ETH 同组，SOL 和 DOGE 独立。
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave(draftToProfiles(draft))}
          className="rounded-2xl bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-indigo-900"
        >
          {saving ? "保存中..." : "保存扫描配置"}
        </button>
      </div>
    </section>
  );
}

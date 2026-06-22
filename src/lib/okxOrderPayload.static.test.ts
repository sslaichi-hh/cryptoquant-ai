import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const serverSource = fs.readFileSync(path.join(process.cwd(), "server.ts"), "utf-8");

describe("OKX order submit path", () => {
  it("uses attachAlgoOrds for attached TP/SL on raw OKX orders", () => {
    expect(serverSource).toContain("orderPayload.attachAlgoOrds");
    expect(serverSource).toContain("privatePostTradeOrder(orderPayload)");
    expect(serverSource).not.toContain("orderPayload.tpTriggerPx");
    expect(serverSource).not.toContain("orderPayload.slTriggerPx");
  });

  it("does not keep the old ccxt order route branch alive", () => {
    expect(serverSource).not.toContain("params.tpTriggerPx");
    expect(serverSource).not.toContain("params.slTriggerPx");
    expect(serverSource).not.toContain("exchange.createMarketOrder(ccxtSymbol");
  });
});

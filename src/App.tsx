import { ConsoleApp } from "./app/ConsoleApp";
import { EmbeddedBacktestApp } from "./app/EmbeddedBacktestApp";
import { EmbeddedDiagnosticsApp } from "./app/EmbeddedDiagnosticsApp";
import { EmbeddedPortfolioReturnsApp } from "./app/EmbeddedPortfolioReturnsApp";

function LegacyShell() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="flex min-h-screen flex-col">
        <header className="border-b border-zinc-800 bg-zinc-950/95 px-6 py-4 backdrop-blur">
          <div className="mx-auto w-full max-w-7xl">
            <h1 className="text-lg font-semibold">CryptoQuant AI Console</h1>
            <p className="text-sm text-zinc-400">Legacy mode</p>
          </div>
        </header>
        <main className="flex-1">
          <iframe
            title="CryptoQuant AI Legacy Console"
            src="/legacy/index.html"
            className="h-[calc(100vh-73px)] w-full border-0"
          />
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const search = typeof window !== "undefined" ? window.location.search : "";
  const params = new URLSearchParams(search);
  const embedMode = params.get("embed");

  if (embedMode === "diagnostics") {
    return <EmbeddedDiagnosticsApp />;
  }

  if (embedMode === "backtest") {
    return <EmbeddedBacktestApp />;
  }

  if (embedMode === "portfolio-returns") {
    return <EmbeddedPortfolioReturnsApp />;
  }

  return params.get("legacy") === "1" ? <LegacyShell /> : <ConsoleApp />;
}

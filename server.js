// ============================================================================
//  Binance USDⓈ-M Futures CORS Proxy  —  零依賴 (Node 18+ 內建 fetch)
//  用途：前端打這台伺服器 → 由它代為向 Binance 取資料 → 回傳並補上 CORS 標頭
//  路徑對應：  /fapi/v1/ticker/24hr  →  https://fapi.binance.com/fapi/v1/ticker/24hr
// ============================================================================
const http = require("http");

const PORT = process.env.PORT || 8080;
const MY_PROXY = "https://binance-proxy-production-b951.up.railway.app";

// 多個 Binance 邊緣節點，自動容錯（某些地區封鎖主節點時切換）
const BINANCE_HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
];

// 允許的來源（CORS）。預設全開；要鎖網域就設環境變數 ALLOW_ORIGIN
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

// 簡易記憶體 TTL 快取，降低對 Binance 的請求量、加快回應
const cache = new Map();
const ttlFor = (p) =>
  p.includes("/ticker/24hr") ? 4000 :   // 24h 行情 4 秒
  p.includes("/klines")      ? 2000 :   // K 線     2 秒
  2000;

async function fetchBinance(path) {
  let lastErr;
  for (const host of BINANCE_HOSTS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      const r = await fetch(host + path, {
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      });
      clearTimeout(timer);
      if (!r.ok) { lastErr = new Error(`Binance HTTP ${r.status}`); continue; }
      return await r.text();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("所有 Binance 節點都無法連線");
}

const server = http.createServer(async (req, res) => {
  // 每個回應都補 CORS 標頭
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method !== "GET")     { res.writeHead(405); return res.end("Method Not Allowed"); }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // 健康檢查
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  }
  // 根路徑友善提示
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      service: "binance-futures-cors-proxy",
      usage: "GET /fapi/v1/ticker/24hr  或  /fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=100",
    }));
  }

  // 只允許代理 Binance 合約 (fapi) 路徑，避免被當開放代理濫用
  if (!url.pathname.startsWith("/fapi/")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "只支援 /fapi/... 路徑" }));
  }

  const binancePath = url.pathname + (url.search || "");
  const now = Date.now();
  const hit = cache.get(binancePath);
  if (hit && now - hit.t < ttlFor(binancePath)) {
    res.writeHead(200, { "Content-Type": "application/json", "X-Cache": "HIT" });
    return res.end(hit.body);
  }

  try {
    const body = await fetchBinance(binancePath);
    cache.set(binancePath, { body, t: now });
    // 偶爾清理過期快取
    if (cache.size > 800) {
      for (const [k, v] of cache) if (now - v.t > 60000) cache.delete(k);
    }
    res.writeHead(200, { "Content-Type": "application/json", "X-Cache": "MISS" });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
});

server.listen(PORT, () => console.log(`✅ Binance proxy 已啟動 → http://localhost:${PORT}`));

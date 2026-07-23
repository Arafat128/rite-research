/**
 * Oracast Markets + token resolution for Rite price watches.
 * Primary: Oracast (Ritual ecosystem). Fallbacks: CoinGecko, DexScreener, Coinbase.
 */

export type OracastToken = {
  id: string;
  symbol: string;
  name: string;
  brandColor?: string;
};

/** Curated list matching Oracast defaults + common picks */
export const ORACAST_TOKEN_LIST: OracastToken[] = [
  { id: "bitcoin", symbol: "BTC", name: "Bitcoin", brandColor: "#F7931A" },
  { id: "ethereum", symbol: "ETH", name: "Ethereum", brandColor: "#627EEA" },
  { id: "solana", symbol: "SOL", name: "Solana", brandColor: "#14F195" },
  { id: "binancecoin", symbol: "BNB", name: "BNB", brandColor: "#F3BA2F" },
  { id: "ripple", symbol: "XRP", name: "XRP", brandColor: "#23292F" },
  { id: "cardano", symbol: "ADA", name: "Cardano", brandColor: "#0033AD" },
  { id: "dogecoin", symbol: "DOGE", name: "Dogecoin", brandColor: "#C2A633" },
  { id: "avalanche-2", symbol: "AVAX", name: "Avalanche", brandColor: "#E84142" },
  { id: "chainlink", symbol: "LINK", name: "Chainlink", brandColor: "#375BD2" },
  { id: "uniswap", symbol: "UNI", name: "Uniswap", brandColor: "#FF007A" },
  { id: "usd-coin", symbol: "USDC", name: "USD Coin", brandColor: "#2775CA" },
  { id: "tether", symbol: "USDT", name: "Tether", brandColor: "#26A17B" },
  { id: "arbitrum", symbol: "ARB", name: "Arbitrum", brandColor: "#28A0F0" },
  { id: "optimism", symbol: "OP", name: "Optimism", brandColor: "#FF0420" },
  { id: "polygon-ecosystem-token", symbol: "POL", name: "POL", brandColor: "#8247E5" },
  { id: "pepe", symbol: "PEPE", name: "Pepe", brandColor: "#3D9A3B" },
  { id: "sui", symbol: "SUI", name: "Sui", brandColor: "#4DA2FF" },
  { id: "near", symbol: "NEAR", name: "NEAR", brandColor: "#00C08B" },
];

export type PriceQuote = {
  price: number;
  symbol: string;
  name: string;
  coinId?: string;
  contractAddress?: string;
  source: string;
  change24h?: number;
  volume24h?: number;
  fetchedAt: string;
};

const ORACAST_BASE =
  process.env.ORACAST_BASE_URL?.replace(/\/$/, "") ||
  "https://oracast.markets";

async function fetchJson(url: string, timeoutMs = 10_000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function scale1e18(s: string | undefined): number | undefined {
  if (!s) return undefined;
  try {
    return Number(BigInt(s)) / 1e18;
  } catch {
    return undefined;
  }
}

export async function fetchOracastByCoinId(
  coinId: string
): Promise<PriceQuote | null> {
  const id = coinId.trim().toLowerCase();
  if (!id) return null;

  try {
    const data = (await fetchJson(
      `${ORACAST_BASE}/api/features/all/${encodeURIComponent(id)}`
    )) as Record<string, unknown>;
    const price = Number(data.price);
    if (Number.isFinite(price) && price > 0) {
      return {
        price,
        symbol: String(data.symbol || id).toUpperCase(),
        name: String(data.name || id),
        coinId: id,
        source: String(data.source || "oracast"),
        change24h:
          typeof data.volatility === "number"
            ? Number(data.volatility) *
              (data.direction === 0 ? -1 : 1)
            : undefined,
        volume24h: Number(data.volume) || undefined,
        fetchedAt: new Date().toISOString(),
      };
    }
  } catch {
    /* try uint256 */
  }

  try {
    const data = (await fetchJson(
      `${ORACAST_BASE}/api/features/${encodeURIComponent(id)}`
    )) as Record<string, unknown>;
    const price = scale1e18(data.price as string);
    if (price && price > 0) {
      const token = ORACAST_TOKEN_LIST.find((t) => t.id === id);
      return {
        price,
        symbol: token?.symbol || id.toUpperCase(),
        name: token?.name || id,
        coinId: id,
        source: "oracast-uint256",
        fetchedAt: new Date().toISOString(),
      };
    }
  } catch {
    /* fall through */
  }

  // CoinGecko simple (same primary stack as Oracast)
  try {
    const data = (await fetchJson(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`
    )) as Record<
      string,
      { usd?: number; usd_24h_change?: number; usd_24h_vol?: number }
    >;
    const row = data[id];
    const price = Number(row?.usd);
    if (Number.isFinite(price) && price > 0) {
      const token = ORACAST_TOKEN_LIST.find((t) => t.id === id);
      return {
        price,
        symbol: token?.symbol || id.toUpperCase(),
        name: token?.name || id,
        coinId: id,
        source: "coingecko",
        change24h: Number(row?.usd_24h_change) || undefined,
        volume24h: Number(row?.usd_24h_vol) || undefined,
        fetchedAt: new Date().toISOString(),
      };
    }
  } catch {
    /* ignore */
  }

  return null;
}

/** Resolve ERC-20 (or other) by contract via DexScreener + CoinGecko. */
export async function fetchPriceByContract(
  address: string,
  chainHint?: string
): Promise<PriceQuote | null> {
  const addr = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address.trim())) {
    // allow solana-style base58 too for dexscreener
    if (!/^[a-zA-Z0-9]{32,64}$/.test(address.trim())) return null;
  }

  const raw = address.trim();

  // DexScreener: works for many chains including contract paste
  try {
    const data = (await fetchJson(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(raw)}`
    )) as {
      pairs?: Array<{
        chainId?: string;
        baseToken?: { address?: string; symbol?: string; name?: string };
        priceUsd?: string;
        priceChange?: { h24?: number };
        volume?: { h24?: number };
        liquidity?: { usd?: number };
      }>;
    };
    const pairs = (data.pairs || [])
      .filter((p) => p.priceUsd && Number(p.priceUsd) > 0)
      .sort(
        (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      );
    let best = pairs[0];
    if (chainHint) {
      const hit = pairs.find(
        (p) =>
          (p.chainId || "").toLowerCase() === chainHint.toLowerCase()
      );
      if (hit) best = hit;
    }
    if (best?.priceUsd) {
      const price = Number(best.priceUsd);
      return {
        price,
        symbol: (best.baseToken?.symbol || "TOKEN").toUpperCase(),
        name: best.baseToken?.name || best.baseToken?.symbol || "Token",
        contractAddress: raw,
        source: `dexscreener:${best.chainId || "multi"}`,
        change24h: best.priceChange?.h24,
        volume24h: best.volume?.h24,
        fetchedAt: new Date().toISOString(),
      };
    }
  } catch {
    /* try CG */
  }

  // CoinGecko ethereum contract path (common for 0x addresses)
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    const platforms = ["ethereum", "base", "arbitrum-one", "polygon-pos", "optimistic-ethereum", "binance-smart-chain"];
    for (const platform of platforms) {
      try {
        const data = (await fetchJson(
          `https://api.coingecko.com/api/v3/coins/${platform}/contract/${raw.toLowerCase()}`
        )) as {
          id?: string;
          symbol?: string;
          name?: string;
          market_data?: {
            current_price?: { usd?: number };
            price_change_percentage_24h?: number;
            total_volume?: { usd?: number };
          };
        };
        const price = Number(data.market_data?.current_price?.usd);
        if (Number.isFinite(price) && price > 0) {
          return {
            price,
            symbol: (data.symbol || "TOKEN").toUpperCase(),
            name: data.name || data.symbol || "Token",
            coinId: data.id,
            contractAddress: raw,
            source: `coingecko:${platform}`,
            change24h: data.market_data?.price_change_percentage_24h,
            volume24h: data.market_data?.total_volume?.usd,
            fetchedAt: new Date().toISOString(),
          };
        }
      } catch {
        /* next platform */
      }
    }
  }

  return null;
}

export async function resolvePrice(input: {
  coinId?: string;
  contractAddress?: string;
  chainHint?: string;
}): Promise<PriceQuote> {
  if (input.coinId) {
    const q = await fetchOracastByCoinId(input.coinId);
    if (q) return q;
  }
  if (input.contractAddress) {
    const q = await fetchPriceByContract(
      input.contractAddress,
      input.chainHint
    );
    if (q) return q;
  }
  throw new Error(
    "Could not resolve token price. Pick a listed token or paste a valid contract address."
  );
}

export function formatUsdPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000)
    return n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  if (n >= 1)
    return n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  if (n >= 0.0001)
    return n.toLocaleString("en-US", {
      minimumFractionDigits: 4,
      maximumFractionDigits: 6,
    });
  return n.toExponential(3);
}

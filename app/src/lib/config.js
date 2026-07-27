// Single source of truth for chain + contract config.
// Defaults = Robinhood Chain mainnet; set NEXT_PUBLIC_CHAIN_ID=46630 (plus
// the address vars) to run against testnet.
import { defineChain } from "viem";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 4663);
const IS_TESTNET = CHAIN_ID === 46630;

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ||
  (IS_TESTNET
    ? "https://rpc.testnet.chain.robinhood.com"
    : "https://rpc.mainnet.chain.robinhood.com");

export const EXPLORER =
  process.env.NEXT_PUBLIC_EXPLORER ||
  (IS_TESTNET
    ? "https://robinhoodchain-testnet.blockscout.com"
    : "https://robinhoodchain.blockscout.com");

// Paxos USDG on mainnet; on testnet the deploy script's MockUSDG address
// must be provided via env
export const USDG_ADDR =
  process.env.NEXT_PUBLIC_USDG_ADDR || "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

export const GRID_ADDR =
  process.env.NEXT_PUBLIC_GROOD_ADDR || "0x0000000000000000000000000000000000000000";
export const TOKEN_ADDR =
  process.env.NEXT_PUBLIC_GROOD_TOKEN_ADDR || "0x0000000000000000000000000000000000000000";

export const ALCHEMY_RPC = process.env.NEXT_PUBLIC_ALCHEMY_RPC || "";
export const GAS_SPONSOR = process.env.NEXT_PUBLIC_GAS_SPONSOR === "true";
export const SSE_URL = process.env.NEXT_PUBLIC_SSE_URL || "";
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
export const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON || "";

export const DRAND_CHAIN_HASH =
  "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3";

export const robinhood = defineChain({
  id: CHAIN_ID,
  name: IS_TESTNET ? "Robinhood Chain Testnet" : "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER } },
});

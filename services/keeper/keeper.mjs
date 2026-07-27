/**
 * Grood keeper — replaces the GridZero Kurier/zkVerify resolver bot.
 *
 * Watches the Grood contract on Robinhood Chain; when a round ends it fetches
 * the pinned drand evmnet beacon signature (public, verifiable) and calls
 * resolveRound(). The contract verifies the BLS signature on-chain, so this
 * bot holds no trust: anyone can run it, and the caller earns resolverReward.
 * Also serves the SSE event feed the frontend consumes and (optionally)
 * mirrors rounds into Supabase.
 *
 * Env:
 *   PRIVATE_KEY        keeper wallet (needs dust ETH for gas)
 *   GROOD_ADDRESS      deployed Grood contract
 *   RPC_URL            default https://rpc.mainnet.chain.robinhood.com
 *   SEQUENCER_RPC      optional write-only endpoint (lower latency, FCFS)
 *   PORT               SSE port, default 8787
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY   optional history mirror (gz_rounds)
 */
import http from "node:http";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http as viemHttp,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const SEQUENCER_RPC = process.env.SEQUENCER_RPC || RPC_URL;
const GROOD_ADDRESS = process.env.GROOD_ADDRESS;
const PORT = Number(process.env.PORT || 8787);
if (!process.env.PRIVATE_KEY || !GROOD_ADDRESS) {
  console.error("PRIVATE_KEY and GROOD_ADDRESS are required");
  process.exit(1);
}

// drand evmnet — signatures verified on-chain; mirrors are interchangeable
const DRAND_CHAIN_HASH = "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3";
const DRAND_MIRRORS = [
  `https://api.drand.sh/${DRAND_CHAIN_HASH}`,
  `https://api2.drand.sh/${DRAND_CHAIN_HASH}`,
  `https://api3.drand.sh/${DRAND_CHAIN_HASH}`,
  `https://drand.cloudflare.com/${DRAND_CHAIN_HASH}`,
];
const DRAND_GENESIS = 1727521075;
const DRAND_PERIOD = 3;

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

const ABI = parseAbi([
  "function currentRoundId() view returns (uint256)",
  "function rounds(uint256) view returns (uint64 startTime, uint64 endTime, uint256 totalDeposits, uint256 totalPlayers, uint8 winningCell, bool resolved, bool isBonusRound, uint64 drandRound)",
  "function resolveRound(uint256 roundId, uint256[2] signature)",
  "function skipEmptyRound(uint256 roundId)",
  "event CellPicked(uint256 indexed roundId, address indexed player, uint8 cell)",
  "event RoundResolved(uint256 indexed roundId, uint8 winningCell, uint256 winnersCount, bool isBonusRound)",
]);

const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const publicClient = createPublicClient({ chain: robinhoodChain, transport: viemHttp(RPC_URL) });
const walletClient = createWalletClient({
  account,
  chain: robinhoodChain,
  transport: viemHttp(SEQUENCER_RPC),
});

// ─── SSE feed (same event shapes the frontend already consumes) ───
const sseClients = new Set();
http
  .createServer((req, res) => {
    if (req.url !== "/events") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`event: connected\ndata: {}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  })
  .listen(PORT, () => log(`SSE feed on :${PORT}/events`));

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(frame);
}
setInterval(() => broadcast("ping", { t: Date.now() }), 15000);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── drand fetch with mirror failover ───
async function fetchBeacon(round) {
  for (;;) {
    for (const base of DRAND_MIRRORS) {
      try {
        const res = await fetch(`${base}/public/${round}`, { signal: AbortSignal.timeout(4000) });
        if (res.status === 425 || res.status === 404) break; // not emitted yet — wait, don't rotate
        if (!res.ok) continue;
        const body = await res.json();
        if (body.round !== round || !/^[0-9a-f]{128}$/.test(body.signature)) continue;
        return [BigInt("0x" + body.signature.slice(0, 64)), BigInt("0x" + body.signature.slice(64))];
      } catch {
        continue; // mirror down — try next
      }
    }
    await sleep(500);
  }
}

// ─── optional Supabase mirror ───
async function mirrorRound(row) {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/gz_rounds`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(row),
    });
  } catch (e) {
    log("supabase mirror failed:", e.message);
  }
}

// ─── live entry feed → SSE ───
publicClient.watchContractEvent({
  address: GROOD_ADDRESS,
  abi: ABI,
  eventName: "CellPicked",
  onLogs: (logs) => {
    for (const l of logs) {
      broadcast("cell_picked", {
        roundId: Number(l.args.roundId),
        player: l.args.player,
        cell: Number(l.args.cell),
      });
    }
  },
  onError: (e) => log("watch error:", e.message),
});

async function sendResolve(fn, roundId, args) {
  const hash = await walletClient.writeContract({
    address: GROOD_ADDRESS,
    abi: ABI,
    functionName: fn,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`${fn} reverted: ${hash}`);
  return hash;
}

// ─── main loop ───
log(`Grood keeper starting — contract ${GROOD_ADDRESS}, keeper ${account.address}`);
for (;;) {
  try {
    const roundId = await publicClient.readContract({
      address: GROOD_ADDRESS,
      abi: ABI,
      functionName: "currentRoundId",
    });
    const round = await publicClient.readContract({
      address: GROOD_ADDRESS,
      abi: ABI,
      functionName: "rounds",
      args: [roundId],
    });
    const [, endTime, , totalPlayers, , resolved, , drandRound] = round;

    const now = Math.floor(Date.now() / 1000);
    if (now < Number(endTime)) {
      await sleep(Math.min((Number(endTime) - now) * 1000, 5000));
      continue;
    }
    if (resolved) {
      await sleep(1000);
      continue;
    }

    if (totalPlayers === 0n) {
      const hash = await sendResolve("skipEmptyRound", roundId, [roundId]);
      log(`round ${roundId} empty — skipped (${hash})`);
      broadcast("round_resolved", { roundId: Number(roundId), skipped: true, txHash: hash });
      continue;
    }

    // Wait for the pinned beacon, fetch it, resolve
    const beaconTime = DRAND_GENESIS + (Number(drandRound) - 1) * DRAND_PERIOD;
    if (now < beaconTime) await sleep((beaconTime - now) * 1000);
    const sig = await fetchBeacon(Number(drandRound));
    const hash = await sendResolve("resolveRound", roundId, [roundId, sig]);

    const after = await publicClient.readContract({
      address: GROOD_ADDRESS,
      abi: ABI,
      functionName: "rounds",
      args: [roundId],
    });
    const payload = {
      roundId: Number(roundId),
      skipped: false,
      winningCell: Number(after[4]),
      players: Number(after[3]),
      txHash: hash,
      drandRound: Number(drandRound),
    };
    log(`round ${roundId} resolved → cell ${payload.winningCell}${after[6] ? " MOTHERLODE" : ""} (${hash})`);
    broadcast("round_resolved", payload);
    if (after[6]) broadcast("bonus_round", { roundId: Number(roundId) });
    await mirrorRound({
      round_id: Number(roundId),
      winning_cell: payload.winningCell,
      players: payload.players,
      is_bonus: after[6],
      resolve_tx_hash: hash,
      drand_round: Number(drandRound),
    });
  } catch (e) {
    log("loop error:", e.shortMessage || e.message);
    await sleep(2000);
  }
}

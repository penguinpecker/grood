"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { usePrivy, useWallets, useSendTransaction } from "@privy-io/react-auth";
import { useResolverSSE } from "./useResolverSSE";
import { createPublicClient, http, fallback, parseUnits, encodeFunctionData } from "viem";
import {
  robinhood, CHAIN_ID, RPC_URL, EXPLORER, GRID_ADDR, TOKEN_ADDR, USDG_ADDR,
  ALCHEMY_RPC, GAS_SPONSOR, SSE_URL, SUPABASE_URL, SUPABASE_ANON, DRAND_CHAIN_HASH,
} from "@/lib/config";

// ═══════════════════════════════════════════════════════════════
// GROOD CONTRACT ABI — drand-powered 5x5 grid game (Auto-Pay)
// Chain: Robinhood Chain (see lib/config.js — env-switchable to testnet)
// Entry token: USDG (Paxos Global Dollar, 6 decimals)
// Randomness: drand evmnet beacon, BLS-verified on-chain
// ═══════════════════════════════════════════════════════════════
const GRID_ABI = [
  { name: "currentRoundId", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "getCurrentRound", type: "function", stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint256" },
      { name: "startTime", type: "uint64" },
      { name: "endTime", type: "uint64" },
      { name: "totalDeposits", type: "uint256" },
      { name: "totalPlayers", type: "uint256" },
      { name: "timeRemaining", type: "uint256" },
    ] },
  { name: "rounds", type: "function", stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [
      { name: "startTime", type: "uint64" },
      { name: "endTime", type: "uint64" },
      { name: "totalDeposits", type: "uint256" },
      { name: "totalPlayers", type: "uint256" },
      { name: "winningCell", type: "uint8" },
      { name: "resolved", type: "bool" },
      { name: "isBonusRound", type: "bool" },
      { name: "drandRound", type: "uint64" },
    ] },
  { name: "playerCell", type: "function", stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }, { name: "player", type: "address" }],
    outputs: [{ name: "", type: "uint8" }] },
  { name: "pickCell", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "cell", type: "uint8" }], outputs: [] },
  { name: "entryFee", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "roundDuration", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "groodPerRound", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "hasJoined", type: "function", stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }, { name: "player", type: "address" }],
    outputs: [{ name: "", type: "bool" }] },
  { name: "getCellCounts", type: "function", stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [{ name: "counts", type: "uint256[25]" }] },
  { name: "getCellPlayers", type: "function", stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }, { name: "cell", type: "uint8" }],
    outputs: [{ name: "", type: "address[]" }] },
  { name: "protocolFeeBps", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "resolverReward", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }] },
];

const TOKEN_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
];

const USDC_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];

const USDC_ADDR = USDG_ADDR;
const CELL_COST = "1";  // 1 USDG
const CELL_COST_RAW = 1000000n; // 1 USDG in 6 decimals
const ROUND_DURATION = 60;
const GRID_SIZE = 5;
const TOTAL_CELLS = GRID_SIZE * GRID_SIZE;
const dbHeaders = { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` };

const CELL_LABELS = [];
for (let r = 0; r < GRID_SIZE; r++)
  for (let c = 0; c < GRID_SIZE; c++)
    CELL_LABELS.push(`${String.fromCharCode(65 + r)}${c + 1}`);

// Our own public client — WE control the RPC, not MetaMask
const publicClient = createPublicClient({
  chain: robinhood,
  batch: { multicall: true },
  transport: fallback([
    ...(ALCHEMY_RPC ? [http(ALCHEMY_RPC, {
      timeout: 8_000,
      retryCount: 2,
      retryDelay: 500,
    })] : []),
    http(RPC_URL, {
      timeout: 8_000,
      retryCount: 1,
      retryDelay: 1_000,
    }),
  ]),
});

const fmt = (v, d = 2) => {
  if (!v) return "0." + "0".repeat(d);
  return (Number(v) / 1e6).toFixed(d);
};
const fmtEth = (v, d = 4) => {
  if (!v) return "0." + "0".repeat(d);
  return (Number(v) / 1e18).toFixed(d);
};

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════
export default function TheGrid() {
  const { ready, authenticated, login, logout, user, exportWallet } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();

  // Contract state
  const [round, setRound] = useState(0);
  const [roundStart, setRoundStart] = useState(0);
  const [roundEnd, setRoundEnd] = useState(0);
  const [potSize, setPotSize] = useState("0");
  const [activePlayers, setActivePlayers] = useState(0);
  const [resolved, setResolved] = useState(false);
  const [winningCell, setWinningCell] = useState(-1);
  const [claimedCells, setClaimedCells] = useState(new Set());
  const [cellCounts, setCellCounts] = useState(new Array(TOTAL_CELLS).fill(0));
  const [playerCell, setPlayerCell] = useState(-1);
  const [gridBalance, setGridBalance] = useState("0");
  const [ethBalance, setEthBalance] = useState("0");
  const [usdcApproved, setUsdcApproved] = useState(false);
  const [allowanceChecked, setAllowanceChecked] = useState(false);
  const [approving, setApproving] = useState(false);

  // UI state
  const [smoothTime, setSmoothTime] = useState(0);
  const [selectedCell, setSelectedCell] = useState(null);
  const lastTapRef = useRef({ cell: -1, time: 0 });
  const [hoveredCell, setHoveredCell] = useState(-1);
  const [claiming, setClaiming] = useState(false);
  const [feed, setFeed] = useState([]);
  const [userHistory, setUserHistory] = useState([]);
  const [userHistoryLoading, setUserHistoryLoading] = useState(false);
  const userHistoryLoaded = useRef(false);
  const [scanLine, setScanLine] = useState(0);
  const [scanCell, setScanCell] = useState(-1); // slot-machine sweep during resolve
  const [error, setError] = useState(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAddr, setWithdrawAddr] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState("");
  const [withdrawSuccess, setWithdrawSuccess] = useState("");
  const [copied, setCopied] = useState(false);
  const [walletDropdown, setWalletDropdown] = useState(false); // dropdown open
  const [walletView, setWalletView] = useState("menu"); // "menu" | "withdraw"
  const walletDropdownRef = useRef(null);
  const [lastResult, setLastResult] = useState(null); // { roundId, cell, players, pot, txHash }
  const feeConfig = useRef({ feeBps: 500, resolverReward: 100000 }); // defaults, updated from chain
  const [roundHistory, setRoundHistory] = useState([]); // array of ALL loaded past results, newest first
  const [moneyFlow, setMoneyFlow] = useState(false);
  const [gridFlash, setGridFlash] = useState(false);
  const [historyPage, setHistoryPage] = useState(0); // current page (0 = newest)
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFullyLoaded, setHistoryFullyLoaded] = useState(false); // true when scanned back to round 1
  const historyCursor = useRef(0); // next round ID to scan backwards from
  const resolverTxHash = useRef(null);
  const HISTORY_PAGE_SIZE = 10;

  const animFrame = useRef(null);
  const pollRef = useRef(null);
  const lastRoundRef = useRef(0);
  const resolverCalledForRound = useRef(0);
  const resolvedRef = useRef(false);

  // ─── Refresh top of history table (picks up TX hash + drand round after resolution) ───
  const refreshHistoryTop = () => {
    fetchRoundHistory(0, HISTORY_PAGE_SIZE).then(fresh => {
      if (!fresh.length) return;
      setRoundHistory(prev => {
        const freshIds = new Set(fresh.map(r => r.roundId));
        const older = prev.filter(r => !freshIds.has(r.roundId));
        return [...fresh, ...older];
      });
    });
  };

  // ─── SSE: Real-time events from keeper ───
  const { connected: sseConnected } = useResolverSSE({
    url: SSE_URL,
    onRoundResolved: () => {
      pollState();
      // drand beacons are final at emission — one refresh picks up the TX hash
      setTimeout(refreshHistoryTop, 3000);
    },
    onCellPicked: (data) => {
      setCellCounts(prev => {
        const next = [...prev];
        next[data.cell] = (next[data.cell] || 0) + 1;
        return next;
      });
      setClaimedCells(prev => new Set([...prev, data.cell]));
    },
  });

  // ─── Read fee config once on mount ───
  useEffect(() => {
    Promise.all([
      publicClient.readContract({ address: GRID_ADDR, abi: GRID_ABI, functionName: "protocolFeeBps" }).catch(() => 500n),
      publicClient.readContract({ address: GRID_ADDR, abi: GRID_ABI, functionName: "resolverReward" }).catch(() => 100000n),
    ]).then(([bps, rr]) => {
      feeConfig.current = { feeBps: Number(bps), resolverReward: Number(rr) };
    });
  }, []);

  // ─── Lock body scroll when mobile sidebar is open ───
  useEffect(() => {
    if (mobileMenu) {
      const scrollY = window.scrollY;
      document.body.style.overflow = "hidden";
      document.body.style.position = "fixed";
      document.body.style.top = `-${scrollY}px`;
      document.body.style.left = "0";
      document.body.style.right = "0";
      document.body.style.width = "100%";
      return () => {
        document.body.style.overflow = "";
        document.body.style.position = "";
        document.body.style.top = "";
        document.body.style.left = "";
        document.body.style.right = "";
        document.body.style.width = "";
        window.scrollTo(0, scrollY);
      };
    }
  }, [mobileMenu]);

  // ─── Close wallet dropdown on click outside ───
  useEffect(() => {
    if (!walletDropdown) return;
    const handler = (e) => {
      if (walletDropdownRef.current && !walletDropdownRef.current.contains(e.target)) {
        setWalletDropdown(false);
        setWalletView("menu");
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [walletDropdown]);

  // Get the embedded wallet address
  const wallet = wallets.find((w) => w.walletClientType === "privy") || wallets[0];
  const address = wallet?.address;

  // ─── Smooth 60fps Timer ───
  useEffect(() => {
    const tick = () => {
      if (roundEnd > 0) {
        const remaining = Math.max(0, roundEnd - Date.now() / 1000);
        setSmoothTime(remaining);
      }
      animFrame.current = requestAnimationFrame(tick);
    };
    animFrame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrame.current);
  }, [roundEnd]);

  // ─── Scan Line ───
  useEffect(() => {
    const iv = setInterval(() => setScanLine((p) => (p + 1) % 100), 40);
    return () => clearInterval(iv);
  }, []);

  // ─── Resolve sweep: roulette highlight over occupied cells while the
  //     drand beacon is fetched + verified (~3s), lands when resolved ───
  const resolvingNow = roundEnd > 0 && smoothTime <= 0 && !resolved && claimedCells.size > 0;
  useEffect(() => {
    if (!resolvingNow) { setScanCell(-1); return; }
    const cells = [...claimedCells];
    let i = 0;
    const iv = setInterval(() => {
      i = (i + 1) % cells.length;
      setScanCell(cells[i]);
    }, 110);
    return () => clearInterval(iv);
  }, [resolvingNow, claimedCells]);

  // ─── Poll Contract (uses OUR public client, not wallet) ───
  const pollError = useRef(null);
  const pollCount = useRef(0);
  const pollBusy = useRef(false);
  const pollState = useCallback(async () => {
    if (pollBusy.current) return; // skip if previous poll still running
    pollBusy.current = true;
    pollCount.current++;
    try {
      // 1. Get current round (CRITICAL - everything depends on this)
      let roundId;
      try {
        roundId = await publicClient.readContract({
          address: GRID_ADDR, abi: GRID_ABI, functionName: "currentRoundId",
        });
      } catch (e) {
        pollError.current = "RPC: currentRoundId failed - " + (e.shortMessage || e.message || "unknown");
        console.error("Poll: currentRoundId failed", e);
        return;
      }
      const rNum = Number(roundId);
      setRound(rNum);
      pollError.current = null;

      // 2. Fire ALL reads in parallel (viem multicall batches these into ~1 RPC call)
      const promises = [
        publicClient.readContract({
          address: GRID_ADDR, abi: GRID_ABI, functionName: "rounds", args: [roundId],
        }).catch(() => null),
        publicClient.readContract({
          address: GRID_ADDR, abi: GRID_ABI, functionName: "getCellCounts", args: [roundId],
        }).catch(() => null),
      ];

      // Player-specific calls (only if wallet connected)
      if (address) {
        promises.push(
          publicClient.readContract({
            address: GRID_ADDR, abi: GRID_ABI, functionName: "hasJoined", args: [roundId, address],
          }).catch(() => null),
          publicClient.readContract({
            address: TOKEN_ADDR, abi: TOKEN_ABI, functionName: "balanceOf", args: [address],
          }).catch(() => null),
          publicClient.readContract({
            address: USDC_ADDR, abi: USDC_ABI, functionName: "balanceOf", args: [address],
          }).catch(() => null),
          publicClient.readContract({
            address: USDC_ADDR, abi: USDC_ABI, functionName: "allowance", args: [address, GRID_ADDR],
          }).catch(() => null),
        );
      }

      const results = await Promise.all(promises);
      const [rd, counts] = results;

      // Process round data
      if (rd) {
        setRoundStart(Number(rd[0]));
        setRoundEnd(Number(rd[1]));
        setPotSize(rd[2].toString());
        setActivePlayers(Number(rd[3]));
        const isResolved = rd[5];
        setResolved(isResolved);
        resolvedRef.current = isResolved;
        if (isResolved && Number(rd[4]) >= 0) {
          setWinningCell(Number(rd[4]));
        } else if (!isResolved) {
          setWinningCell(-1);
        }
      }

      // Process cell counts
      if (counts) {
        const claimed = new Set();
        const countsArr = new Array(TOTAL_CELLS).fill(0);
        for (let i = 0; i < TOTAL_CELLS; i++) {
          const count = Number(counts[i]);
          countsArr[i] = count;
          if (count > 0) claimed.add(i);
        }
        setClaimedCells(claimed);
        setCellCounts(countsArr);
      }

      // Process player data
      if (address) {
        const [, , joined, gridBal, usdcBal, allowance] = results;

        if (joined === true) {
          try {
            const pc = await publicClient.readContract({
              address: GRID_ADDR, abi: GRID_ABI, functionName: "playerCell", args: [roundId, address],
            });
            setPlayerCell(Number(pc) - 1);
          } catch (e) { console.error("Poll: playerCell failed", e); }
        } else if (joined === false) {
          setPlayerCell(-1);
        }

        if (gridBal != null) setGridBalance(gridBal.toString());
        if (usdcBal != null) setEthBalance(usdcBal.toString());
        if (allowance != null) {
          setUsdcApproved(allowance >= CELL_COST_RAW);
          if (!allowanceChecked) setAllowanceChecked(true);
        }
      }
    } catch (e) {
      pollError.current = "Poll error: " + (e.shortMessage || e.message || "unknown");
      console.error("Poll error:", e);
    } finally {
      pollBusy.current = false;
    }
  }, [address, roundEnd]);

  useEffect(() => {
    pollState();
    const tick = () => {
      pollState();
      // Fast poll (500ms) while waiting for resolution, normal (3s) otherwise
      // When SSE connected, slow to 10s as safety net
      const resolving = roundEnd > 0 && Date.now() / 1000 > roundEnd && !resolvedRef.current;
      const interval = sseConnected ? 10000 : (resolving ? 500 : 3000);
      pollRef.current = setTimeout(tick, interval);
    };
    pollRef.current = setTimeout(tick, 3000);
    return () => { clearTimeout(pollRef.current); };
  }, [pollState, sseConnected]);

  // ─── Load round history from Supabase ───
  const historyLoaded = useRef(false);
  const historyLoadingRef = useRef(false);
  const historyFullyLoadedRef = useRef(false);
  const historyOffset = useRef(0);
  const historyTotal = useRef(0);

  const fetchRoundHistory = async (offset, limit = HISTORY_PAGE_SIZE) => {
    if (!SUPABASE_URL) return [];
    if (historyLoadingRef.current) return [];
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/gz_rounds?select=round_id,winning_cell,total_players,total_deposits,resolve_tx_hash,drand_round&total_players=gt.0&resolve_tx_hash=not.is.null&order=round_id.desc&limit=${limit}&offset=${offset}`,
        { headers: { ...dbHeaders, Prefer: "count=exact" } }
      );
      const total = parseInt(r.headers.get("content-range")?.split("/")[1] || "0", 10);
      historyTotal.current = total;
      const data = await r.json();
      const results = (data || []).map(r => ({
        roundId: r.round_id,
        cell: r.winning_cell,
        players: r.total_players,
        pot: r.total_deposits,
        resolved: true,
        txHash: r.resolve_tx_hash,
        drandRound: r.drand_round || null,
      }));
      historyOffset.current = offset + results.length;
      if (historyOffset.current >= historyTotal.current) {
        historyFullyLoadedRef.current = true;
        setHistoryFullyLoaded(true);
      }
      return results;
    } catch (e) {
      console.error("History fetch error:", e);
      return [];
    } finally {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    if (!historyLoaded.current) {
      historyLoaded.current = true;
      fetchRoundHistory(0, HISTORY_PAGE_SIZE).then(results => {
        if (results.length > 0) setRoundHistory(results);
      });
    }
  }, []);

  // Load older pages on demand
  const loadOlderHistory = () => {
    if (historyLoadingRef.current || historyFullyLoadedRef.current) return;
    fetchRoundHistory(historyOffset.current, HISTORY_PAGE_SIZE).then(results => {
      if (results.length > 0) {
        setRoundHistory(prev => {
          const existingIds = new Set(prev.map(r => r.roundId));
          const newOnes = results.filter(r => !existingIds.has(r.roundId));
          return [...prev, ...newOnes];
        });
      }
    });
  };

  // ─── User History from Supabase ───
  const userHistoryOffset = useRef(0);
  const userHistoryTotal = useRef(0);

  const fetchUserHistory = async (offset, limit = 10) => {
    if (!address || !SUPABASE_URL) return [];
    try {
      const addr = address.toLowerCase();
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/gz_round_players?select=round_id,player_address,cell_picked,is_winner,pick_tx_hash,claimed,claim_tx_hash,gz_rounds!inner(winning_cell,total_players,total_deposits,resolve_tx_hash)&player_address=eq.${addr}&order=round_id.desc&limit=${limit}&offset=${offset}`,
        { headers: { ...dbHeaders, Prefer: "count=exact" } }
      );
      const total = parseInt(r.headers.get("content-range")?.split("/")[1] || "0", 10);
      userHistoryTotal.current = total;
      const data = await r.json();

      // Count winners per round for accurate per-player payout
      const wonRoundIds = (data || []).filter(h => h.is_winner).map(h => h.round_id);
      let winnersMap = {};
      if (wonRoundIds.length > 0) {
        try {
          const wr = await fetch(
            `${SUPABASE_URL}/rest/v1/gz_round_players?select=round_id&is_winner=eq.true&round_id=in.(${wonRoundIds.join(",")})`,
            { headers: dbHeaders }
          );
          const wData = await wr.json();
          for (const w of (wData || [])) winnersMap[w.round_id] = (winnersMap[w.round_id] || 0) + 1;
        } catch {}
      }

      return (data || []).map(h => ({
        roundId: h.round_id,
        cell: h.cell_picked,
        won: h.is_winner,
        resolved: true,
        pot: h.gz_rounds?.total_deposits || "0",
        players: h.gz_rounds?.total_players || "—",
        numWinners: winnersMap[h.round_id] || 1,
        cost: "1000000", // 1 USDG
      }));
    } catch (e) {
      console.error("User history fetch error:", e);
      return [];
    }
  };

  useEffect(() => {
    if (address && !userHistoryLoaded.current) {
      userHistoryLoaded.current = true;
      userHistoryOffset.current = 0;
      setUserHistoryLoading(true);
      fetchUserHistory(0, 10).then(results => {
        setUserHistory(results);
        userHistoryOffset.current = results.length;
        setUserHistoryLoading(false);
      });
    }
  }, [address]);

  // Refresh user history when round changes (new resolved round might include user)
  useEffect(() => {
    if (round > 1 && address && userHistoryLoaded.current) {
      // Re-fetch latest to pick up new entries
      fetchUserHistory(0, 10).then(results => {
        if (results.length > 0) {
          setUserHistory(prev => {
            const merged = [...results];
            const newIds = new Set(results.map(r => r.roundId));
            for (const old of prev) {
              if (!newIds.has(old.roundId)) merged.push(old);
            }
            return merged.sort((a, b) => b.roundId - a.roundId);
          });
          userHistoryOffset.current = Math.max(userHistoryOffset.current, results.length);
        }
      });
    }
  }, [round]);

  // ─── Round Change — fetch previous round data, save to history, reset grid ───
  useEffect(() => {
    if (round > 0 && round !== lastRoundRef.current) {
      const prevRound = lastRoundRef.current;

      // Fetch previous round data from contract (don't rely on stale state)
      if (prevRound > 0) {
        publicClient.readContract({
          address: GRID_ADDR, abi: GRID_ABI, functionName: "rounds", args: [BigInt(prevRound)],
        }).then(rd => {
          const players = Number(rd[3]);   // [3] = totalPlayers
          const cell = Number(rd[4]);     // [4] = winningCell
          const pot = rd[2].toString();
          const isResolved = rd[5]; // V3: bool
          if (players > 0) {
            const result = {
              roundId: prevRound,
              cell,
              players,
              pot,
              resolved: isResolved,
              txHash: resolverTxHash.current || null,
            };
            setLastResult(result);
            setRoundHistory(prev => {
              if (prev.some(r => r.roundId === prevRound)) return prev;
              return [result, ...prev];
            });
            if (isResolved && players > 0) { // V3: cell 0 is valid
              addFeed(`★ Round ${prevRound} winner: Cell ${CELL_LABELS[cell] || cell}`);
              setMoneyFlow(true);
              setTimeout(() => setMoneyFlow(false), 2500);
            } else if (players > 0 && !isResolved) {
              addFeed(`⚠ Round ${prevRound} had ${players} player(s) but wasn't resolved`);
            }
            setHistoryPage(0);
          }
          resolverTxHash.current = null;
        }).catch(e => console.error("Failed to fetch prev round:", e));
      }

      // Flash grid on reset
      setGridFlash(true);
      setTimeout(() => setGridFlash(false), 600);
      addFeed(`◆ Round ${round} started`);
      lastRoundRef.current = round;
      setSelectedCell(null);
      setPlayerCell(-1);
      setClaimedCells(new Set());
      setCellCounts(new Array(TOTAL_CELLS).fill(0));
      setWinningCell(-1);
      setResolved(false);
      resolvedRef.current = false;
    }
  }, [round]);

  // ─── Winner detected — trigger animation + update history entry ───
  useEffect(() => {
    if (resolved && winningCell >= 0 && round > 0) {
      const result = {
        roundId: round,
        cell: winningCell,
        players: activePlayers,
        pot: potSize,
        resolved: true,
        txHash: resolverTxHash.current || null,
      };
      setLastResult(result);
      setMoneyFlow(true);
      setTimeout(() => setMoneyFlow(false), 2500);
      // Upsert: update existing entry or prepend new one
      setRoundHistory(prev => {
        const idx = prev.findIndex(r => r.roundId === round);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = result;
          return updated;
        }
        return [result, ...prev];
      });
      setHistoryPage(0);
    }
  }, [resolved, winningCell]);

  // ─── One-Time USDG Approval ───
  const approveUsdc = async () => {
    if (!wallet || approving) return;
    setApproving(true);
    setError(null);
    try {
      const isEmbedded = wallet?.walletClientType === "privy";
      const approvalAmt = isEmbedded ? "100" : "1000000";
      addFeed(`Approving ${isEmbedded ? "100" : "1,000,000"} USDG...`);
      const approveData = encodeFunctionData({
        abi: USDC_ABI, functionName: "approve",
        args: [GRID_ADDR, parseUnits(approvalAmt, 6)],
      });
      const receipt = await sendTransaction(
        { to: USDC_ADDR, data: approveData, chainId: CHAIN_ID },
        { sponsor: GAS_SPONSOR }
      );
      await publicClient.waitForTransactionReceipt({ hash: receipt.hash });
      setUsdcApproved(true);
      addFeed(`USDG approved ✓ — double-tap any cell to play!`);
    } catch (e) {
      const msg = e.shortMessage || e.message || "Approval failed";
      setError(msg);
      addFeed(`✗ Approval failed: ${msg.slice(0, 80)}`);
    }
    setApproving(false);
  };

  // ─── Pick Cell (via Privy embedded wallet) — direct pickCell, approval already done ───
  const claimCell = async (cellIndex) => {
    if (!wallet || claiming) return;
    setClaiming(true);
    setError(null);

    try {
      // Encode the pickCell call
      const data = encodeFunctionData({
        abi: GRID_ABI,
        functionName: "pickCell",
        args: [cellIndex],
      });

      // Send sponsored tx via Privy
      const receipt = await sendTransaction(
        { to: GRID_ADDR, data, chainId: CHAIN_ID },
        { sponsor: GAS_SPONSOR }
      );

      addFeed(`◈ Claiming cell ${CELL_LABELS[cellIndex]}...`);
      await publicClient.waitForTransactionReceipt({ hash: receipt.hash });
      addFeed(`✓ Cell ${CELL_LABELS[cellIndex]} claimed!`);
      setPlayerCell(cellIndex);
      setSelectedCell(null);
      pollState();
    } catch (e) {
      const msg = e.shortMessage || e.message || "Transaction failed";
      setError(msg);
      addFeed(`✗ Failed: ${msg.slice(0, 80)}`);
    }
    setClaiming(false);
  };

  const addFeed = (msg) => {
    setFeed((prev) => [{ msg, time: Date.now() }, ...prev].slice(0, 20));
  };

  // ─── Copy Wallet Address ───
  const copyAddress = () => {
    if (address) {
      navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // ─── Withdraw USDG ───
  const withdrawETH = async () => {
    if (!wallet || !withdrawAddr || !withdrawAmt || withdrawing) return;
    setWithdrawError("");
    setWithdrawSuccess("");
    // Validate address: must be 0x + 40 hex chars
    if (!/^0x[0-9a-fA-F]{40}$/.test(withdrawAddr.trim())) {
      setWithdrawError("Invalid address — must be a valid 0x Ethereum address");
      return;
    }
    const amt = parseFloat(withdrawAmt);
    if (isNaN(amt) || amt <= 0) {
      setWithdrawError("Invalid amount");
      return;
    }
    setWithdrawing(true);
    try {
      // ERC20 transfer for USDG
      const transferData = encodeFunctionData({
        abi: [{ name: "transfer", type: "function", stateMutability: "nonpayable",
          inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
          outputs: [{ type: "bool" }] }],
        functionName: "transfer",
        args: [withdrawAddr.trim(), parseUnits(withdrawAmt, 6)],
      });
      const receipt = await sendTransaction(
        { to: USDC_ADDR, data: transferData, chainId: CHAIN_ID },
        { sponsor: GAS_SPONSOR }
      );
      addFeed(`↗ Withdrawing ${withdrawAmt} USDG...`);
      await publicClient.waitForTransactionReceipt({ hash: receipt.hash });
      addFeed(`✓ Withdrawn ${withdrawAmt} USDG`);
      setWithdrawSuccess(`✓ Sent ${withdrawAmt} USDG · ${receipt.hash.slice(0,10)}...${receipt.hash.slice(-6)}`);
      setWithdrawAddr("");
      setWithdrawAmt("");
      pollState();
    } catch (e) {
      const msg = e.shortMessage || e.message || "Withdraw failed";
      setWithdrawError(msg.slice(0, 100));
      addFeed(`✗ Withdraw failed: ${msg.slice(0, 80)}`);
    }
    setWithdrawing(false);
  };

  // ─── Derived UI State ───
  const actualDuration = (roundEnd > 0 && roundStart > 0) ? (roundEnd - roundStart) : ROUND_DURATION;
  const timerProgress = actualDuration > 0 ? smoothTime / actualDuration : 0;
  const timerColor = smoothTime > 10 ? "#00C805" : smoothTime > 5 ? "#40D644" : "#FF5000";

  const getStatus = () => {
    if (round === 0) return "INITIALIZING...";
    if (resolved) return `ROUND ${round} RESOLVED`;
    if (smoothTime <= 0) return `RESOLVING ROUND ${round}...`;
    if (!ready || !authenticated) return `ROUND ${round} — LOGIN TO PLAY`;
    return `ROUND ${round} ACTIVE`;
  };

  const getCellState = (idx) => {
    if (resolved && winningCell === idx) return "winner";
    if (playerCell === idx) return "yours";
    if (claimedCells.has(idx)) return "claimed";
    return "empty";
  };

  const canClaim = (idx) => {
    return !resolved && smoothTime > 0 && authenticated && playerCell < 0 && usdcApproved;
  };

  // Expected payout (raw 6-dec) for a cell if it wins — after fee + tip,
  // split among everyone on the cell (including your prospective entry)
  const payoutFor = (idx) => {
    if (idx == null || idx < 0) return null;
    const { feeBps, resolverReward } = feeConfig.current;
    const joined = playerCell >= 0;
    const pool = Number(potSize || 0) + (joined ? 0 : Number(CELL_COST_RAW));
    const fee = Math.floor((pool * feeBps) / 10000);
    const dist = Math.max(pool - fee - resolverReward, 0);
    const winners = (cellCounts[idx] || 0) + (!joined ? 1 : 0);
    return winners > 0 ? Math.floor(dist / winners) : dist;
  };

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════
  return (
    <div style={S.root}>
      {/* ─── HEADER ─── */}
      <header style={{...S.header, display:"flex", justifyContent:"space-between", alignItems:"center", padding:"0 12px", gap:4}} className="grid-header">
        {/* Left — logo, clickable */}
        <div style={{...S.hLeft, cursor:"pointer", flexShrink:0}} onClick={()=>window.location.href="/"}>
          <LogoIcon size={22} />
          <span style={S.logo} className="grid-logo-text">GR<span style={{fontWeight:500,color:"#e0f0e8"}}>OOD</span></span>
          <div style={{width:5,height:5,borderRadius:"50%",background:"#00C805",boxShadow:"0 0 6px #00C805",animation:"pulse 2s ease-in-out infinite",marginLeft:3,flexShrink:0}}/>
        </div>
        {/* Center — nav, hidden on mobile */}
        <nav className="grid-header-nav" style={{display:"flex",alignItems:"center",gap:2,flexShrink:0}}>
          <button onClick={()=>window.location.href="/"} className="nav-btn-home" style={{background:"transparent",border:"none",fontFamily:"'Orbitron',sans-serif",fontSize:10,fontWeight:700,color:"#4a6e5a",cursor:"pointer",letterSpacing:1.5,padding:"6px 10px",borderRadius:3,transition:"color 0.2s"}}>HOME</button>
          <button className="nav-btn-play" style={{background:"transparent",border:"none",fontFamily:"'Orbitron',sans-serif",fontSize:10,fontWeight:700,color:"#00C805",cursor:"default",letterSpacing:1.5,padding:"6px 10px",borderRadius:3,animation:"navGlow 3s ease-in-out infinite"}}>PLAY</button>
        </nav>
        {/* Right — balances + wallet */}
        <div style={{...S.hRight, gap:6, justifyContent:"flex-end", flexShrink:0}}>
          {authenticated && (
            <>
              <span style={S.hStat} className="grid-header-stat">
                ● {fmtEth(gridBalance, 2)} <b style={{ color: "#009B04" }}>GROOD</b>
              </span>
              <span style={S.hStat} className="grid-header-stat">
                ◆ {fmt(ethBalance, 2)} <b style={{ color: "#00C805" }}>USDG</b>
              </span>
            </>
          )}
          {/* Mobile: show balances inline */}
          {authenticated && (
            <span className="grid-mobile-balances" style={{
              display: "none", alignItems: "center", gap: 8,
              fontSize: 11, letterSpacing: 0.5,
            }}>
              <span style={{ color: "#00C805" }}>{fmt(ethBalance, 2)} <b>USDG</b></span>
              <span style={{ color: "#4a6e5a" }}>|</span>
              <span style={{ color: "#009B04" }}>{fmtEth(gridBalance, 2)} <b>GROOD</b></span>
            </span>
          )}
          {!authenticated ? (
            <button style={S.loginBtn} onClick={login}>⚡ LOGIN</button>
          ) : (
            <div ref={walletDropdownRef} style={{ position: "relative" }} className="grid-header-wallet-btn">
              <button style={{
                ...S.loginBtn,
                display: "flex", alignItems: "center", gap: 6,
              }} onClick={() => { setWalletDropdown(!walletDropdown); setWalletView("menu"); }}>
                {/* Desktop: just address */}
                <span className="wallet-addr-desktop">
                  {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "WALLET"}
                </span>
                {/* Mobile: balances + short address */}
                <span className="wallet-addr-mobile" style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "nowrap" }}>
                  <span style={{ fontSize: 10, color: "#00C805", fontWeight: 700 }}>{fmt(ethBalance, 2)}<span style={{ fontSize: 9, opacity: 0.7 }}> U</span></span>
                  <span style={{ color: "#2a4e3a", fontSize: 9 }}>|</span>
                  <span style={{ fontSize: 10, color: "#009B04", fontWeight: 700 }}>{fmtEth(gridBalance, 0)}<span style={{ fontSize: 9, opacity: 0.7 }}> G</span></span>
                  <span style={{ color: "#2a4e3a", fontSize: 9 }}>·</span>
                  <span style={{ fontSize: 9 }}>{address ? `${address.slice(0, 4)}…${address.slice(-3)}` : "W"}</span>
                </span>
                <span style={{ fontSize: 8, opacity: 0.6, transition: "transform 0.2s", transform: walletDropdown ? "rotate(180deg)" : "none" }}>▼</span>
              </button>
              {walletDropdown && walletView === "menu" && (
                <div className="grid-wallet-dropdown" style={{
                  position: "absolute", top: "calc(100% + 6px)", right: 0,
                  width: 280, background: "#0C2012",
                  border: "1px solid rgba(0,155,4,0.25)", borderRadius: 8,
                  overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
                  zIndex: 9999, animation: "dropIn 0.15s ease-out",
                }}>
                  <button onClick={() => { copyAddress(); setWalletDropdown(false); }} style={S.dropdownItem}>
                    <span style={S.dropdownIcon}>📋</span> {copied ? "Copied!" : "Copy Address"}
                  </button>
                  <div style={S.dropdownDivider} />
                  <button onClick={() => { exportWallet(); setWalletDropdown(false); }} style={S.dropdownItem}>
                    <span style={S.dropdownIcon}>🔑</span> Export Key
                  </button>
                  <div style={S.dropdownDivider} />
                  <button onClick={() => setWalletView("withdraw")} style={S.dropdownItem}>
                    <span style={S.dropdownIcon}>↗</span> Withdraw
                  </button>
                  <div style={S.dropdownDivider} />
                  <button onClick={() => { logout(); setWalletDropdown(false); }} style={{ ...S.dropdownItem, color: "#FF5000" }}>
                    <span style={S.dropdownIcon}>⏻</span> Logout
                  </button>
                  {/* User History inside dropdown */}
                  {userHistory.length > 0 && (
                    <div style={{ borderTop: "1px solid rgba(0,155,4,0.1)", padding: "10px 14px 4px" }}>
                      <div style={{ fontSize: 9, letterSpacing: 2, color: "#00C805", fontWeight: 700, marginBottom: 8 }}>YOUR HISTORY</div>
                      <div style={{ maxHeight: 200, overflowY: "auto" }}>
                        {userHistory.map((h, i) => {
                          const isWin = h.won;
                          const potRaw = Number(h.pot || 0);
                          const { feeBps: fb, resolverReward: rr } = feeConfig.current;
                          const distributable = Math.max(potRaw - Math.floor(potRaw * fb / 10000) - rr, 0);
                          const perWinner = distributable / (h.numWinners || 1);
                          const displayAmt = isWin ? (perWinner / 1e6) : 1;
                          return (
                            <div key={h.roundId} style={{
                              display: "grid", gridTemplateColumns: "36px 58px 26px 1fr",
                              alignItems: "center", padding: "5px 0", gap: 6,
                              borderBottom: i < userHistory.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none",
                              fontSize: 11,
                            }}>
                              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1, padding: "2px 4px", borderRadius: 3, textAlign: "center", background: isWin ? "rgba(0,200,5,0.12)" : "rgba(255,80,0,0.1)", color: isWin ? "#00C805" : "#FF5000" }}>
                                {isWin ? "WON" : "LOST"}
                              </span>
                              <span style={{ color: "#6a8e7b", fontSize: 10 }}>R#{h.roundId}</span>
                              <span style={{ color: "#4a6e5a", fontSize: 10 }}>{CELL_LABELS[h.cell] || "?"}</span>
                              <span style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 10, fontWeight: 600, color: isWin ? "#00C805" : "#FF5000", textAlign: "right" }}>
                                {isWin ? "+" : "-"}{displayAmt.toFixed(2)} USDG
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      {userHistoryOffset.current < userHistoryTotal.current && (
                        <button
                          onClick={() => {
                            setUserHistoryLoading(true);
                            fetchUserHistory(userHistoryOffset.current, 10).then(results => {
                              setUserHistory(prev => {
                                const ids = new Set(prev.map(h => h.roundId));
                                return [...prev, ...results.filter(r => !ids.has(r.roundId))];
                              });
                              userHistoryOffset.current += results.length;
                              setUserHistoryLoading(false);
                            });
                          }}
                          style={{ width: "100%", padding: "7px 0", marginTop: 6, background: "none", border: "1px solid rgba(0,155,4,0.15)", borderRadius: 4, color: "#00C805", fontSize: 10, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, letterSpacing: 1, cursor: "pointer" }}
                        >
                          {userHistoryLoading ? "SCANNING..." : "LOAD MORE"}
                        </button>
                      )}
                    </div>
                  )}
                  {!authenticated && userHistory.length === 0 && userHistoryLoading && (
                    <div style={{ padding: "8px 14px", fontSize: 10, color: "#4a6e5a" }}>Scanning rounds...</div>
                  )}
                </div>
              )}
              {walletDropdown && walletView === "withdraw" && (
                <div className="grid-wallet-dropdown" style={{
                  position: "absolute", top: "calc(100% + 6px)", right: 0,
                  width: 300, background: "#0C2012",
                  border: "1px solid rgba(0,155,4,0.25)", borderRadius: 8,
                  overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
                  zIndex: 9999, animation: "dropIn 0.15s ease-out",
                }}>
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "12px 14px", borderBottom: "1px solid rgba(0,155,4,0.12)",
                    background: "rgba(0,155,4,0.04)",
                  }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#00C805", letterSpacing: 1.5 }}>↗ WITHDRAW USDG</span>
                    <button onClick={() => { setWalletView("menu"); setWithdrawError(""); setWithdrawSuccess(""); }} style={{
                      fontSize: 10, color: "#6a8e7b", cursor: "pointer", background: "none",
                      border: "1px solid rgba(255,255,255,0.1)", padding: "4px 10px", borderRadius: 4,
                      fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5,
                    }}>◀ BACK</button>
                  </div>
                  <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, padding: "0 2px" }}>
                      <span style={{ color: "#4a6e5a" }}>Available</span>
                      <span style={{ color: "#00C805", fontWeight: 600, cursor: "pointer" }} onClick={() => setWithdrawAmt(fmt(ethBalance, 6))}>{fmt(ethBalance)} USDG (MAX)</span>
                    </div>
                    <input
                      placeholder="Destination address (0x...)"
                      value={withdrawAddr}
                      onChange={(e) => { setWithdrawAddr(e.target.value); setWithdrawError(""); setWithdrawSuccess(""); }}
                      style={{ ...S.dropdownInput, borderColor: withdrawError ? "rgba(255,80,0,0.4)" : "rgba(0,155,4,0.15)" }}
                    />
                    <input
                      placeholder="Amount in USDG"
                      value={withdrawAmt}
                      onChange={(e) => { setWithdrawAmt(e.target.value); setWithdrawError(""); setWithdrawSuccess(""); }}
                      style={S.dropdownInput}
                    />
                    {withdrawError && (
                      <div style={{ fontSize: 10, color: "#FF5000", padding: "4px 2px", lineHeight: 1.4 }}>
                        ⚠ {withdrawError}
                      </div>
                    )}
                    {withdrawSuccess && (
                      <div style={{ fontSize: 10, color: "#00C805", padding: "4px 2px", lineHeight: 1.4, fontWeight: 600 }}>
                        {withdrawSuccess}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                      <button
                        style={{ ...S.claimBtn, flex: 1, fontSize: 11, padding: "10px", opacity: withdrawing ? 0.6 : 1 }}
                        onClick={withdrawETH}
                        disabled={withdrawing}
                      >
                        {withdrawing ? "SENDING..." : "SEND"}
                      </button>
                      <button
                        style={{ ...S.claimBtn, fontSize: 11, padding: "10px 16px", borderColor: "#4a6e5a", color: "#6a8e7b", background: "none" }}
                        onClick={() => { setWalletDropdown(false); setWalletView("menu"); setWithdrawAddr(""); setWithdrawAmt(""); setWithdrawError(""); setWithdrawSuccess(""); }}
                      >
                        CANCEL
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </header>

      {/* ─── MAIN ─── */}
      <div style={S.main} className="grid-main">

        {/* ─── GRID AREA ─── */}
        <div style={S.gridArea} className="grid-game-area">
          {/* Mobile stat strip (desktop shows the rail instead) */}
          <div className="grid-mobile-stats" style={S.mobileStats}>
            <div style={S.mobileStatCell}><span style={S.statLabel}>TIME</span><span style={{ ...S.mobileStatValue, color: timerColor }}>{Math.floor(smoothTime)}s</span></div>
            <div style={S.mobileStatCell}><span style={S.statLabel}>POT</span><span style={{ ...S.mobileStatValue, color: "#00C805" }}>{fmt(potSize)}</span></div>
            <div style={S.mobileStatCell}><span style={S.statLabel}>PLAYERS</span><span style={S.mobileStatValue}>{activePlayers}</span></div>
            <div style={S.mobileStatCell}><span style={S.statLabel}>YOURS</span><span style={S.mobileStatValue}>{playerCell >= 0 ? CELL_LABELS[playerCell] : "—"}</span></div>
          </div>

          {/* Slim round progress */}
          <div style={S.timerWrap}>
            <div style={S.timerBarBg}>
              <div style={{
                ...S.timerBarFill,
                width: `${timerProgress * 100}%`,
                backgroundColor: timerColor,
              }} />
            </div>
          </div>

          {/* Grid */}
          <div style={S.gridOuter}>
            <div style={S.cornerTL} /><div style={S.cornerTR} />
            <div style={S.cornerBL} /><div style={S.cornerBR} />

            {/* Grid flash on new round */}
            {gridFlash && (
              <div style={{
                position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                borderRadius: 8, zIndex: 15, pointerEvents: "none",
                animation: "gridResetFlash 0.6s ease-out forwards",
              }} />
            )}

            {/* ─── Resolution overlay: full blur only when nobody played;
                 with picks on the board, the roulette sweep IS the show ─── */}
            {smoothTime <= 0 && round > 0 && !resolved && claimedCells.size === 0 && (
              <div style={{
                position: "absolute", inset: 0, borderRadius: 8, zIndex: 20,
                display: "flex", alignItems: "center", justifyContent: "center",
                backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)",
                background: "rgba(6,20,10,0.75)",
                animation: "fadeIn 0.15s ease-out",
              }}>
                <div style={{ position: "relative", width: 56, height: 56 }}>
                  <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "2px solid transparent", borderTopColor: "#009B04", borderRightColor: "#009B04", animation: "spin 0.9s linear infinite" }} />
                  <div style={{ position: "absolute", inset: 7, borderRadius: "50%", border: "2px solid transparent", borderBottomColor: "#00C805", borderLeftColor: "#00C805", animation: "spinR 0.65s linear infinite" }} />
                  <div style={{ position: "absolute", inset: 14, borderRadius: "50%", border: "2px solid transparent", borderTopColor: "#00C805", animation: "spin 1.3s linear infinite" }} />
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: "#00C805", animation: "pulse 1.2s ease-in-out infinite" }}>⬡</div>
                </div>
              </div>
            )}

            <div style={S.grid}>
              {CELL_LABELS.map((label, idx) => {
                const state = getCellState(idx);
                const isSelected = selectedCell === idx;
                const isWinnerCell = resolved && winningCell === idx;
                const count = cellCounts[idx] || 0;
                return (
                  <button
                    key={idx}
                    style={{
                      ...S.cell,
                      ...(state === "claimed" ? S.cellClaimed : {}),
                      ...(state === "yours" ? S.cellYours : {}),
                      ...(hoveredCell === idx && !isSelected && state !== "winner" && state !== "yours" ? S.cellHover : {}),
                      ...(isSelected ? S.cellSelected : {}),
                      ...(state === "winner" ? S.cellWinner : {}),
                      ...(scanCell === idx && !resolved ? S.cellScanSweep : {}),
                      transition: "all 0.12s ease",
                      animationDelay: isWinnerCell ? "0s" : `${Math.floor(idx / GRID_SIZE) * 0.05}s`,
                    }}
                    onMouseEnter={() => setHoveredCell(idx)}
                    onMouseLeave={() => setHoveredCell(-1)}
                    onClick={() => {
                      if (!canClaim(idx)) return;
                      const now = Date.now();
                      const last = lastTapRef.current;
                      if (last.cell === idx && now - last.time < 400 && !claiming) {
                        // Double-tap/click — claim directly
                        claimCell(idx);
                        lastTapRef.current = { cell: -1, time: 0 };
                      } else {
                        // First tap — select
                        setSelectedCell(idx);
                        lastTapRef.current = { cell: idx, time: now };
                      }
                    }}
                    onDoubleClick={() => { if (canClaim(idx) && !claiming) claimCell(idx); }}
                  >
                    <span style={S.cellLabel}>{label}</span>
                    {count > 0 && state !== "winner" && state !== "yours" && (
                      <span style={S.cellCount}>{count}</span>
                    )}
                    <span style={S.cellCenter}>
                      {state === "winner" ? (
                        <span style={{ fontSize: 26, animation: "winnerPop 0.6s ease-out" }}>★</span>
                      ) : state === "yours" ? (
                        <span style={S.cellYouTag}>YOU{count > 1 ? ` +${count - 1}` : ""}</span>
                      ) : count > 0 ? (
                        <span style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 17, fontWeight: 700, color: "#d0e8dc" }}>{count}</span>
                      ) : (
                        <span style={{ fontSize: 11, opacity: 0.15 }}>◇</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Status */}
          <div style={S.statusBar}>
            <span style={{ fontWeight: 600 }}>{getStatus()}</span>
            <span className="grid-tap-hint" style={{ color: "#7a9e8b", fontSize: 10 }}>TAP TO SELECT · DOUBLE-TAP TO ENTER</span>
          </div>

          {/* Mobile betting controls (desktop uses the side rail) */}
          <div className="grid-mobile-controls" style={{ width: "100%", maxWidth: 620 }}>
            {authenticated && allowanceChecked && !usdcApproved && !approving && (
              <button style={{ ...S.claimBtn, marginTop: 12, background: "linear-gradient(135deg, #00C805, #009B04)" }} onClick={approveUsdc}>
                APPROVE USDG TO PLAY
              </button>
            )}
            {approving && (
              <div style={{ ...S.claimingBar, marginTop: 12 }}><div style={S.claimingDot} />APPROVING USDG...</div>
            )}
            {selectedCell !== null && !claiming && authenticated && usdcApproved && playerCell < 0 && (
              <button style={{ ...S.claimBtn, marginTop: 12 }} onClick={() => claimCell(selectedCell)}>
                ENTER {CELL_LABELS[selectedCell]} — {CELL_COST} USDG{payoutFor(selectedCell) != null ? ` · WIN ${fmt(payoutFor(selectedCell))}` : ""}
              </button>
            )}
            {claiming && (
              <div style={{ ...S.claimingBar, marginTop: 12 }}><div style={S.claimingDot} />CONFIRMING TX...</div>
            )}
          </div>

          {/* ─── MOBILE USER HISTORY (hidden on desktop, shown on mobile) ─── */}
          {authenticated && userHistory.length > 0 && (
            <div className="grid-mobile-user-history" style={{
              width: "100%", maxWidth: 520, marginTop: 14,
              borderRadius: 10,
              border: "1px solid rgba(0,155,4,0.2)",
              background: "rgba(0,155,4,0.03)",
              overflow: "hidden",
            }}>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "10px 16px",
                borderBottom: "1px solid rgba(0,155,4,0.1)",
                background: "rgba(0,155,4,0.04)",
              }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2, color: "#8aae9b" }}>YOUR HISTORY</span>
                <span style={{ fontSize: 10, color: "#5a7e6a", letterSpacing: 1 }}>
                  {userHistoryLoading ? "SCANNING..." : `${userHistory.length} ROUNDS`}
                </span>
              </div>
              <div style={{
                display: "grid", gridTemplateColumns: "38px 64px 30px 44px 28px 52px 1fr",
                padding: "8px 16px 4px", gap: 4,
                borderBottom: "1px solid rgba(255,255,255,0.04)",
              }}>
                <span style={{ fontSize: 9, color: "#4a6e5a", letterSpacing: 1.5, fontWeight: 700 }}>RES</span>
                <span style={{ fontSize: 9, color: "#4a6e5a", letterSpacing: 1.5, fontWeight: 700 }}>ROUND</span>
                <span style={{ fontSize: 9, color: "#4a6e5a", letterSpacing: 1.5, fontWeight: 700 }}>CELL</span>
                <span style={{ fontSize: 9, color: "#4a6e5a", letterSpacing: 1.5, fontWeight: 700, textAlign: "right" }}>POT</span>
                <span style={{ fontSize: 9, color: "#4a6e5a", letterSpacing: 1.5, fontWeight: 700, textAlign: "right" }}>PLYR</span>
                <span style={{ fontSize: 9, color: "#4a6e5a", letterSpacing: 1.5, fontWeight: 700, textAlign: "right" }}>GROOD</span>
                <span style={{ fontSize: 9, color: "#4a6e5a", letterSpacing: 1.5, fontWeight: 700, textAlign: "right" }}>P&L</span>
              </div>
              <div className="grid-user-history-scroll" style={{ maxHeight: 240, overflowY: "auto" }}>
                {userHistory.map((h, i) => {
                  const isWin = h.won;
                  const potRaw = Number(h.pot || 0);
                  const { feeBps, resolverReward } = feeConfig.current;
                  const distributable = Math.max(potRaw - Math.floor(potRaw * feeBps / 10000) - resolverReward, 0);
                  const perWinner = distributable / (h.numWinners || 1);
                  const displayAmt = isWin ? (perWinner / 1e6) : 1;
                  return (
                    <div key={h.roundId} style={{
                      display: "grid", gridTemplateColumns: "38px 64px 30px 44px 28px 52px 1fr",
                      padding: "7px 16px", gap: 4,
                      borderBottom: "1px solid rgba(255,255,255,0.03)",
                    }}>
                      <span style={{
                        fontSize: 9, fontWeight: 700, letterSpacing: 1,
                        padding: "2px 0", borderRadius: 3, textAlign: "center",
                        background: isWin ? "rgba(0,200,5,0.12)" : "rgba(255,80,0,0.1)",
                        color: isWin ? "#00C805" : "#FF5000",
                      }}>
                        {isWin ? "WON" : "LOST"}
                      </span>
                      <span style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 11, fontWeight: 600, color: "#d0e8dc" }}>#{h.roundId}</span>
                      <span style={{ fontSize: 11, color: "#8aae9b" }}>{CELL_LABELS[h.cell] || "?"}</span>
                      <span style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 10, color: "#00C805", fontWeight: 600, textAlign: "right" }}>
                        {h.pot ? fmt(h.pot) : "—"}
                      </span>
                      <span style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 10, color: "#7a9e8b", textAlign: "right" }}>
                        {h.players || "—"}
                      </span>
                      <span style={{
                        fontFamily: "'Orbitron', sans-serif", fontSize: 10, fontWeight: 600,
                        color: isWin ? "#009B04" : "#2a4e3a", textAlign: "right",
                      }}>
                        {isWin ? "+100 G" : "—"}
                      </span>
                      <span style={{
                        fontFamily: "'Orbitron', sans-serif", fontSize: 10, fontWeight: 600,
                        color: isWin ? "#00C805" : "#FF5000", textAlign: "right", whiteSpace: "nowrap",
                      }}>
                        {isWin ? "+" : "-"}{displayAmt.toFixed(2)} USDG
                      </span>
                    </div>
                  );
                })}
              </div>
              {userHistory.length > 0 && userHistoryOffset.current < userHistoryTotal.current && (
                <div style={{
                  padding: "8px 16px", textAlign: "center",
                  borderTop: "1px solid rgba(0,155,4,0.1)",
                  background: "rgba(0,155,4,0.02)",
                }}>
                  <button
                    onClick={() => {
                      setUserHistoryLoading(true);
                      fetchUserHistory(userHistoryOffset.current, 10).then(results => {
                        setUserHistory(prev => {
                          const ids = new Set(prev.map(h => h.roundId));
                          return [...prev, ...results.filter(r => !ids.has(r.roundId))];
                        });
                        userHistoryOffset.current += results.length;
                        setUserHistoryLoading(false);
                      });
                    }}
                    style={{
                      width: "100%", padding: "6px 0",
                      background: "none", border: "1px solid rgba(0,155,4,0.15)",
                      borderRadius: 4, color: "#00C805", fontSize: 10,
                      fontFamily: "'JetBrains Mono', monospace", fontWeight: 600,
                      letterSpacing: 1, cursor: "pointer",
                    }}
                  >
                    {userHistoryLoading ? "SCANNING..." : "LOAD MORE"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ─── ROUND HISTORY TABLE (paginated) ─── */}
          {(() => {
            const totalPages = Math.ceil(roundHistory.length / HISTORY_PAGE_SIZE) || 1;
            const pageStart = historyPage * HISTORY_PAGE_SIZE;
            const pageRows = roundHistory.slice(pageStart, pageStart + HISTORY_PAGE_SIZE);
            const hasOlder = roundHistory.length > 0 && (historyPage < totalPages - 1 || !historyFullyLoaded);
            const hasNewer = historyPage > 0;
            return (
            <div style={{
              width: "100%", maxWidth: 520, marginTop: 14,
              borderRadius: 10,
              border: "1px solid rgba(0,155,4,0.2)",
              background: "rgba(0,155,4,0.03)",
              overflow: "hidden",
              animation: "winnerBannerIn 0.5s ease-out",
            }}>
              {/* Header */}
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "10px 16px",
                borderBottom: "1px solid rgba(0,155,4,0.1)",
                background: "rgba(0,155,4,0.04)",
              }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2, color: "#8aae9b" }}>ROUND HISTORY</span>
                <span style={{ fontSize: 10, color: "#5a7e6a", letterSpacing: 1 }}>
                  {historyLoading ? "SCANNING..." : `${roundHistory.length} ROUNDS${historyFullyLoaded ? "" : "+"} · PAGE ${historyPage + 1}`}
                </span>
              </div>
              {/* Column headers */}
              <div style={{
                display: "grid", gridTemplateColumns: "62px 52px 52px 1fr 1fr",
                padding: "8px 16px 4px", gap: 4,
                borderBottom: "1px solid rgba(255,255,255,0.04)",
              }}>
                <span style={{ fontSize: 9, color: "#4a6e5a", letterSpacing: 1.5, fontWeight: 700 }}>ROUND</span>
                <span style={{ fontSize: 9, color: "#4a6e5a", letterSpacing: 1.5, fontWeight: 700 }}>WINNER</span>
                <span style={{ fontSize: 9, color: "#4a6e5a", letterSpacing: 1.5, fontWeight: 700 }}>POT</span>
                <span style={{ fontSize: 9, color: "#4a6e5a", letterSpacing: 1.5, fontWeight: 700, textAlign: "right" }}>TRANSFER</span>
                <span style={{ fontSize: 9, color: "#4a6e5a", letterSpacing: 1.5, fontWeight: 700, textAlign: "right" }}>DRAND</span>
              </div>
              {/* Rows */}
              <div>
                {pageRows.length === 0 && (
                  <div style={{ padding: "20px 16px", textAlign: "center", color: "#5a7e6a", fontSize: 11, letterSpacing: 1 }}>
                    {historyLoading ? "⟐ SCANNING ROUNDS..." : "NO ROUNDS WITH PLAYERS FOUND"}
                  </div>
                )}
                {pageRows.map((r, i) => {
                  const globalIdx = pageStart + i;
                  const isLatest = globalIdx === 0 && moneyFlow;
                  return (
                    <div key={r.roundId} style={{
                      display: "grid", gridTemplateColumns: "62px 52px 52px 1fr 1fr",
                      padding: "7px 16px", gap: 4,
                      borderBottom: "1px solid rgba(255,255,255,0.03)",
                      background: isLatest ? "rgba(255,200,0,0.06)" : "transparent",
                      transition: "background 0.5s ease",
                      animation: globalIdx === 0 ? "winnerBannerIn 0.4s ease-out" : "none",
                    }}>
                      <span style={{
                        fontFamily: "'Orbitron', sans-serif", fontSize: 11, fontWeight: 600,
                        color: isLatest ? "#ffc800" : "#d0e8dc",
                      }}>#{r.roundId}</span>
                      <span style={{
                        fontSize: 12, fontWeight: 700,
                        color: r.resolved === false ? "#FF9666" : "#ffc800", letterSpacing: 0.5,
                      }}>
                        {r.resolved === false ? "⏳" : (CELL_LABELS[r.cell] || "?")} {globalIdx === 0 && r.resolved !== false ? "★" : ""}
                      </span>
                      <span style={{
                        fontFamily: "'Orbitron', sans-serif", fontSize: 11, fontWeight: 600,
                        color: isLatest ? "#ffc800" : "#00C805",
                        animation: isLatest ? "pulse 1s ease-in-out infinite" : "none",
                      }}>{fmt(r.pot)}</span>
                      <span style={{ textAlign: "right" }}>
                        {r.txHash ? (
                          <a
                            href={`${EXPLORER}/tx/${r.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontSize: 10, color: "#00C805", textDecoration: "none", fontFamily: "'JetBrains Mono', monospace" }}
                          >
                            {r.txHash.slice(0, 6)}…{r.txHash.slice(-4)} ↗
                          </a>
                        ) : (
                          <span style={{ fontSize: 10, color: "#2a4e3a" }}>—</span>
                        )}
                      </span>
                      <span style={{ textAlign: "right" }}>
                        {r.drandRound ? (
                          <a
                            href={`https://api.drand.sh/${DRAND_CHAIN_HASH}/public/${r.drandRound}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontSize: 10, color: "#00C805", textDecoration: "none", fontFamily: "'JetBrains Mono', monospace" }}
                          >
                            #{r.drandRound} ↗
                          </a>
                        ) : (
                          <span style={{ fontSize: 10, color: "#2a4e3a" }}>—</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              {/* Pagination */}
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "8px 16px",
                borderTop: "1px solid rgba(0,155,4,0.1)",
                background: "rgba(0,155,4,0.02)",
              }}>
                <button
                  onClick={() => setHistoryPage(p => Math.max(0, p - 1))}
                  disabled={!hasNewer}
                  style={{
                    background: hasNewer ? "rgba(0,155,4,0.12)" : "transparent",
                    border: hasNewer ? "1px solid rgba(0,155,4,0.3)" : "1px solid rgba(255,255,255,0.06)",
                    color: hasNewer ? "#00C805" : "#3a5e4a",
                    padding: "4px 14px", borderRadius: 6, fontSize: 10, fontWeight: 700,
                    letterSpacing: 1.5, cursor: hasNewer ? "pointer" : "default",
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >◀ NEWER</button>
                <span style={{ fontSize: 10, color: "#5a7e6a", letterSpacing: 1 }}>
                  {pageStart + 1}–{Math.min(pageStart + HISTORY_PAGE_SIZE, roundHistory.length)} of {roundHistory.length}{historyFullyLoaded ? "" : "+"}
                </span>
                <button
                  onClick={() => {
                    const nextPage = historyPage + 1;
                    const nextStart = nextPage * HISTORY_PAGE_SIZE;
                    // If we need more data, fetch it
                    if (nextStart >= roundHistory.length - HISTORY_PAGE_SIZE && !historyFullyLoaded) {
                      loadOlderHistory();
                    }
                    setHistoryPage(nextPage);
                  }}
                  disabled={!hasOlder || historyLoading}
                  style={{
                    background: hasOlder ? "rgba(0,155,4,0.12)" : "transparent",
                    border: hasOlder ? "1px solid rgba(0,155,4,0.3)" : "1px solid rgba(255,255,255,0.06)",
                    color: hasOlder ? "#00C805" : "#3a5e4a",
                    padding: "4px 14px", borderRadius: 6, fontSize: 10, fontWeight: 700,
                    letterSpacing: 1.5, cursor: hasOlder ? "pointer" : "default",
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >{historyLoading ? "LOADING..." : "OLDER ▶"}</button>
              </div>
            </div>
            );
          })()}
        </div>

        {/* ─── SIDE RAIL: stats + betting controls (desktop) ─── */}
        <aside className="grid-rail" style={S.rail}>
          <div style={S.railRow}>
            <div style={S.statCard}>
              <span style={S.statLabel}>TIME LEFT · R{round}</span>
              <span style={{ ...S.statValue, color: timerColor }}>
                {Math.floor(smoothTime)}<span style={{ fontSize: 14, opacity: 0.7 }}>.{Math.floor((smoothTime % 1) * 10)}s</span>
              </span>
            </div>
            <div style={S.statCard}>
              <span style={S.statLabel}>POT</span>
              <span style={{ ...S.statValue, color: "#00C805" }}>
                {fmt(potSize)}<span style={{ fontSize: 11, opacity: 0.7 }}> USDG</span>
              </span>
            </div>
          </div>
          <div style={S.railRow}>
            <div style={S.statCard}>
              <span style={S.statLabel}>PLAYERS</span>
              <span style={S.statValue}>{activePlayers}</span>
            </div>
            <div style={S.statCard}>
              <span style={S.statLabel}>YOUR ENTRY</span>
              <span style={S.statValue}>{playerCell >= 0 ? CELL_LABELS[playerCell] : "—"}</span>
              <span style={S.statSub}>{playerCell >= 0 ? "1 USDG DEPOSITED" : "NOT ENTERED"}</span>
            </div>
          </div>

          <div style={S.betPanel}>
            {(() => {
              const focus = selectedCell != null ? selectedCell : (hoveredCell >= 0 ? hoveredCell : (playerCell >= 0 ? playerCell : null));
              const pay = payoutFor(focus);
              const nOn = focus != null ? (cellCounts[focus] || 0) : 0;
              return (
                <>
                  <div style={S.betHead}>
                    <span style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 17, fontWeight: 900, color: "#e0f0e8", letterSpacing: 1 }}>
                      {focus != null ? `CELL ${CELL_LABELS[focus]}` : "PICK A CELL"}
                    </span>
                    {focus != null && (
                      <span style={{ fontSize: 10, color: "#7a9e8b", letterSpacing: 0.5 }}>
                        {nOn} PLAYER{nOn === 1 ? "" : "S"} ON IT
                      </span>
                    )}
                  </div>
                  <div style={S.betRows}>
                    <div style={S.betRow}><span>Entry</span><b style={{ color: "#e0f0e8" }}>1 USDG</b></div>
                    <div style={S.betRow}>
                      <span>Payout if it wins</span>
                      <b style={{ color: "#00C805", fontFamily: "'Orbitron', sans-serif" }}>{pay != null ? `${fmt(pay)} USDG` : "—"}</b>
                    </div>
                    <div style={S.betNote}>
                      after {(feeConfig.current.feeBps / 100).toFixed(0)}% fee + {fmt(feeConfig.current.resolverReward, 1)} resolver tip, split among winners on the cell
                    </div>
                  </div>
                  {!authenticated ? (
                    <button style={S.betCta} onClick={login}>LOGIN TO PLAY</button>
                  ) : allowanceChecked && !usdcApproved ? (
                    approving
                      ? <div style={S.claimingBar}><div style={S.claimingDot} />APPROVING USDG...</div>
                      : <button style={S.betCta} onClick={approveUsdc}>APPROVE USDG TO PLAY</button>
                  ) : playerCell >= 0 ? (
                    <div style={S.betLocked}>◈ ENTERED ON {CELL_LABELS[playerCell]} — GOOD LUCK</div>
                  ) : claiming ? (
                    <div style={S.claimingBar}><div style={S.claimingDot} />CONFIRMING TX...</div>
                  ) : smoothTime <= 0 ? (
                    <div style={S.betLocked}>RESOLVING…</div>
                  ) : selectedCell != null ? (
                    <button style={S.betCta} onClick={() => claimCell(selectedCell)}>
                      ENTER {CELL_LABELS[selectedCell]} — 1 USDG
                    </button>
                  ) : (
                    <button style={{ ...S.betCta, opacity: 0.35, cursor: "default" }} disabled>SELECT A CELL</button>
                  )}
                </>
              );
            })()}
          </div>

          <div style={S.railHint}>
            ★ MOTHERLODE — 1 IN 100 ROUNDS PAYS 10× · RANDOMNESS BY DRAND, VERIFIED ON-CHAIN
          </div>
        </aside>

      </div>

      {/* Debug: show poll errors visibly */}
      {round === 0 && (
        <div style={{
          width: "100%", maxWidth: 900, padding: "10px 16px", margin: "8px auto",
          background: "rgba(255,80,0,0.1)", border: "1px solid rgba(255,80,0,0.3)",
          borderRadius: 8, fontSize: 11, color: "#FF9666", fontFamily: "'JetBrains Mono', monospace",
        }}>
          <b>⚠ DEBUG:</b> Round = 0 (not loading). Polls: {pollCount.current}.
          {pollError.current && <span> Error: {pollError.current}</span>}
          {!pollError.current && <span> No error caught — poll may not have run yet. Check console.</span>}
          <br/>RPC: Robinhood Chain | Contract: {GRID_ADDR.slice(0,10)}...
        </div>
      )}

      {/* ─── FOOTER ─── */}
      <footer style={S.footer}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <LogoIcon size={16} />
          <span style={S.gridOnline}>GROOD ONLINE</span>
        </span>
        <span style={{ fontSize: 11, color: "#4a6e5a", letterSpacing: 1 }}>ON-CHAIN · ROBINHOOD · RANDOMNESS BY DRAND</span>
      </footer>

      {/* ─── CSS ─── */}
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { margin: 0; padding: 0; background: #06140A; overflow-x: hidden; }
        @keyframes cellAppear { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes glow {
          0%, 100% { box-shadow: 0 0 8px rgba(0,155,4,0.3), inset 0 0 8px rgba(0,155,4,0.1); }
          50% { box-shadow: 0 0 20px rgba(0,155,4,0.6), inset 0 0 15px rgba(0,155,4,0.2); }
        }
        @keyframes winnerGlow {
          0%, 100% { box-shadow: 0 0 10px rgba(255,200,0,0.4), inset 0 0 10px rgba(255,200,0,0.1); }
          50% { box-shadow: 0 0 30px rgba(255,200,0,0.8), inset 0 0 20px rgba(255,200,0,0.3); }
        }
        @keyframes slideIn { from { opacity: 0; transform: translateX(10px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes moneyFlowBg {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes coinFlow {
          0% { opacity: 0; transform: translateX(-8px) scale(0.5); }
          40% { opacity: 1; transform: translateX(0) scale(1); }
          100% { opacity: 0; transform: translateX(8px) scale(0.5); }
        }
        @keyframes winnerPop {
          0% { transform: scale(0.3); opacity: 0; }
          50% { transform: scale(1.3); }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes gridResetFlash {
          0% { background: rgba(0,155,4,0.25); }
          100% { background: transparent; }
        }
        @keyframes particleFlow {
          0% { left: -5%; opacity: 0; }
          15% { opacity: 0.8; }
          85% { opacity: 0.8; }
          100% { left: 105%; opacity: 0; }
        }
        @keyframes winnerBannerIn {
          0% { opacity: 0; transform: translateY(10px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes scanGlow {
          0% { text-shadow: 0 0 4px #00C805; }
          50% { text-shadow: 0 0 12px #00C805, 0 0 24px #00C80544; }
          100% { text-shadow: 0 0 4px #00C805; }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes spinR { to { transform: rotate(-360deg); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes navGlow { 0%,100%{text-shadow:0 0 6px rgba(0,200,5,0.5)}50%{text-shadow:0 0 14px rgba(0,200,5,0.9)} }
        @keyframes pulse { 0%,100%{opacity:1;box-shadow:0 0 4px #00C805}50%{opacity:0.4;box-shadow:0 0 10px #00C805} }
        .nav-btn-home:hover { color: #00C805 !important; }
        .nav-btn-play { pointer-events: none; }
        .grid-rail { position: sticky; top: 78px; }
        @media (max-width: 1024px) {
          .grid-rail { display: none !important; }
          .grid-main { flex-direction: column !important; align-items: center !important; }
        }
        @media (max-width: 640px) {
          .grid-tap-hint { display: none !important; }
        }
        @media (min-width: 1025px) {
          .grid-mobile-stats { display: none !important; }
          .grid-mobile-controls { display: none !important; }
        }
        .wallet-addr-mobile { display: none !important; }
        .wallet-addr-desktop { display: inline !important; }
        @media (max-width: 640px) {
          .grid-header-nav { display: none !important; }
          .grid-header-stat { display: none !important; }
          .grid-mobile-balances { display: none !important; }
          .wallet-addr-desktop { display: none !important; }
          .wallet-addr-mobile { display: flex !important; }
          .grid-logo-text { font-size: 14px !important; letter-spacing: 1px !important; }
          .grid-header-logo-icon { width: 18px !important; height: 18px !important; }
          .grid-header-wallet-btn button { font-size: 9px !important; padding: 5px 8px !important; letter-spacing: 0.5px !important; }
        }
        @keyframes dropIn {
          from { opacity: 0; transform: translateY(-6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .grid-user-history-scroll::-webkit-scrollbar { width: 4px; }
        .grid-user-history-scroll::-webkit-scrollbar-track { background: rgba(0,155,4,0.04); }
        .grid-user-history-scroll::-webkit-scrollbar-thumb { background: rgba(0,155,4,0.25); border-radius: 2px; }
        @media (max-width: 768px) {
          .grid-wallet-dropdown { right: 0 !important; left: auto !important; max-width: calc(100vw - 16px) !important; }
        }
        @media (max-width: 768px) {
          .grid-main { flex-direction: column !important; }
          .grid-mobile-user-history { display: block !important; }
          .grid-sidebar-backdrop {
            display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            width: 100%; height: 100%;
            background: rgba(0,0,0,0.75); z-index: 9998;
            backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
            touch-action: none;
          }
          .grid-sidebar-backdrop.open { display: block !important; }
          .grid-sidebar {
            position: fixed !important; top: 0 !important; right: 0 !important; bottom: 0 !important;
            width: 90vw !important; max-width: 420px !important;
            height: 100% !important; height: 100dvh !important;
            z-index: 9999 !important;
            overflow-y: auto !important; overflow-x: hidden !important;
            -webkit-overflow-scrolling: touch !important;
            background: #0A180E !important;
            border-left: 1px solid rgba(0,155,4,0.25) !important;
            padding: 0 16px 16px !important;
            padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px)) !important;
            transform: translateX(100%) !important;
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
            box-shadow: none !important;
            will-change: transform !important;
            overscroll-behavior: contain !important;
          }
          .grid-sidebar.open {
            transform: translateX(0) !important;
            box-shadow: -8px 0 40px rgba(0,0,0,0.6) !important;
          }
          .grid-sidebar-header {
            position: sticky !important; top: 0 !important; z-index: 10 !important;
            background: #0A180E !important;
            padding: 16px 0 12px !important;
            margin: 0 -16px !important; padding-left: 16px !important; padding-right: 16px !important;
            padding-top: calc(16px + env(safe-area-inset-top, 0px)) !important;
            border-bottom: 1px solid rgba(0,155,4,0.15) !important;
            display: flex !important; justify-content: space-between !important; align-items: center !important;
          }
          .grid-game-area {
            padding: 8px 12px !important;
            overflow-y: auto !important;
            -webkit-overflow-scrolling: touch !important;
            max-height: none !important;
            justify-content: flex-start !important;
            flex: 1 1 auto !important;
            min-height: 0 !important;
          }
          .grid-header-stat { display: none !important; }
          .grid-header-wallet-btn { font-size: 10px !important; }
        }

      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════

function LogoIcon({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}>
      <defs>
        <linearGradient id={`lg${size}`} x1="0" y1="0" x2="80" y2="80" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00C805" />
          <stop offset="100%" stopColor="#009B04" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="72" height="72" rx="16" fill={`url(#lg${size})`} />
      <line x1="30" y1="4" x2="30" y2="76" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
      <line x1="50" y1="4" x2="50" y2="76" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
      <line x1="4" y1="30" x2="76" y2="30" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
      <line x1="4" y1="50" x2="76" y2="50" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
      <text x="40" y="56" textAnchor="middle" fontFamily="'Orbitron', sans-serif" fontWeight="900" fontSize="48" fill="white" letterSpacing="-2">G</text>
    </svg>
  );
}

function Panel({ title, live, children }) {
  return (
    <div style={S.panel}>
      <div style={S.panelHead}>
        <span>{title}</span>
        {live && <span style={S.liveTag}>● LIVE</span>}
      </div>
      <div style={{ padding: "8px 14px" }}>{children}</div>
    </div>
  );
}

function Row({ label, value, hl }) {
  return (
    <div style={S.row}>
      <span style={S.rowLabel}>{label}</span>
      <span style={{ ...S.rowValue, ...(hl ? { color: "#00C805" } : {}) }}>{value}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════
const S = {
  root: {
    fontFamily: "'JetBrains Mono', monospace",
    background: "radial-gradient(ellipse at 30% 20%, #0D301A 0%, #081C0E 50%, #06140A 100%)",
    color: "#c8e5d6", minHeight: "100vh",
    display: "flex", flexDirection: "column",
    position: "relative",
  },
  scanOverlay: {
    position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
    pointerEvents: "none", zIndex: 2, transition: "background 0.04s linear",
  },
  crtLines: {
    position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
    pointerEvents: "none", zIndex: 1,
    background: "repeating-linear-gradient(0deg, transparent 0px, transparent 2px, rgba(0,0,0,0.08) 2px, rgba(0,0,0,0.08) 4px)",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "0 20px", height: 64, borderBottom: "1px solid rgba(0,155,4,0.12)",
    background: "rgba(8,22,12,0.97)", zIndex: 10, position: "relative",
    flexWrap: "nowrap", gap: 8, flexShrink: 0,
  },
  hLeft: { display: "flex", alignItems: "center", gap: 10, flexShrink: 0 },
  hRight: { display: "flex", alignItems: "center", gap: 10, flexShrink: 0, minWidth: 0 },
  dot: { width: 10, height: 10, borderRadius: 3, background: "#009B04", boxShadow: "0 0 12px rgba(0,155,4,0.6)" },
  logo: { fontFamily: "'Orbitron', sans-serif", fontWeight: 900, fontSize: 18, color: "#00C805", letterSpacing: 2 },
  logoSub: { fontFamily: "'Orbitron', sans-serif", fontWeight: 500, fontSize: 18, color: "#e0f0e8", letterSpacing: 2 },
  badge: { fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "rgba(0,155,4,0.12)", color: "#00C805", letterSpacing: 1.5, fontWeight: 600 },
  hStat: { fontSize: 13, color: "#7a9e8b", letterSpacing: 0.5, fontFamily: "'JetBrains Mono', monospace" },
  loginBtn: {
    fontFamily: "'Orbitron', sans-serif", fontSize: 11, fontWeight: 700,
    padding: "7px 12px", borderRadius: 6,
    border: "1px solid #009B04",
    background: "linear-gradient(135deg, rgba(0,155,4,0.2), rgba(0,155,4,0.05))",
    color: "#00C805", cursor: "pointer", letterSpacing: 1.5,
  },
  menuBtn: { fontSize: 20, background: "none", border: "1px solid rgba(255,255,255,0.15)", color: "#c8e5d6", borderRadius: 6, padding: "4px 10px", cursor: "pointer" },
  main: { display: "flex", flex: 1, gap: 28, position: "relative", zIndex: 5, width: "100%", maxWidth: 1240, margin: "0 auto", padding: "0 24px", alignItems: "flex-start", justifyContent: "center" },
  gridArea: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", padding: "16px 0", minHeight: 0, maxWidth: 780 },
  timerWrap: { width: "100%", maxWidth: "min(74vh, 720px)", display: "flex", alignItems: "center", gap: 12, marginBottom: 10 },
  timerBarBg: { flex: 1, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.07)", overflow: "hidden" },
  timerBarFill: { height: "100%", borderRadius: 3, transition: "background-color 0.4s ease" },
  timerNum: { fontFamily: "'Orbitron', sans-serif", fontSize: 20, fontWeight: 700, transition: "color 0.5s ease" },
  timerMs: { fontSize: 14, opacity: 0.7 },
  gridOuter: { position: "relative", width: "100%", maxWidth: "min(74vh, 720px)", padding: 10 },
  cornerTL: { position: "absolute", top: 0, left: 0, width: 20, height: 20, borderLeft: "2px solid rgba(0,155,4,0.4)", borderTop: "2px solid rgba(0,155,4,0.4)" },
  cornerTR: { position: "absolute", top: 0, right: 0, width: 20, height: 20, borderRight: "2px solid rgba(0,155,4,0.4)", borderTop: "2px solid rgba(0,155,4,0.4)" },
  cornerBL: { position: "absolute", bottom: 0, left: 0, width: 20, height: 20, borderLeft: "2px solid rgba(0,155,4,0.4)", borderBottom: "2px solid rgba(0,155,4,0.4)" },
  cornerBR: { position: "absolute", bottom: 0, right: 0, width: 20, height: 20, borderRight: "2px solid rgba(0,155,4,0.4)", borderBottom: "2px solid rgba(0,155,4,0.4)" },
  grid: { display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, width: "100%" },
  cell: {
    fontFamily: "'JetBrains Mono', monospace", position: "relative",
    aspectRatio: "1", borderRadius: 10,
    cursor: "pointer", display: "flex",
    alignItems: "center", justifyContent: "center",
    fontSize: 11, fontWeight: 600,
    animation: "cellAppear 0.4s ease both",
    touchAction: "manipulation",
    background: "rgba(0,200,5,0.05)",
    border: "1px solid rgba(0,200,5,0.14)",
    color: "#c8e5d6",
  },
  cellHover: {
    background: "rgba(0,200,5,0.13)",
    border: "1px solid #26D02B",
    transform: "translateY(-2px)",
  },
  cellCount: {
    position: "absolute", top: 6, right: 6,
    fontSize: 9, fontWeight: 700, lineHeight: 1,
    padding: "3px 6px", borderRadius: 8,
    background: "rgba(0,200,5,0.25)", color: "#e0f0e8",
  },
  cellCenter: { display: "flex", alignItems: "center", justifyContent: "center" },
  cellYouTag: {
    fontFamily: "'Orbitron', sans-serif", fontSize: 10, fontWeight: 900,
    letterSpacing: 1, color: "#06140A", background: "#00C805",
    padding: "3px 7px", borderRadius: 4,
  },
  cellClaimed: {
    background: "rgba(0,200,5,0.1)",
    border: "1px solid rgba(0,200,5,0.35)",
  },
  cellYours: {
    background: "rgba(0,200,5,0.22)",
    border: "2px solid #00C805",
  },
  cellWinner: {
    background: "rgba(255,215,0,0.22)",
    border: "2px solid #FFD700",
    color: "#FFD700",
    transform: "scale(1.05)",
    boxShadow: "0 6px 24px rgba(255,215,0,0.25)",
    zIndex: 2,
  },
  cellSelected: {
    background: "rgba(0,200,5,0.22)",
    border: "2px solid #00C805",
    color: "#fff",
    transform: "scale(1.04)",
    boxShadow: "0 6px 20px rgba(0,200,5,0.2)",
    zIndex: 2,
  },
  cellScanSweep: {
    background: "rgba(255,215,0,0.2)",
    border: "2px solid rgba(255,215,0,0.75)",
    color: "#FFD700",
    transform: "scale(1.04)",
    zIndex: 2,
  },
  cellLabel: { position: "absolute", top: 6, left: 8, fontSize: 9, letterSpacing: 1, opacity: 0.5 },
  cellIcon: { fontSize: 16 },
  statusBar: { display: "flex", justifyContent: "space-between", width: "100%", maxWidth: "min(74vh, 720px)", padding: "8px 12px", marginTop: 8, fontSize: 11, letterSpacing: 1.5, color: "#5a7e6a" },
  dots: { display: "flex", gap: 3, width: "100%", maxWidth: 620, padding: "0 12px" },
  progressDot: { flex: 1, height: 3, borderRadius: 2, transition: "background-color 0.5s ease" },
  sidebar: {
    width: 340, minWidth: 300, borderLeft: "1px solid rgba(0,155,4,0.08)",
    background: "rgba(10,24,14,0.98)", padding: 16,
    display: "flex", flexDirection: "column", gap: 12,
    overflowY: "auto", maxHeight: "calc(100vh - 100px)",
  },
  closeBtn: { alignSelf: "flex-end", background: "none", border: "none", color: "#7a9e8b", fontSize: 18, cursor: "pointer", padding: "4px 8px" },
  loginPrompt: { border: "1px solid rgba(0,155,4,0.2)", borderRadius: 8, background: "rgba(0,155,4,0.04)", padding: 16, textAlign: "center" },
  loginPromptTitle: { fontFamily: "'Orbitron', sans-serif", fontSize: 16, fontWeight: 700, color: "#e0f0e8", marginTop: 14, marginBottom: 8, letterSpacing: 2 },
  loginPromptText: { fontSize: 12, color: "#7a9e8b", marginBottom: 12, lineHeight: 1.5 },
  panel: { border: "1px solid rgba(0,155,4,0.1)", borderRadius: 8, background: "rgba(0,155,4,0.02)", overflow: "hidden" },
  panelHead: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", fontSize: 11, fontWeight: 700, letterSpacing: 2, color: "#8aae9b", borderBottom: "1px solid rgba(0,155,4,0.06)" },
  liveTag: { color: "#00C805", fontSize: 10, letterSpacing: 1, animation: "scanGlow 2s ease-in-out infinite" },
  row: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", fontSize: 12 },
  rowLabel: { color: "#6a8e7b", letterSpacing: 0.5 },
  rowValue: { fontWeight: 600, color: "#d0e8dc", fontFamily: "'Orbitron', sans-serif", fontSize: 13 },
  claimBtn: {
    fontFamily: "'Orbitron', sans-serif", fontSize: 12, fontWeight: 700,
    padding: "14px 20px", borderRadius: 8,
    border: "none",
    background: "linear-gradient(135deg, #009B04, #00C805)",
    color: "#fff", cursor: "pointer", letterSpacing: 1,
    transition: "all 0.2s", textAlign: "center", width: "100%",
    boxShadow: "0 4px 20px rgba(0,155,4,0.3)",
  },
  claimingBar: { display: "flex", alignItems: "center", gap: 10, padding: "14px 20px", borderRadius: 8, border: "1px solid rgba(0,155,4,0.3)", background: "rgba(0,155,4,0.08)", color: "#40D644", fontSize: 12, fontWeight: 600, letterSpacing: 1 },
  claimingDot: { width: 8, height: 8, borderRadius: "50%", background: "#40D644", animation: "pulse 1s ease-in-out infinite" },
  errorBox: { padding: "10px 14px", borderRadius: 6, border: "1px solid rgba(255,80,0,0.3)", background: "rgba(255,80,0,0.08)", color: "#FF5000", fontSize: 11, cursor: "pointer" },
  feedBody: { maxHeight: 200, overflowY: "auto" },
  feedEmpty: { color: "#3a5e4a", fontSize: 12, fontStyle: "italic", padding: "12px 0" },
  feedItem: { fontSize: 11, padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.03)", display: "flex", gap: 8, animation: "slideIn 0.3s ease" },
  feedTime: { color: "#3a5e4a", fontSize: 10, flexShrink: 0 },
  footer: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 20px", borderTop: "1px solid rgba(0,155,4,0.08)", background: "rgba(8,22,12,0.95)", zIndex: 10, position: "relative" },
  greenDot: { display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "#00C805", boxShadow: "0 0 6px #00C80588" },
  gridOnline: { fontSize: 12, fontWeight: 700, color: "#00C805", letterSpacing: 1.5, animation: "scanGlow 3s ease-in-out infinite" },
  dropdownItem: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "12px 14px", fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11, color: "#c8e5d6", cursor: "pointer",
    border: "none", background: "none", width: "100%",
    textAlign: "left", letterSpacing: 0.5,
    WebkitTapHighlightColor: "transparent",
  },
  dropdownIcon: { fontSize: 14, width: 20, textAlign: "center" },
  dropdownDivider: { height: 1, background: "rgba(255,255,255,0.06)" },
  dropdownInput: {
    width: "100%", padding: "10px 12px", fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
    background: "rgba(0,0,0,0.4)", border: "1px solid rgba(0,155,4,0.15)",
    borderRadius: 6, color: "#c8e5d6", outline: "none", letterSpacing: 0.3,
  },

  // ── Side rail (desktop) ──
  rail: { width: 352, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12, padding: "16px 0" },
  railRow: { display: "flex", gap: 12 },
  statCard: {
    flex: 1, display: "flex", flexDirection: "column", gap: 4,
    background: "rgba(0,200,5,0.04)", border: "1px solid rgba(0,200,5,0.13)",
    borderRadius: 10, padding: "12px 14px", minWidth: 0,
  },
  statLabel: { fontSize: 9, letterSpacing: 1.5, color: "#5a7e6a", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" },
  statValue: { fontFamily: "'Orbitron', sans-serif", fontSize: 22, fontWeight: 900, color: "#e0f0e8", lineHeight: 1.1 },
  statSub: { fontSize: 9, color: "#4a6e5a", letterSpacing: 0.5 },
  betPanel: {
    display: "flex", flexDirection: "column", gap: 12,
    background: "rgba(0,200,5,0.05)", border: "1px solid rgba(0,200,5,0.2)",
    borderRadius: 12, padding: 16,
  },
  betHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  betRows: { display: "flex", flexDirection: "column", gap: 6 },
  betRow: { display: "flex", justifyContent: "space-between", fontSize: 12, color: "#7a9e8b" },
  betNote: { fontSize: 9.5, color: "#4a6e5a", lineHeight: 1.5 },
  betCta: {
    fontFamily: "'Orbitron', sans-serif", fontSize: 13, fontWeight: 700,
    padding: "14px 16px", borderRadius: 8, border: "none",
    background: "linear-gradient(135deg, #00C805, #009B04)",
    color: "#fff", cursor: "pointer", letterSpacing: 1, width: "100%",
  },
  betLocked: {
    padding: "12px 16px", textAlign: "center", borderRadius: 8,
    border: "1px solid rgba(0,200,5,0.35)", color: "#00C805",
    fontSize: 12, fontWeight: 700, letterSpacing: 1,
  },
  railHint: { fontSize: 9, color: "#4a6e5a", letterSpacing: 1, lineHeight: 1.7, textAlign: "center", padding: "0 8px" },

  // ── Mobile stat strip ──
  mobileStats: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, width: "100%", maxWidth: 620, marginBottom: 10 },
  mobileStatCell: {
    display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
    background: "rgba(0,200,5,0.05)", border: "1px solid rgba(0,200,5,0.13)",
    borderRadius: 8, padding: "8px 4px",
  },
  mobileStatValue: { fontFamily: "'Orbitron', sans-serif", fontSize: 14, fontWeight: 900, color: "#e0f0e8" },
};

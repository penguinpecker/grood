<p align="center">
  <img src="https://img.shields.io/badge/Chain-Robinhood_Chain-00C805?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Entry-1_USDG-2775CA?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Randomness-drand_evmnet-8A2BE2?style=for-the-badge" />
</p>

<h1 align="center">◇ ◈ G R O O D ◈ ◇</h1>

<p align="center">
  <code>DISTRIBUTED RANDOMNESS · FULL DEGEN</code>
</p>

<p align="center">
  A provably fair 5×5 grid game on <strong>Robinhood Chain</strong>.<br/>
  Pick a cell. Hope the beacon picks the same one.<br/>
  Winner takes the pot. Every <strong>30 seconds</strong>. Forever.
</p>

---

## WTF is Grood?

Grood is an onchain lottery that runs every **30 seconds** on **Robinhood Chain** (chain 4663).

There's a 5×5 grid. You pick a cell. You pay **1 USDG**. When the round ends, the winning cell is chosen by a **drand randomness beacon** — produced by the League of Entropy's distributed network and **BLS-verified by the game contract itself** on-chain. If you're standing on the winning cell — **you take the pot**.

The key trick: when a round starts, the contract pins the number of a **future** drand beacon — one that will only be emitted *after* betting closes. Nobody (not the resolver, not the deployer, not drand) can know or influence the outcome while entries are open, and the beacon's unique BLS signature is the only input the contract will accept.

> **This isn't trust-me-bro gambling. This isn't even trust-the-prover gambling. The randomness verifies itself on-chain.**

## 🕹️ How it works

| Step | What Happens |
|:----:|:-------------|
| **01** | **◉ Round Opens** — a new 30-second round begins; the contract pins the drand round emitted after `endTime` |
| **02** | **◇ Pick Your Cell** — any cell on the 5×5 grid, **1 USDG**. One entry per address. Multiple players can share a cell |
| **03** | **◈ Watch the Heatmap** — see where everyone's betting in real time. Crowded cells split the pot |
| **04** | **⬡ Beacon Resolves** — drand emits the pinned beacon; **anyone** submits its signature to `resolveRound()`, the contract verifies the BLS signature (BN254 pairing) and derives the winner from **occupied cells only** |
| **05** | **◆ Auto-Pay** — winners receive USDG + **$GROOD** in the same transaction. No claim step. The resolver earns 0.1 USDG |

**Motherlode:** 1 in 100 rounds (derived from a second hash of the same beacon) pays **10× USDG** and **10× $GROOD**.

**Payouts:** pool minus 5% protocol fee minus 0.1 USDG resolver reward, split among winners on the winning cell. A winner is guaranteed every round — the beacon draws from occupied cells only.

**Backstop:** if a round somehow sits unresolved for 30 days (drand beacons are unchained and resolvable forever, so this means drand itself died), anyone can void the round and every player reclaims their entry.

## 🏗️ Architecture

```
  PLAYER ── pickCell(1 USDG) ──▶ GROOD CONTRACT ── mint ──▶ $GROOD TOKEN
                                   │  ▲
                    verifies BLS   │  │ resolveRound(roundId, signature)
                    sig on-chain   │  │      (permissionless)
                                   ▼  │
                              DRAND BEACON ◀── fetch public sig ── KEEPER BOT
                              (evmnet, BN254)                      (optional!)
```

| Layer | Tech |
|:------|:-----|
| **Chain** | Robinhood Chain mainnet (4663, Arbitrum Nitro) · testnet 46630 |
| **Entry currency** | USDG (Paxos Global Dollar), 6 decimals — `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| **Randomness** | drand **evmnet** (`bls-bn254-unchained-on-g1`, 3s period), verified on-chain via BN254 pairing precompile (~500k gas incl. verification) |
| **Contracts** | `contracts/src/Grood.sol` + `DrandBeacon.sol` + vendored `BLS.sol`/`ModExp.sol` (kevincharm/bls-bn254, MIT) |
| **Keeper** | `services/keeper/` — fetches beacons, resolves rounds, serves the SSE feed. Trustless and optional: anyone can resolve |
| **Frontend** | Next.js + wagmi/viem + Privy, `app/` |
| **Explorer** | [robinhoodchain.blockscout.com](https://robinhoodchain.blockscout.com) |

## 🚀 Deploy

```bash
cd contracts
npm install
npx hardhat test                                  # includes REAL drand beacon signatures as fixtures
npx hardhat run scripts/probe-robinhood-precompiles.ts   # proves chain 4663 verifies drand beacons
PRIVATE_KEY=0x... npx hardhat run scripts/deploy-grood.ts --network robinhood-testnet
PRIVATE_KEY=0x... npx hardhat run scripts/deploy-grood.ts --network robinhood
```

Then set the deployed addresses in `app/.env.example` → `.env.local`, and run the keeper:

```bash
cd services/keeper
PRIVATE_KEY=0x... GROOD_ADDRESS=0x... npm start
```

## 📜 Lineage

Grood is a fork of [GridZero](https://github.com/penguinpecker/gridzero) (Base + Groth16/zkVerify). The zk-VRF stack was replaced with drand beacons verified directly on-chain — strictly stronger trust assumptions, dramatically less infrastructure. Legacy GridZero contracts (V1–V4), the circom/ezkl/risc0 zk stack, and the old services remain in-tree for reference and are not part of the build.

<p align="center">
  <strong>◇ ◈ DISTRIBUTED RANDOMNESS · FULL DEGEN ◈ ◇</strong><br/>
  <sub>Built with BLS pairings, bad decisions, and USDG you probably shouldn't be gambling.</sub>
</p>

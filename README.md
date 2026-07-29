<h1 align="center">◇ ◈ G R O O D ◈ ◇</h1>

<p align="center">
  <strong>A provably fair grid game on Robinhood Chain.</strong><br/>
  Stake ETH on a 5×5 grid. A distributed randomness beacon picks the winning
  cell. Winners split the pot in proportion to what they staked.
</p>

<p align="center">
  <a href="https://grood-five.vercel.app"><strong>▶ Play</strong></a> &nbsp;·&nbsp;
  <a href="https://robinhoodchain.blockscout.com/address/0xfd5160C3D0F5F022118aDbBEb386E1B67CD13274"><strong>◆ Contract</strong></a> &nbsp;·&nbsp;
  <a href="https://drand.love"><strong>⬡ drand</strong></a>
</p>

---

## How it works

Every **30 seconds** a round opens. You stake any amount of ETH — from
0.0001 upward — on any cells you like. When the round closes, one cell wins
and everyone on it splits the pot.

Two rules define the whole game:

1. **A cell wins with probability equal to its share of the pot.** Put in a
   quarter of the round's ETH and you have a one-in-four chance.
2. **The prize splits by stake.** Hold 25% of the winning cell, take 25% of
   the prize.

Together these mean every wei has the same expected value wherever you put
it — there is no cell that is secretly a better bet, and no way to seed dust
across the board to shade someone else's odds. The house takes 5%, and a
small tip pays whoever submits the randomness.

```
prize   = pot − 5% fee − resolver tip
your cut = prize × (your stake on the winning cell ÷ that cell's total)
```

Winners are paid **automatically** in the resolution transaction. There is no
claim step and no reward token — the pot is the whole game.

## Why the randomness can't be gamed

Grood uses [**drand**](https://drand.love) — a randomness beacon produced
every 3 seconds by the League of Entropy, a distributed group of independent
operators. No single participant can predict or withhold a beacon.

The important part is the timing. When a round opens, the contract writes down
the *number* of a beacon that **does not exist yet** and will only be
published about 10 seconds after betting closes. So while you're placing
stakes, the answer is not merely secret — it hasn't been created.

When that beacon appears, **anyone** can submit it. The contract verifies its
BLS signature itself, on-chain, against drand's public key. Each beacon round
has exactly one valid signature, so whoever submits it has no influence
whatsoever: they cannot grind alternatives, cannot choose a favourable one,
and cannot censor it, because anybody else can submit the identical bytes and
collect the tip.

Round end to winners paid: **about 3 seconds**, measured on-chain.

## Deployed contracts

Robinhood Chain mainnet (`4663`). All implementations are verified —
bytecode-identical to this source.

| Contract | Address |
|:---|:---|
| **Grood** (UUPS proxy) | [`0xfd5160C3D0F5F022118aDbBEb386E1B67CD13274`](https://robinhoodchain.blockscout.com/address/0xfd5160C3D0F5F022118aDbBEb386E1B67CD13274) |
| ↳ implementation | [`0x0D88848C3193024FD0E0e972F6D6b6898818f81A`](https://repo.sourcify.dev/4663/0x0D88848C3193024FD0E0e972F6D6b6898818f81A) |
| **DrandBeacon** (verifier) | [`0x73d7D306F5AE49a60c70C8Cf0331F1DA65E6cD2A`](https://robinhoodchain.blockscout.com/address/0x73d7D306F5AE49a60c70C8Cf0331F1DA65E6cD2A) |

The game sits behind a UUPS proxy, so fixes and improvements ship to the same
address without asking anyone to migrate.

## Parameters

| | Value | |
|:---|:---|:---|
| Round length | 30 s | owner-tunable, 10 s – 1 h |
| Beacon gap | 10 s | safety margin before the beacon exists; floor 8 s |
| Minimum stake | 0.0001 ETH | per *new* position; top-ups can be any size |
| Maximum stake | none | capital buys share, not better odds |
| Protocol fee | 5% | capped at 20% |
| Resolver tip | 0.00003 ETH | also capped at 10% of the pot |
| Stakers per cell | 100 | bounds the auto-pay loop; top-ups are free |

## Safety

The contract has been through two adversarial review passes. Highlights of
what's in place:

- **Solvency is an invariant.** Contract balance always covers the live
  round's stakes, outstanding refunds, escrowed winnings and unclaimed fees.
  Rounding dust is banked into fees so no wei is ever untracked.
- **The owner cannot touch player money.** `sweepSurplus` can only remove
  funds owed to nobody. `renounceOwnership` is disabled, since one accidental
  call would strand fees and destroy every recovery path.
- **Payment can't be blocked.** Winner transfers are gas-capped; a contract
  that rejects ETH gets its winnings escrowed and can pull them later, so one
  hostile receiver can't stall resolution.
- **Liveness has two backstops.** If drand misses a beacon, the owner may
  re-pin the round to a later one after 6 hours — deliberately owner-gated,
  because a permissionless re-pin would let a loser re-roll a published
  result. If the beacon never arrives, anyone can void the round after 30
  days (plus a 3-day grace) and every player reclaims exactly what they
  staked.

## Repository layout

```
contracts/
  src/
    GroodV3.sol            the live game
    drand/DrandBeacon.sol  on-chain BLS verification of drand beacons
    drand/BLS.sol          BN254 pairing helpers (kevincharm/bls-bn254, MIT)
  test/                    22 tests, using real drand signatures as fixtures
  scripts/                 deploy, upgrade, verification and smoke-test scripts
  legacy/                  original GridZero contracts, kept for provenance
services/keeper/           fetches beacons, resolves rounds, serves the live feed
app/                       Next.js frontend
```

## Running it

**Tests** — these verify real drand beacon signatures on a local EVM, so they
prove the cryptography, not a mock:

```bash
cd contracts && npm install && npx hardhat test
```

**Deploy** (testnet first; mainnet requires an explicit confirmation flag and
runs post-deploy assertions before it will report success):

```bash
PRIVATE_KEY=0x… npx hardhat run scripts/deploy-grood-v2.ts --network robinhood-testnet
PRIVATE_KEY=0x… CONFIRM_MAINNET=yes npx hardhat run scripts/deploy-grood-v2.ts --network robinhood
```

**Keeper** — resolves rounds and serves the live event feed. It holds no
special power: resolution is permissionless, so anyone can run one, and the
tip makes it self-funding.

```bash
cd services/keeper && npm install
PRIVATE_KEY=0x… GROOD_ADDRESS=0xfd51… CHAIN_ID=4663 \
  RPC_URL=https://rpc.mainnet.chain.robinhood.com npm start
```

**Frontend**:

```bash
cd app && npm install && cp .env.example .env.local   # then fill it in
npm run dev
```

## Lineage

Grood began as a fork of [GridZero](https://github.com/penguinpecker/gridzero),
which ran on Base and advertised Groth16 zero-knowledge proofs. In practice its
contract accepted an unverified random number from a single trusted server — the
proofs constrained nothing on-chain. Grood replaced that with drand beacons the
contract verifies itself, which is both a stronger guarantee and far less
machinery. The original contracts are preserved under `contracts/legacy/`.

---

<p align="center">
  <sub>Verifiable randomness, pro-rata payouts, and ETH you probably shouldn't be gambling.</sub>
</p>

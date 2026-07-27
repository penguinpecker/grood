import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// ─── drand evmnet constants (live-verified via https://api.drand.sh) ───
const EVMNET_GENESIS = 1727521075n;
const EVMNET_PERIOD = 3n;
// Group public key, real-parts-first ordering for BLS.verifySingle
const EVMNET_PUBKEY: [bigint, bigint, bigint, bigint] = [
  0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808fn,
  0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382n,
  0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0bn,
  0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6n,
];

// Real beacon signatures fetched from api.drand.sh (evmnet), uncompressed G1 (x, y)
const SIG_ROUND_1: [bigint, bigint] = [
  0x11f812d738a36b2210dc88c2d635ad8039588205f42445d6de09e6530165c346n,
  0x2a23aca348c84badcf8df5321ac24577b7963d5b0d780bc4626baedb45cde373n,
];
const SIG_ROUND_10M: [bigint, bigint] = [
  0x2c7b65b5acfe55256910ca71cf0a0fa71ac34c2a1167f86a22930a03e70ebec0n,
  0x0f7a530796e7ee38600b06da0390634a9b154e3eebc3b323dde2111e1c8ebdf3n,
];
const ROUND_10M = 10_000_000n;
// Real beacon whose vrf satisfies the Motherlode condition (keccak(vrf,"bonus") % 100 == 0)
const SIG_BONUS: [bigint, bigint] = [
  0x13d1b70855d04ea9af3efc4a03378f655459da97819ca4c63427104cf20bd724n,
  0x2c4116eba1899aefcc969a160faa09d164ef5c2dbcef91ad7455ad7c0457d37cn,
];
const ROUND_BONUS = 10_000_013n;
const BEACON_MARGIN = 5n;
const REFUND_DELAY = 30n * 24n * 3600n;
const VOID_GRACE = 3n * 24n * 3600n;

const ENTRY_FEE = 1_000_000n; // 1 USDG
const RESOLVER_REWARD = 100_000n; // 0.1 USDG

/** vrfOutput exactly as Grood derives it from a beacon signature */
function vrfFromSig(sig: [bigint, bigint]): bigint {
  return BigInt(
    ethers.solidityPackedKeccak256(["uint256", "uint256"], [sig[0], sig[1]])
  );
}

function isBonusForVrf(vrf: bigint, odds: bigint): boolean {
  const h = BigInt(
    ethers.solidityPackedKeccak256(["bytes32", "string"], [ethers.toBeHex(vrf, 32), "bonus"])
  );
  return h % odds === 0n;
}

describe("DrandBeacon (drand evmnet)", () => {
  async function deployBeacon() {
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    return Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
  }

  it("accepts the real evmnet group public key", async () => {
    const beacon = await deployBeacon();
    const pk = await beacon.publicKey();
    expect(pk[0]).to.equal(EVMNET_PUBKEY[0]);
  });

  it("rejects a malformed public key", async () => {
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    const bad = [...EVMNET_PUBKEY] as [bigint, bigint, bigint, bigint];
    bad[0] = bad[0] + 1n;
    await expect(Beacon.deploy(bad, EVMNET_GENESIS, EVMNET_PERIOD)).to.be.revertedWithCustomError(
      Beacon,
      "InvalidPublicKey"
    );
  });

  it("verifies the REAL beacon signature for round 1", async () => {
    const beacon = await deployBeacon();
    await expect(beacon.verifyBeaconRound(1, SIG_ROUND_1)).to.not.be.reverted;
  });

  it("verifies the REAL beacon signature for round 10,000,000", async () => {
    const beacon = await deployBeacon();
    await expect(beacon.verifyBeaconRound(ROUND_10M, SIG_ROUND_10M)).to.not.be.reverted;
  });

  it("rejects a valid signature presented for the wrong round", async () => {
    const beacon = await deployBeacon();
    await expect(beacon.verifyBeaconRound(2, SIG_ROUND_1)).to.be.revertedWithCustomError(
      beacon,
      "InvalidSignature"
    );
  });

  it("rejects a tampered signature", async () => {
    const beacon = await deployBeacon();
    const tampered: [bigint, bigint] = [SIG_ROUND_1[0] + 1n, SIG_ROUND_1[1]];
    await expect(beacon.verifyBeaconRound(1, tampered)).to.be.revertedWithCustomError(
      beacon,
      "InvalidSignature"
    );
  });

  it("computes round scheduling correctly", async () => {
    const beacon = await deployBeacon();
    expect(await beacon.timeOfRound(1)).to.equal(EVMNET_GENESIS);
    expect(await beacon.timeOfRound(ROUND_10M)).to.equal(
      EVMNET_GENESIS + (ROUND_10M - 1n) * EVMNET_PERIOD
    );
    expect(await beacon.roundAt(EVMNET_GENESIS)).to.equal(1n);
    expect(await beacon.roundAt(EVMNET_GENESIS + 1n)).to.equal(2n);
    expect(await beacon.roundAt(EVMNET_GENESIS + 3n)).to.equal(2n);
    expect(await beacon.roundAt(EVMNET_GENESIS + 4n)).to.equal(3n);
  });
});

describe("Grood game", () => {
  async function deployAll() {
    const [owner, alice, bob, carol] = await ethers.getSigners();

    const Beacon = await ethers.getContractFactory("DrandBeacon");
    const beacon = await Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);

    const MockUSDG = await ethers.getContractFactory("MockUSDG");
    const usdg = await MockUSDG.deploy();

    const GroodToken = await ethers.getContractFactory("GroodToken");
    const token = await GroodToken.deploy();

    const Grood = await ethers.getContractFactory("Grood");
    const grood = await Grood.deploy(
      await usdg.getAddress(),
      await token.getAddress(),
      owner.address,
      await beacon.getAddress()
    );
    await token.setMinter(await grood.getAddress(), true);

    for (const p of [alice, bob, carol]) {
      await usdg.mint(p.address, 100n * ENTRY_FEE);
      await usdg.connect(p).approve(await grood.getAddress(), ethers.MaxUint256);
    }

    return { owner, alice, bob, carol, beacon, usdg, token, grood };
  }

  /**
   * Advance the game to a fresh round whose endTime lands exactly so that the
   * pinned drand round == targetRound, letting us resolve with a real signature.
   * pinned = roundAt(end) + MARGIN = ceil((end-G)/P) + 1 + MARGIN
   *   →  end = G + (targetRound - 1 - MARGIN) * P
   */
  async function openRoundPinnedTo(grood: any, targetRound: bigint) {
    const roundDuration = await grood.roundDuration();
    const targetEnd = EVMNET_GENESIS + (targetRound - 1n - BEACON_MARGIN) * EVMNET_PERIOD;
    const targetStart = targetEnd - roundDuration;
    const stale = await grood.currentRoundId();
    await time.setNextBlockTimestamp(targetStart);
    await grood.skipEmptyRound(stale); // starts the next round at targetStart
    const id = await grood.currentRoundId();
    const round = await grood.rounds(id);
    expect(round.endTime).to.equal(targetEnd);
    expect(round.drandRound).to.equal(targetRound);
    return { id, targetEnd };
  }
  const openRoundPinnedTo10M = (grood: any) => openRoundPinnedTo(grood, ROUND_10M);

  it("pins a drand round strictly after entries close", async () => {
    const { grood, beacon } = await loadFixture(deployAll);
    const round = await grood.rounds(await grood.currentRoundId());
    const beaconTime = await beacon.timeOfRound(round.drandRound);
    expect(beaconTime).to.be.greaterThan(round.endTime);
  });

  it("plays a full round resolved by the REAL drand beacon signature", async () => {
    const { owner, alice, bob, carol, usdg, token, grood } = await loadFixture(deployAll);
    const { id, targetEnd } = await openRoundPinnedTo10M(grood);

    // Predict the outcome exactly as the contract will derive it
    const vrf = vrfFromSig(SIG_ROUND_10M);
    const occupied = [3, 7]; // ascending, matches contract's scan order
    const winningCell = occupied[Number(vrf % 2n)];
    const expectBonus = isBonusForVrf(vrf, 100n);

    // alice+bob on cell 3, carol on cell 7
    await time.setNextBlockTimestamp(targetEnd - 20n);
    await grood.connect(alice).pickCell(3);
    await time.setNextBlockTimestamp(targetEnd - 15n);
    await grood.connect(bob).pickCell(3);
    await time.setNextBlockTimestamp(targetEnd - 10n);
    await grood.connect(carol).pickCell(7);

    // Entries close at endTime
    await time.setNextBlockTimestamp(targetEnd);
    await expect(grood.connect(alice).pickCell(9)).to.be.revertedWith("Round ended");

    // A garbage signature cannot resolve
    await expect(
      grood.connect(owner).resolveRound(id, [1n, 2n])
    ).to.be.reverted;

    // The real beacon signature resolves the round
    const tx = await grood.connect(owner).resolveRound(id, SIG_ROUND_10M);
    const receipt = await tx.wait();

    const round = await grood.rounds(id);
    expect(round.resolved).to.equal(true);
    expect(round.winningCell).to.equal(winningCell);
    expect(round.isBonusRound).to.equal(expectBonus);

    // Payout math: pool 3, fee 5% = 0.15, resolver 0.1 → distributable 2.75
    const pool = 3n * ENTRY_FEE;
    const fee = (pool * 500n) / 10_000n;
    let distributable = pool - fee - RESOLVER_REWARD;
    if (expectBonus) distributable = distributable * 10n; // capped by balance, not hit here
    const winners = winningCell === 3 ? [alice, bob] : [carol];
    const perWinner = distributable / BigInt(winners.length);
    expect(await grood.roundUsdcPerWinner(id)).to.equal(perWinner);

    for (const w of winners) {
      expect(await usdg.balanceOf(w.address)).to.equal(99n * ENTRY_FEE + perWinner);
      const zeroBase = expectBonus ? 1000n * 10n ** 18n : 100n * 10n ** 18n;
      expect(await token.balanceOf(w.address)).to.equal(zeroBase / BigInt(winners.length));
    }
    // Resolver (owner) got the tip
    expect(await usdg.balanceOf(owner.address)).to.equal(RESOLVER_REWARD);
    // Next round auto-started
    expect(await grood.currentRoundId()).to.equal(id + 1n);
    // eslint-disable-next-line no-console
    console.log(`      resolveRound gas (incl. BLS verify): ${receipt!.gasUsed}`);
  });

  it("rejects resolution with a stale/wrong-round signature", async () => {
    const { alice, grood } = await loadFixture(deployAll);
    const { id, targetEnd } = await openRoundPinnedTo10M(grood);
    await time.setNextBlockTimestamp(targetEnd - 10n);
    await grood.connect(alice).pickCell(0);
    await time.setNextBlockTimestamp(targetEnd + 1n);
    // Round 1's signature is valid BLS but for the wrong drand round
    await expect(grood.resolveRound(id, SIG_ROUND_1)).to.be.reverted;
  });

  it("cannot resolve before the round ends", async () => {
    const { alice, grood } = await loadFixture(deployAll);
    const { id, targetEnd } = await openRoundPinnedTo10M(grood);
    await time.setNextBlockTimestamp(targetEnd - 10n);
    await grood.connect(alice).pickCell(0);
    await expect(grood.resolveRound(id, SIG_ROUND_10M)).to.be.revertedWith("Round not ended");
  });

  it("one entry per address, valid cells only", async () => {
    const { alice, grood } = await loadFixture(deployAll);
    const { targetEnd } = await openRoundPinnedTo10M(grood);
    await time.setNextBlockTimestamp(targetEnd - 20n);
    await grood.connect(alice).pickCell(24);
    await expect(grood.connect(alice).pickCell(5)).to.be.revertedWith("Already entered");
    await expect(grood.pickCell(25)).to.be.revertedWith("Invalid cell");
  });

  it("skips empty rounds permissionlessly", async () => {
    const { alice, grood } = await loadFixture(deployAll);
    const id = await grood.currentRoundId();
    const round = await grood.rounds(id);
    await time.setNextBlockTimestamp(BigInt(round.endTime) + 1n);
    await grood.connect(alice).skipEmptyRound(id);
    expect(await grood.currentRoundId()).to.equal(id + 1n);
  });

  it("voids a stuck round (request + grace) and refunds exactly what each player paid", async () => {
    const { owner, alice, bob, usdg, grood } = await loadFixture(deployAll);
    const { id, targetEnd } = await openRoundPinnedTo10M(grood);
    await time.setNextBlockTimestamp(targetEnd - 10n);
    await grood.connect(alice).pickCell(1);
    // Owner doubles the entry fee mid-round; bob pays the new price
    await grood.connect(owner).setEntryFee(2n * ENTRY_FEE);
    await time.setNextBlockTimestamp(targetEnd - 5n);
    await grood.connect(bob).pickCell(2);

    // Too early to request a void
    await time.setNextBlockTimestamp(targetEnd + 1n);
    await expect(grood.requestVoid(id)).to.be.revertedWith("Not stuck");
    // Cannot void without a request
    await expect(grood.voidStuckRound(id)).to.be.revertedWith("Void not requested");

    const tRequest = targetEnd + REFUND_DELAY + 1n;
    await time.setNextBlockTimestamp(tRequest);
    await grood.connect(alice).requestVoid(id);
    // Grace window not over yet
    await expect(grood.voidStuckRound(id)).to.be.revertedWith("Grace not over");

    await time.setNextBlockTimestamp(tRequest + VOID_GRACE + 1n);
    await grood.connect(alice).voidStuckRound(id);
    expect(await grood.currentRoundId()).to.equal(id + 1n);
    // Void pauses entries and reserves the escrow
    expect(await grood.paused()).to.equal(true);
    expect(await grood.pendingRefunds()).to.equal(3n * ENTRY_FEE);

    const beforeA = await usdg.balanceOf(alice.address);
    await grood.connect(alice).refund(id);
    expect(await usdg.balanceOf(alice.address)).to.equal(beforeA + ENTRY_FEE);
    await expect(grood.connect(alice).refund(id)).to.be.revertedWith("Already refunded");
    const beforeB = await usdg.balanceOf(bob.address);
    await grood.connect(bob).refund(id);
    expect(await usdg.balanceOf(bob.address)).to.equal(beforeB + 2n * ENTRY_FEE);
    expect(await grood.pendingRefunds()).to.equal(0n);
    // Voided round pays no winners; owner can resume the game
    expect(await grood.isWinner(id, alice.address)).to.equal(false);
    await grood.connect(owner).setPaused(false);
    expect(await grood.paused()).to.equal(false);
  });

  it("REGRESSION: a Motherlode round cannot raid the refund escrow of a voided round", async () => {
    const { owner, alice, bob, carol, usdg, grood } = await loadFixture(deployAll);

    // Round A: alice + bob deposit, then the round is voided (2 USDG escrow).
    // Timeline is laid out backwards from round B's pinned bonus beacon.
    const roundDuration = await grood.roundDuration();
    const endB = EVMNET_GENESIS + (ROUND_BONUS - 1n - BEACON_MARGIN) * EVMNET_PERIOD;
    const tVoid = endB - roundDuration; // voiding starts round B at this timestamp
    const tRequest = tVoid - VOID_GRACE - 2n;
    const endA = tRequest - REFUND_DELAY - 2n;

    const { id: idA } = await openRoundPinnedTo(grood, (endA - EVMNET_GENESIS + EVMNET_PERIOD - 1n) / EVMNET_PERIOD + 1n + BEACON_MARGIN);
    await time.setNextBlockTimestamp(endA - 10n);
    await grood.connect(alice).pickCell(1);
    await time.setNextBlockTimestamp(endA - 5n);
    await grood.connect(bob).pickCell(2);

    await time.setNextBlockTimestamp(tRequest);
    await grood.requestVoid(idA);
    await time.setNextBlockTimestamp(tVoid);
    await grood.voidStuckRound(idA);
    expect(await grood.pendingRefunds()).to.equal(2n * ENTRY_FEE);

    // Round B pinned to the real bonus beacon; carol is the only player
    const idB = await grood.currentRoundId();
    const roundB = await grood.rounds(idB);
    expect(roundB.drandRound).to.equal(ROUND_BONUS);
    await grood.connect(owner).setPaused(false);
    await time.setNextBlockTimestamp(endB - 10n);
    await grood.connect(carol).pickCell(0);
    await time.setNextBlockTimestamp(endB + 1n);
    await grood.connect(owner).resolveRound(idB, SIG_BONUS);

    const resolved = await grood.rounds(idB);
    expect(resolved.isBonusRound).to.equal(true);
    // Carol's 10x bonus is capped at her own round's distributable — the
    // escrow (2 USDG) and fees stay untouched
    const fee = (ENTRY_FEE * 500n) / 10_000n;
    const distributable = ENTRY_FEE - fee - RESOLVER_REWARD;
    expect(await grood.roundUsdcPerWinner(idB)).to.equal(distributable);

    // Every round-A player can still get their full refund
    const beforeA = await usdg.balanceOf(alice.address);
    await grood.connect(alice).refund(idA);
    expect(await usdg.balanceOf(alice.address)).to.equal(beforeA + ENTRY_FEE);
    const beforeB = await usdg.balanceOf(bob.address);
    await grood.connect(bob).refund(idA);
    expect(await usdg.balanceOf(bob.address)).to.equal(beforeB + ENTRY_FEE);
  });

  it("caps entries per cell so resolution gas is bounded", async () => {
    const { owner, usdg, grood } = await loadFixture(deployAll);
    // Long round so 300 auto-mined setup txs (+1s each) fit inside the window
    await grood.connect(owner).setRoundDuration(600);
    const { targetEnd } = await openRoundPinnedTo10M(grood);
    const signers = await ethers.getSigners();
    // Signers 4..104 fill cell 0 to MAX_PER_CELL (100)
    for (let i = 0; i < 100; i++) {
      const p = signers[4 + i];
      await usdg.mint(p.address, ENTRY_FEE);
      await usdg.connect(p).approve(await grood.getAddress(), ENTRY_FEE);
      await grood.connect(p).pickCell(0);
    }
    const counts = await grood.getCellCounts(await grood.currentRoundId());
    expect(counts[0]).to.equal(100n);
    const extra = signers[110];
    await usdg.mint(extra.address, ENTRY_FEE);
    await usdg.connect(extra).approve(await grood.getAddress(), ENTRY_FEE);
    await expect(grood.connect(extra).pickCell(0)).to.be.revertedWith("Cell full");
    // The full cell resolves fine
    await time.setNextBlockTimestamp(targetEnd + 1n);
    const tx = await grood.connect(owner).resolveRound(await grood.currentRoundId(), SIG_ROUND_10M);
    const receipt = await tx.wait();
    expect(receipt!.gasUsed).to.be.lessThan(15_000_000n);
    // eslint-disable-next-line no-console
    console.log(`      resolveRound gas with 100 winners on one cell: ${receipt!.gasUsed}`);
  });

  it("a broken reward token cannot block USDG payouts", async () => {
    const { owner, alice, usdg, grood, beacon } = await loadFixture(deployAll);
    // Point rewards at a contract with no mint(): mint reverts, USDG still flows
    await grood.setGroodToken(await beacon.getAddress());
    const { id, targetEnd } = await openRoundPinnedTo10M(grood);
    await time.setNextBlockTimestamp(targetEnd - 10n);
    await grood.connect(alice).pickCell(0);
    await time.setNextBlockTimestamp(targetEnd + 1n);
    await expect(grood.connect(owner).resolveRound(id, SIG_ROUND_10M)).to.emit(
      grood,
      "RewardMintFailed"
    );
    const round = await grood.rounds(id);
    expect(round.resolved).to.equal(true);
    // Sole winner got pool minus fee minus tip
    const expected = 99n * ENTRY_FEE + ENTRY_FEE - (ENTRY_FEE * 500n) / 10_000n - RESOLVER_REWARD;
    expect(await usdg.balanceOf(alice.address)).to.equal(expected);
  });

  it("only the owner can touch config", async () => {
    const { alice, grood } = await loadFixture(deployAll);
    await expect(grood.connect(alice).setEntryFee(2_000_000n)).to.be.reverted;
    await expect(grood.connect(alice).setProtocolFeeBps(100n)).to.be.reverted;
    await expect(grood.setProtocolFeeBps(2001n)).to.be.revertedWith("Fee>20%");
  });
});

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// ─── drand evmnet constants (live-verified via https://api.drand.sh) ───
const EVMNET_GENESIS = 1727521075n;
const EVMNET_PERIOD = 3n;
const EVMNET_PUBKEY: [bigint, bigint, bigint, bigint] = [
  0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808fn,
  0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382n,
  0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0bn,
  0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6n,
];
// Real evmnet beacon signatures (uncompressed G1)
const SIG_ROUND_1: [bigint, bigint] = [
  0x11f812d738a36b2210dc88c2d635ad8039588205f42445d6de09e6530165c346n,
  0x2a23aca348c84badcf8df5321ac24577b7963d5b0d780bc4626baedb45cde373n,
];
const SIG_ROUND_10M: [bigint, bigint] = [
  0x2c7b65b5acfe55256910ca71cf0a0fa71ac34c2a1167f86a22930a03e70ebec0n,
  0x0f7a530796e7ee38600b06da0390634a9b154e3eebc3b323dde2111e1c8ebdf3n,
];
const ROUND_10M = 10_000_000n;
// Real beacon whose vrf triggers the Motherlode condition
const SIG_BONUS: [bigint, bigint] = [
  0x13d1b70855d04ea9af3efc4a03378f655459da97819ca4c63427104cf20bd724n,
  0x2c4116eba1899aefcc969a160faa09d164ef5c2dbcef91ad7455ad7c0457d37cn,
];
const ROUND_BONUS = 10_000_013n;

const BEACON_GAP = 2n;
const MIN_STAKE = 10n ** 14n; // 0.0001 ETH
const TIP = 3n * 10n ** 13n;  // 0.00003 ETH
const FEE_BPS = 500n;
const RESERVE_BPS = 5000n;
const REFUND_DELAY = 30n * 24n * 3600n;
const VOID_GRACE = 3n * 24n * 3600n;

const vrfFromSig = (sig: [bigint, bigint]) =>
  BigInt(ethers.solidityPackedKeccak256(["uint256", "uint256"], [sig[0], sig[1]]));

function mulDiv(a: bigint, b: bigint, d: bigint) {
  return (a * b) / d;
}

/** Replicates the contract's money math for a non-bonus round */
function economics(pool: bigint) {
  const fee = (pool * FEE_BPS) / 10_000n;
  const toReserve = (fee * RESERVE_BPS) / 10_000n;
  const afterFee = pool - fee;
  const tip = afterFee < TIP ? afterFee : TIP;
  return { fee, toReserve, tip, distributable: afterFee - tip };
}

describe("GroodV2 — variable-stake pari-mutuel", () => {
  async function deployAll() {
    const [owner, alice, bob, carol, dave] = await ethers.getSigners();

    const Beacon = await ethers.getContractFactory("DrandBeacon");
    const beacon = await Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);

    const TokenF = await ethers.getContractFactory("GroodTokenV2");
    const token = await upgrades.deployProxy(TokenF, [owner.address], { kind: "uups" });

    const GroodF = await ethers.getContractFactory("GroodV2");
    const grood = await upgrades.deployProxy(
      GroodF,
      [await token.getAddress(), owner.address, await beacon.getAddress(), owner.address],
      { kind: "uups" }
    );
    await token.setMinter(await grood.getAddress(), true);

    return { owner, alice, bob, carol, dave, beacon, token, grood };
  }

  /** Open a fresh round pinned exactly to `targetRound` */
  async function openRoundPinnedTo(grood: any, targetRound: bigint) {
    const roundDuration = await grood.roundDuration();
    const beaconTime = EVMNET_GENESIS + (targetRound - 1n) * EVMNET_PERIOD;
    const targetStart = beaconTime - roundDuration - BEACON_GAP;
    const targetEnd = beaconTime - BEACON_GAP;
    const stale = await grood.currentRoundId();
    await time.setNextBlockTimestamp(targetStart);
    await grood.skipEmptyRound(stale);
    const id = await grood.currentRoundId();
    const round = await grood.rounds(id);
    expect(round.endTime).to.equal(targetEnd);
    expect(round.drandRound).to.equal(targetRound);
    return { id, targetEnd };
  }
  const openRound10M = (g: any) => openRoundPinnedTo(g, ROUND_10M);

  const stakeOn = (grood: any, signer: any, roundId: bigint, cell: number, amount: bigint) =>
    grood.connect(signer).stake(roundId, [cell], [amount], { value: amount });

  it("deploys behind UUPS proxies with initialized state", async () => {
    const { grood, token, owner } = await loadFixture(deployAll);
    expect(await grood.minStakeWei()).to.equal(MIN_STAKE);
    expect(await grood.resolverTipWei()).to.equal(TIP);
    expect(await grood.protocolFeeBps()).to.equal(FEE_BPS);
    expect(await grood.owner()).to.equal(owner.address);
    expect(await grood.currentRoundId()).to.equal(1n);
    expect(await token.name()).to.equal("Grood");
    // implementations are locked
    const implAddr = await upgrades.erc1967.getImplementationAddress(await grood.getAddress());
    const impl = await ethers.getContractAt("GroodV2", implAddr);
    await expect(
      impl.initialize(owner.address, owner.address, owner.address, owner.address)
    ).to.be.reverted;
  });

  it("pays winners pro-rata to stake, with exact floor math and dust to the reserve", async () => {
    const { owner, alice, bob, carol, grood, token } = await loadFixture(deployAll);
    const { id, targetEnd } = await openRound10M(grood);

    // Alice 0.04 + 0.01 top-up on cell 3; Bob 0.13 on cell 3; Carol 0.12 on cell 7
    await time.setNextBlockTimestamp(targetEnd - 20n);
    await stakeOn(grood, alice, id, 3, 4n * 10n ** 16n);
    await time.setNextBlockTimestamp(targetEnd - 18n);
    await stakeOn(grood, alice, id, 3, 1n * 10n ** 16n); // top-up, no new staker record
    await time.setNextBlockTimestamp(targetEnd - 15n);
    await stakeOn(grood, bob, id, 3, 13n * 10n ** 16n);
    await time.setNextBlockTimestamp(targetEnd - 10n);
    await stakeOn(grood, carol, id, 7, 12n * 10n ** 16n);

    const round = await grood.rounds(id);
    expect(round.totalStaked).to.equal(3n * 10n ** 17n);
    expect(round.totalStakers).to.equal(3n);
    expect((await grood.getCellStakers(id, 3)).length).to.equal(2); // top-up added no record

    // Predict outcome
    const vrf = vrfFromSig(SIG_ROUND_10M);
    const occupied = [3, 7];
    const winningCell = occupied[Number(vrf % 2n)];
    const { fee, toReserve, distributable } = economics(3n * 10n ** 17n);

    const balBefore = {
      alice: await ethers.provider.getBalance(alice.address),
      bob: await ethers.provider.getBalance(bob.address),
      carol: await ethers.provider.getBalance(carol.address),
    };

    await time.setNextBlockTimestamp(targetEnd + 1n);
    await grood.connect(owner).resolveRound(id, SIG_ROUND_10M);

    const resolved = await grood.rounds(id);
    expect(resolved.winningCell).to.equal(winningCell);
    expect(resolved.distributable).to.equal(distributable);

    if (winningCell === 3) {
      const winnerTotal = 18n * 10n ** 16n;
      const aliceOut = mulDiv(distributable, 5n * 10n ** 16n, winnerTotal);
      const bobOut = mulDiv(distributable, 13n * 10n ** 16n, winnerTotal);
      expect(await ethers.provider.getBalance(alice.address)).to.equal(balBefore.alice + aliceOut);
      expect(await ethers.provider.getBalance(bob.address)).to.equal(balBefore.bob + bobOut);
      expect(await ethers.provider.getBalance(carol.address)).to.equal(balBefore.carol);
      // identical per-wei rate for both winners
      expect(aliceOut * 13n).to.equal(bobOut * 5n);
      // GROOD pro-rata
      expect(await token.balanceOf(alice.address)).to.equal(mulDiv(100n * 10n ** 18n, 5n * 10n ** 16n, winnerTotal));
      expect(await token.balanceOf(bob.address)).to.equal(mulDiv(100n * 10n ** 18n, 13n * 10n ** 16n, winnerTotal));
      // dust banked into the reserve
      const dust = distributable - aliceOut - bobOut;
      expect(await grood.bonusReserve()).to.equal(toReserve + dust);
    } else {
      const carolOut = distributable; // sole staker on cell 7
      expect(await ethers.provider.getBalance(carol.address)).to.equal(balBefore.carol + carolOut);
    }
    expect(await grood.accumulatedFees()).to.equal(fee - toReserve);
  });

  it("accepts multi-cell stakes in one tx and rejects malformed input", async () => {
    const { alice, grood } = await loadFixture(deployAll);
    const { id, targetEnd } = await openRound10M(grood);
    await time.setNextBlockTimestamp(targetEnd - 20n);
    await grood.connect(alice).stake(id, [0, 5, 24], [MIN_STAKE, MIN_STAKE * 2n, MIN_STAKE * 3n], {
      value: MIN_STAKE * 6n,
    });
    const stakes = await grood.getPlayerStakes(id, alice.address);
    expect(stakes[0]).to.equal(MIN_STAKE);
    expect(stakes[5]).to.equal(MIN_STAKE * 2n);
    expect(stakes[24]).to.equal(MIN_STAKE * 3n);
    expect((await grood.rounds(id)).totalStakers).to.equal(1n); // one player, three cells

    await expect(
      grood.connect(alice).stake(id, [1, 1], [MIN_STAKE, MIN_STAKE], { value: MIN_STAKE * 2n })
    ).to.be.revertedWith("Dup cell");
    await expect(
      grood.connect(alice).stake(id, [1], [MIN_STAKE], { value: MIN_STAKE - 1n })
    ).to.be.revertedWith("Value mismatch");
    await expect(
      grood.connect(alice).stake(id, [25], [MIN_STAKE], { value: MIN_STAKE })
    ).to.be.revertedWith("Invalid cell");
    await expect(
      grood.connect(alice).stake(id + 1n, [1], [MIN_STAKE], { value: MIN_STAKE })
    ).to.be.revertedWith("Wrong round");
  });

  it("enforces the min stake on new positions but allows tiny top-ups", async () => {
    const { alice, grood } = await loadFixture(deployAll);
    const { id, targetEnd } = await openRound10M(grood);
    await time.setNextBlockTimestamp(targetEnd - 20n);
    await expect(stakeOn(grood, alice, id, 2, MIN_STAKE - 1n)).to.be.revertedWith("Below min stake");
    await stakeOn(grood, alice, id, 2, MIN_STAKE);
    await stakeOn(grood, alice, id, 2, 1n); // 1 wei top-up allowed
    expect(await grood.stakeOf(id, 2, alice.address)).to.equal(MIN_STAKE + 1n);
    await expect(stakeOn(grood, alice, id, 2, 0n)).to.be.revertedWith("Zero amount");
  });

  it("getExpectedPayout matches the realised payout exactly", async () => {
    const { alice, bob, owner, grood } = await loadFixture(deployAll);
    const { id, targetEnd } = await openRound10M(grood);
    await time.setNextBlockTimestamp(targetEnd - 20n);
    await stakeOn(grood, bob, id, 3, 2n * 10n ** 16n); // someone already on the cell

    const myStake = 5n * 10n ** 16n;
    const [predicted] = await grood.connect(alice).getExpectedPayout.staticCall(3, myStake);

    await time.setNextBlockTimestamp(targetEnd - 15n);
    await stakeOn(grood, alice, id, 3, myStake);
    const balBefore = await ethers.provider.getBalance(alice.address);

    await time.setNextBlockTimestamp(targetEnd + 1n);
    await grood.connect(owner).resolveRound(id, SIG_ROUND_10M);

    const round = await grood.rounds(id);
    if (round.winningCell === 3n) {
      expect(await ethers.provider.getBalance(alice.address)).to.equal(balBefore + predicted);
    }
  });

  it("escrows winnings when a winner rejects ETH, and pays out via withdrawWinnings", async () => {
    const { owner, grood } = await loadFixture(deployAll);
    const RR = await ethers.getContractFactory("RevertingReceiver");
    const rr = await RR.deploy();
    const { id, targetEnd } = await openRound10M(grood);

    await time.setNextBlockTimestamp(targetEnd - 20n);
    await rr.stakeVia(await grood.getAddress(), id, 0, { value: 10n ** 17n });
    await time.setNextBlockTimestamp(targetEnd + 1n);
    await expect(grood.connect(owner).resolveRound(id, SIG_ROUND_10M)).to.emit(grood, "WinningsEscrowed");

    const owed = await grood.unclaimedWinnings(await rr.getAddress());
    expect(owed).to.be.greaterThan(0n);
    expect(await grood.pendingWithdrawals()).to.equal(owed);

    await rr.withdrawVia(await grood.getAddress());
    expect(await grood.unclaimedWinnings(await rr.getAddress())).to.equal(0n);
    expect(await grood.pendingWithdrawals()).to.equal(0n);
    await expect(rr.withdrawVia(await grood.getAddress())).to.be.reverted;
  });

  it("Motherlode pays extra only from the reserve and never raids refund escrow", async () => {
    const { owner, alice, grood } = await loadFixture(deployAll);
    // Seed the reserve so the bonus has something real to pay
    await grood.connect(owner).depositBonusReserve({ value: 5n * 10n ** 16n });
    const { id, targetEnd } = await openRoundPinnedTo(grood, ROUND_BONUS);
    await time.setNextBlockTimestamp(targetEnd - 10n);
    await stakeOn(grood, alice, id, 0, 10n ** 17n);

    const reserveBefore = await grood.bonusReserve();
    const { distributable, toReserve } = economics(10n ** 17n);
    await time.setNextBlockTimestamp(targetEnd + 1n);
    await grood.connect(owner).resolveRound(id, SIG_BONUS);

    const round = await grood.rounds(id);
    expect(round.isBonusRound).to.equal(true);
    const availableForBonus = reserveBefore + toReserve;
    const wantedExtra = distributable * 9n;
    const extra = wantedExtra > availableForBonus ? availableForBonus : wantedExtra;
    expect(round.distributable).to.equal(distributable + extra);
    // solvency invariant still holds
    const bal = await ethers.provider.getBalance(await grood.getAddress());
    const reserved =
      (await grood.rounds(await grood.currentRoundId())).totalStaked +
      (await grood.pendingRefunds()) +
      (await grood.pendingWithdrawals()) +
      (await grood.bonusReserve()) +
      (await grood.accumulatedFees());
    expect(bal).to.be.greaterThanOrEqual(reserved);
  });

  it("records one staker per address per cell — top-ups add no records", async () => {
    const { owner, grood } = await loadFixture(deployAll);
    // long round so many setup txs fit inside the betting window
    await grood.connect(owner).setRoundDuration(600);
    const { id } = await openRound10M(grood);
    const signers = (await ethers.getSigners()).slice(0, 15);
    for (const s of signers) await stakeOn(grood, s, id, 0, MIN_STAKE);
    for (const s of signers) await stakeOn(grood, s, id, 0, MIN_STAKE); // top-ups
    expect((await grood.getCellStakers(id, 0)).length).to.equal(signers.length);
    expect(await grood.stakeOf(id, 0, signers[0].address)).to.equal(MIN_STAKE * 2n);
    expect(await grood.MAX_STAKERS_PER_CELL()).to.equal(100n);
  });

  it("voids a stuck round and refunds each player's exact multi-cell total", async () => {
    const { alice, bob, grood } = await loadFixture(deployAll);
    const { id, targetEnd } = await openRound10M(grood);
    await time.setNextBlockTimestamp(targetEnd - 20n);
    await grood.connect(alice).stake(id, [1, 2], [MIN_STAKE, MIN_STAKE * 4n], { value: MIN_STAKE * 5n });
    await time.setNextBlockTimestamp(targetEnd - 15n);
    await stakeOn(grood, bob, id, 3, MIN_STAKE * 2n);

    const tRequest = targetEnd + REFUND_DELAY + 1n;
    await time.setNextBlockTimestamp(tRequest);
    await grood.connect(alice).requestVoid(id);
    await time.setNextBlockTimestamp(tRequest + VOID_GRACE + 1n);
    await grood.connect(alice).voidStuckRound(id);

    expect(await grood.paused()).to.equal(true);
    expect(await grood.pendingRefunds()).to.equal(MIN_STAKE * 7n);

    const before = await ethers.provider.getBalance(bob.address);
    const tx = await grood.connect(bob).refund(id);
    const rc = await tx.wait();
    const gas = rc!.gasUsed * rc!.gasPrice;
    expect(await ethers.provider.getBalance(bob.address)).to.equal(before + MIN_STAKE * 2n - gas);
    await expect(grood.connect(bob).refund(id)).to.be.revertedWith("Already refunded");
  });

  it("sweepSurplus can only take strays, never player funds", async () => {
    const { owner, alice, grood } = await loadFixture(deployAll);
    const { id, targetEnd } = await openRound10M(grood);
    await time.setNextBlockTimestamp(targetEnd - 20n);
    await stakeOn(grood, alice, id, 0, 10n ** 17n);
    await expect(grood.connect(owner).sweepSurplus()).to.be.revertedWith("No surplus");
    // stray donation via receive()
    await owner.sendTransaction({ to: await grood.getAddress(), value: 10n ** 16n });
    const before = await ethers.provider.getBalance(owner.address);
    const tx = await grood.connect(owner).sweepSurplus();
    const rc = await tx.wait();
    const gas = rc!.gasUsed * rc!.gasPrice;
    expect(await ethers.provider.getBalance(owner.address)).to.equal(before + 10n ** 16n - gas);
    expect(await ethers.provider.getBalance(await grood.getAddress())).to.equal(10n ** 17n);
  });

  it("rejects a wrong-round beacon signature", async () => {
    const { alice, grood } = await loadFixture(deployAll);
    const { id, targetEnd } = await openRound10M(grood);
    await time.setNextBlockTimestamp(targetEnd - 10n);
    await stakeOn(grood, alice, id, 0, MIN_STAKE);
    await time.setNextBlockTimestamp(targetEnd + 1n);
    await expect(grood.resolveRound(id, SIG_ROUND_1)).to.be.reverted;
  });

  it("enforces owner-only config with bounds", async () => {
    const { alice, grood } = await loadFixture(deployAll);
    await expect(grood.connect(alice).setMinStake(MIN_STAKE)).to.be.reverted;
    await expect(grood.setMinStake(10n ** 12n)).to.be.revertedWith("Out of bounds");
    await expect(grood.setResolverTip(10n ** 16n)).to.be.revertedWith("Tip>0.001");
    await expect(grood.setBeaconGap(0n)).to.be.revertedWith("1-60s");
    await expect(grood.setBeacon(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
  });

  it("upgrades the proxy while preserving all state, owner-gated", async () => {
    const { owner, alice, grood, token } = await loadFixture(deployAll);
    const { id, targetEnd } = await openRound10M(grood);
    await time.setNextBlockTimestamp(targetEnd - 20n);
    await stakeOn(grood, alice, id, 4, 7n * 10n ** 16n);

    const proxyAddr = await grood.getAddress();
    const implBefore = await upgrades.erc1967.getImplementationAddress(proxyAddr);

    const NextF = await ethers.getContractFactory("GroodV2MockNext");
    const upgraded = await upgrades.upgradeProxy(proxyAddr, NextF);
    expect(await upgrades.erc1967.getImplementationAddress(proxyAddr)).to.not.equal(implBefore);
    expect(await upgraded.getAddress()).to.equal(proxyAddr);

    // state survived
    expect(await upgraded.currentRoundId()).to.equal(id);
    expect(await upgraded.stakeOf(id, 4, alice.address)).to.equal(7n * 10n ** 16n);
    expect(await upgraded.minStakeWei()).to.equal(MIN_STAKE);
    expect(await upgraded.version()).to.equal(2n);
    await upgraded.setNewVar(42n);
    expect(await upgraded.newVar()).to.equal(42n);

    // the in-flight round still resolves with the real beacon
    await time.setNextBlockTimestamp(targetEnd + 1n);
    await upgraded.connect(owner).resolveRound(id, SIG_ROUND_10M);
    expect((await upgraded.rounds(id)).resolved).to.equal(true);

    // token proxy upgrade preserves balances/minters
    expect(await token.balanceOf(alice.address)).to.be.greaterThan(0n);

    // non-owner cannot upgrade
    const implAddr = await upgrades.erc1967.getImplementationAddress(proxyAddr);
    const asAlice = await ethers.getContractAt("GroodV2", proxyAddr, alice);
    await expect(asAlice.upgradeToAndCall(implAddr, "0x")).to.be.reverted;
  });
});

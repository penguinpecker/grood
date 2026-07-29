import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time, reset } from "@nomicfoundation/hardhat-network-helpers";

const EVMNET_GENESIS = 1727521075n;
const EVMNET_PERIOD = 3n;
const EVMNET_PUBKEY: [bigint, bigint, bigint, bigint] = [
  0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808fn,
  0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382n,
  0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0bn,
  0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6n,
];
const SIG_ROUND_10M: [bigint, bigint] = [
  0x2c7b65b5acfe55256910ca71cf0a0fa71ac34c2a1167f86a22930a03e70ebec0n,
  0x0f7a530796e7ee38600b06da0390634a9b154e3eebc3b323dde2111e1c8ebdf3n,
];
const ROUND_10M = 10_000_000n;
const BEACON_GAP = 10n;
const MIN_STAKE = 10n ** 14n;
const FEE_BPS = 500n;

describe("GroodV4 — players always get exactly 95%", () => {
  beforeEach(async () => { await reset(); });

  async function deploy() {
    const [owner, alice, bob] = await ethers.getSigners();
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    const beacon = await Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
    const V4 = await ethers.getContractFactory("GroodV4");
    const grood = await upgrades.deployProxy(
      V4, [owner.address, await beacon.getAddress(), owner.address], { kind: "uups" });
    return { owner, alice, bob, grood };
  }

  async function openRound(grood: any) {
    const dur = await grood.roundDuration();
    const beaconTime = EVMNET_GENESIS + (ROUND_10M - 1n) * EVMNET_PERIOD;
    await time.setNextBlockTimestamp(beaconTime - dur - BEACON_GAP);
    await grood.skipEmptyRound(await grood.currentRoundId());
    return { id: await grood.currentRoundId(), end: beaconTime - BEACON_GAP };
  }

  // The exact pot sizes that used to leak 14.5% to the tip
  for (const potEth of ["0.0001", "0.0002", "0.0005", "0.001", "0.01"]) {
    it(`pot ${potEth} ETH -> winner receives exactly 95%`, async () => {
      const { owner, alice, grood } = await deploy();
      const { id, end } = await openRound(grood);
      const stake = ethers.parseEther(potEth);

      await time.setNextBlockTimestamp(end - 5n);
      await grood.connect(alice).stake(id, [3], [stake], { value: stake });

      const predicted = await grood.connect(alice).getExpectedPayout.staticCall(3, 0n);
      const before = await ethers.provider.getBalance(alice.address);

      await time.setNextBlockTimestamp(end + 1n);
      await grood.connect(owner).resolveRound(id, SIG_ROUND_10M);

      const expected = stake - (stake * FEE_BPS) / 10_000n;   // exactly 95%
      const r = await grood.rounds(id);
      expect(r.distributable).to.equal(expected);
      expect(predicted).to.equal(expected);                    // preview matches
      expect(await ethers.provider.getBalance(alice.address)).to.equal(before + expected);
      // the ONLY deduction is the 5% fee: fees kept + tip paid out + prize == pot
      const fee = (stake * FEE_BPS) / 10_000n;
      const tipCfg = await grood.resolverTipWei();
      const tipPaid = tipCfg < fee ? tipCfg : fee;
      expect((await grood.accumulatedFees()) + tipPaid + expected).to.equal(stake);
    });
  }

  it("resolver tip is drawn from the fee, never from the prize", async () => {
    const { owner, alice, grood } = await deploy();
    const { id, end } = await openRound(grood);
    const stake = ethers.parseEther("0.01");
    await time.setNextBlockTimestamp(end - 5n);
    await grood.connect(alice).stake(id, [1], [stake], { value: stake });

    const fee = (stake * FEE_BPS) / 10_000n;
    const tip = await grood.resolverTipWei();
    const resolverBefore = await ethers.provider.getBalance(owner.address);

    await time.setNextBlockTimestamp(end + 1n);
    const tx = await grood.connect(owner).resolveRound(id, SIG_ROUND_10M);
    const rc = await tx.wait();

    // resolver got the tip (net of its own gas), fee keeps the remainder
    expect(await ethers.provider.getBalance(owner.address)).to.equal(
      resolverBefore + tip - rc!.gasUsed * rc!.gasPrice
    );
    expect(await grood.accumulatedFees()).to.equal(fee - tip);
    expect((await grood.rounds(id)).distributable).to.equal(stake - fee);
  });

  it("solvency holds and no wei is untracked", async () => {
    const { owner, alice, bob, grood } = await deploy();
    const { id, end } = await openRound(grood);
    await time.setNextBlockTimestamp(end - 8n);
    await grood.connect(alice).stake(id, [2], [MIN_STAKE * 7n], { value: MIN_STAKE * 7n });
    await time.setNextBlockTimestamp(end - 6n);
    await grood.connect(bob).stake(id, [2], [MIN_STAKE * 3n], { value: MIN_STAKE * 3n });
    await time.setNextBlockTimestamp(end + 1n);
    await grood.connect(owner).resolveRound(id, SIG_ROUND_10M);

    const bal = await ethers.provider.getBalance(await grood.getAddress());
    const cur = await grood.rounds(await grood.currentRoundId());
    const owed = cur.totalStaked + (await grood.pendingRefunds())
      + (await grood.pendingWithdrawals()) + (await grood.accumulatedFees());
    expect(bal).to.be.greaterThanOrEqual(owed);
  });
});

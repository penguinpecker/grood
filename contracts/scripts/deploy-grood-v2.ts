import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys the GroodV2 stack (native-ETH pari-mutuel, UUPS proxies):
 *   1. DrandBeacon (plain, immutable config — swappable via setBeacon)
 *   2. GroodTokenV2 behind a UUPS proxy
 *   3. GroodV2 behind a UUPS proxy
 *   4. token.setMinter(game, true)
 *
 *   npx hardhat run scripts/deploy-grood-v2.ts --network robinhood-testnet
 *   npx hardhat run scripts/deploy-grood-v2.ts --network robinhood
 */

// drand evmnet (League of Entropy), live-verified via https://api.drand.sh
const EVMNET_PUBKEY: [bigint, bigint, bigint, bigint] = [
  0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808fn,
  0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382n,
  0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0bn,
  0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6n,
];
const EVMNET_GENESIS = 1727521075n;
const EVMNET_PERIOD = 3n;

async function main() {
  const [deployer] = await ethers.getSigners();
  const feeRecipient = process.env.FEE_RECIPIENT || deployer.address;
  const isMainnet = network.config.chainId === 4663;

  console.log(`Network:       ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Deployer:      ${deployer.address}`);
  console.log(`Fee recipient: ${feeRecipient}`);

  if (isMainnet) {
    // Real money — require explicit intent and a sane balance
    if (process.env.CONFIRM_MAINNET !== "yes") {
      throw new Error("Mainnet deploy requires CONFIRM_MAINNET=yes");
    }
    if (process.env.EXPECT_DEPLOYER && deployer.address.toLowerCase() !== process.env.EXPECT_DEPLOYER.toLowerCase()) {
      throw new Error(`Deployer ${deployer.address} != EXPECT_DEPLOYER ${process.env.EXPECT_DEPLOYER}`);
    }
    const bal = await ethers.provider.getBalance(deployer.address);
    if (bal < ethers.parseEther("0.002")) {
      throw new Error(`Deployer has only ${ethers.formatEther(bal)} ETH — fund it first`);
    }
    console.log(`Balance:       ${ethers.formatEther(bal)} ETH`);
    console.log(`⚠ MAINNET DEPLOY — real funds\n`);
  }

  const Beacon = await ethers.getContractFactory("DrandBeacon");
  const beacon = await Beacon.deploy(EVMNET_PUBKEY, EVMNET_GENESIS, EVMNET_PERIOD);
  await beacon.waitForDeployment();
  console.log(`DrandBeacon:   ${await beacon.getAddress()}`);

  const TokenF = await ethers.getContractFactory("GroodTokenV2");
  const token = await upgrades.deployProxy(TokenF, [deployer.address], { kind: "uups" });
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log(`GroodTokenV2:  ${tokenAddr} (proxy)`);
  console.log(`  impl:        ${await upgrades.erc1967.getImplementationAddress(tokenAddr)}`);

  const GroodF = await ethers.getContractFactory("GroodV2");
  const grood = await upgrades.deployProxy(
    GroodF,
    [tokenAddr, feeRecipient, await beacon.getAddress(), deployer.address],
    { kind: "uups" }
  );
  await grood.waitForDeployment();
  const groodAddr = await grood.getAddress();
  console.log(`GroodV2:       ${groodAddr} (proxy)`);
  console.log(`  impl:        ${await upgrades.erc1967.getImplementationAddress(groodAddr)}`);

  const tx = await token.setMinter(groodAddr, true);
  await tx.wait();
  console.log(`setMinter(game) done: ${tx.hash}`);

  const out = {
    network: network.name,
    chainId: network.config.chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    feeRecipient,
    drandBeacon: await beacon.getAddress(),
    groodToken: tokenAddr,
    groodTokenImpl: await upgrades.erc1967.getImplementationAddress(tokenAddr),
    grood: groodAddr,
    groodImpl: await upgrades.erc1967.getImplementationAddress(groodAddr),
    params: {
      minStakeWei: (await grood.minStakeWei()).toString(),
      resolverTipWei: (await grood.resolverTipWei()).toString(),
      protocolFeeBps: (await grood.protocolFeeBps()).toString(),
      roundDuration: (await grood.roundDuration()).toString(),
      beaconGap: (await grood.beaconGap()).toString(),
    },
    drand: {
      network: "evmnet",
      chainHash: "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3",
      genesis: Number(EVMNET_GENESIS),
      period: Number(EVMNET_PERIOD),
    },
  };
  const file = path.join(__dirname, `../deployments/grood-v2-${network.name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Wrote ${file}`);

  // Optional: seed the Motherlode reserve in the same run
  if (process.env.SEED_RESERVE_ETH) {
    const amount = ethers.parseEther(process.env.SEED_RESERVE_ETH);
    const seedTx = await grood.depositBonusReserve({ value: amount });
    await seedTx.wait();
    console.log(`Seeded bonus reserve with ${process.env.SEED_RESERVE_ETH} ETH: ${seedTx.hash}`);
  }

  // Post-deploy assertions — fail loudly rather than leave a half-wired game
  const checks: [string, boolean][] = [
    ["token minter wired", await token.minters(groodAddr)],
    ["game owner is deployer", (await grood.owner()) === deployer.address],
    ["beacon set", (await grood.beacon()) === (await beacon.getAddress())],
    ["round 1 open", (await grood.currentRoundId()) === 1n],
    ["not paused", (await grood.paused()) === false],
  ];
  console.log(`\nPost-deploy checks:`);
  let allOk = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (!ok) allOk = false;
  }
  if (!allOk) throw new Error("post-deploy checks FAILED — inspect before use");

  console.log(`\nNEXT: transferOwnership to a wallet you control (Ownable2Step: then acceptOwnership from it)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

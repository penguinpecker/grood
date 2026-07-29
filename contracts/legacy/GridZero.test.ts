import { expect } from "chai";
import { ethers } from "hardhat";
import { GridZero, GridZeroOre, MockZkVerifyAttestation } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("GridZero", function () {
  let gridZero: GridZero;
  let ore: GridZeroOre;
  let mockAttestation: MockZkVerifyAttestation;
  let owner: SignerWithAddress;
  let player1: SignerWithAddress;
  let player2: SignerWithAddress;

  const VRF_DOMAIN = 1;
  const LEADERBOARD_DOMAIN = 2;
  const DIFFICULTY_DOMAIN = 3;

  const testAggregationId = 42;
  const testRoot = ethers.keccak256(ethers.toUtf8Bytes("test_root"));
  const testLeaf = ethers.keccak256(ethers.toUtf8Bytes("test_leaf"));
  const testProof = [ethers.keccak256(ethers.toUtf8Bytes("proof_node"))];

  beforeEach(async function () {
    [owner, player1, player2] = await ethers.getSigners();

    // Deploy mock attestation
    const MockAttestation = await ethers.getContractFactory("MockZkVerifyAttestation");
    mockAttestation = await MockAttestation.deploy();

    // Deploy GridZero
    const GridZero = await ethers.getContractFactory("GridZero");
    gridZero = await GridZero.deploy(
      await mockAttestation.getAddress(),
      VRF_DOMAIN,
      LEADERBOARD_DOMAIN,
      DIFFICULTY_DOMAIN
    );

    // Deploy Ore token
    const Ore = await ethers.getContractFactory("GridZeroOre");
    ore = await Ore.deploy("https://gridzero.xyz/api/ore/{id}.json");

    // Link ore to game contract
    await ore.setGameContract(await gridZero.getAddress());
  });

  describe("Deployment", function () {
    it("should set correct owner", async function () {
      expect(await gridZero.owner()).to.equal(owner.address);
    });

    it("should set correct domain IDs", async function () {
      expect(await gridZero.vrfDomainId()).to.equal(VRF_DOMAIN);
      expect(await gridZero.leaderboardDomainId()).to.equal(LEADERBOARD_DOMAIN);
      expect(await gridZero.difficultyDomainId()).to.equal(DIFFICULTY_DOMAIN);
    });

    it("should have default difficulty of 128", async function () {
      expect(await gridZero.difficultyThreshold()).to.equal(128);
    });

    it("should have 32x32 grid", async function () {
      expect(await gridZero.GRID_SIZE()).to.equal(32);
    });

    it("should have correct proving system IDs", async function () {
      const groth16Id = ethers.keccak256(ethers.toUtf8Bytes("groth16"));
      const risc0Id = ethers.keccak256(ethers.toUtf8Bytes("risc0"));
      const ezklId = ethers.keccak256(ethers.toUtf8Bytes("ezkl"));
      expect(await gridZero.GROTH16_PROVING_SYSTEM_ID()).to.equal(groth16Id);
      expect(await gridZero.RISC0_PROVING_SYSTEM_ID()).to.equal(risc0Id);
      expect(await gridZero.EZKL_PROVING_SYSTEM_ID()).to.equal(ezklId);
    });
  });

  describe("Mining", function () {
    it("should record a mining result", async function () {
      const tx = await gridZero.recordMining(
        player1.address, 5, 12, 7, true,
        ethers.toBigInt("14495090148328777396040091467137726704241819747694336672103026520070822108941")
      );
      await expect(tx).to.emit(gridZero, "Mined")
        .withArgs(player1.address, 5, 12, 7, true,
          ethers.toBigInt("14495090148328777396040091467137726704241819747694336672103026520070822108941"));
    });

    it("should update player stats after mining", async function () {
      await gridZero.recordMining(player1.address, 5, 12, 7, true, 12345);
      const stats = await gridZero.getPlayerStats(player1.address);
      expect(stats.totalMined).to.equal(1);
      expect(stats.score).to.equal(1500); // Mythril (500) * 3 (rare)
      expect(stats.oreInventory[7]).to.equal(1);
    });

    it("should not allow mining same cell twice", async function () {
      await gridZero.recordMining(player1.address, 5, 12, 0, false, 111);
      await expect(
        gridZero.recordMining(player2.address, 5, 12, 1, false, 222)
      ).to.be.revertedWith("Cell already mined");
    });

    it("should reject out-of-bounds coordinates", async function () {
      await expect(
        gridZero.recordMining(player1.address, 32, 0, 0, false, 111)
      ).to.be.revertedWith("Out of bounds");
      await expect(
        gridZero.recordMining(player1.address, 0, 32, 0, false, 111)
      ).to.be.revertedWith("Out of bounds");
    });

    it("should reject invalid ore types", async function () {
      await expect(
        gridZero.recordMining(player1.address, 0, 0, 8, false, 111)
      ).to.be.revertedWith("Invalid ore type");
    });

    it("should only allow owner to record mining", async function () {
      await expect(
        gridZero.connect(player1).recordMining(player1.address, 0, 0, 0, false, 111)
      ).to.be.revertedWith("Not owner");
    });

    it("should track total mined count", async function () {
      await gridZero.recordMining(player1.address, 0, 0, 0, false, 111);
      await gridZero.recordMining(player1.address, 1, 0, 1, false, 222);
      await gridZero.recordMining(player2.address, 2, 0, 2, false, 333);
      expect(await gridZero.totalMined()).to.equal(3);
    });
  });

  describe("Score Calculation", function () {
    it("should score common ores correctly", async function () {
      await gridZero.recordMining(player1.address, 0, 0, 0, false, 111);
      expect((await gridZero.getPlayerStats(player1.address)).score).to.equal(1);
    });

    it("should triple score for rare variants", async function () {
      await gridZero.recordMining(player1.address, 0, 0, 0, true, 111);
      expect((await gridZero.getPlayerStats(player1.address)).score).to.equal(3);
    });

    it("should accumulate scores", async function () {
      await gridZero.recordMining(player1.address, 0, 0, 5, false, 111); // Gold = 25
      await gridZero.recordMining(player1.address, 1, 0, 6, true, 222);  // Rare Diamond = 300
      expect((await gridZero.getPlayerStats(player1.address)).score).to.equal(325);
    });
  });

  describe("Settlement (zkVerify Aggregation)", function () {
    beforeEach(async function () {
      await gridZero.recordMining(player1.address, 5, 12, 7, true, 12345);
      // Register valid aggregation in mock for VRF domain
      await mockAttestation.setValidAggregation(VRF_DOMAIN, testAggregationId, testRoot);
    });

    it("should settle mining with valid aggregation proof", async function () {
      const tx = await gridZero.settleMining(
        5, 12, testAggregationId, testLeaf, testProof, 8, 0
      );
      await expect(tx).to.emit(gridZero, "MiningSettled");
      expect(await gridZero.isSettled(5, 12)).to.equal(true);
    });

    it("should reject settlement with unregistered aggregation", async function () {
      const badAggregationId = 999;
      await expect(
        gridZero.settleMining(5, 12, badAggregationId, testLeaf, testProof, 8, 0)
      ).to.be.revertedWith("Attestation verification failed");
    });

    it("should not allow double settlement", async function () {
      await gridZero.settleMining(5, 12, testAggregationId, testLeaf, testProof, 8, 0);
      await expect(
        gridZero.settleMining(5, 12, testAggregationId, testLeaf, testProof, 8, 0)
      ).to.be.revertedWith("Already settled");
    });

    it("should reject settlement for unmined cell", async function () {
      await expect(
        gridZero.settleMining(0, 0, testAggregationId, testLeaf, testProof, 8, 0)
      ).to.be.revertedWith("Cell not mined");
    });

    it("should track verified aggregations", async function () {
      await gridZero.settleMining(5, 12, testAggregationId, testLeaf, testProof, 8, 0);
      expect(await gridZero.isAggregationVerified(VRF_DOMAIN, testAggregationId)).to.equal(true);
    });
  });

  describe("Batch Settlement", function () {
    beforeEach(async function () {
      await gridZero.recordMining(player1.address, 0, 0, 0, false, 111);
      await gridZero.recordMining(player1.address, 1, 0, 1, false, 222);
      await gridZero.recordMining(player2.address, 2, 0, 2, false, 333);
      await mockAttestation.setValidAggregation(VRF_DOMAIN, testAggregationId, testRoot);
    });

    it("should batch settle multiple cells", async function () {
      await gridZero.batchSettleMining(
        [0, 1, 2], [0, 0, 0],
        testAggregationId,
        [testLeaf, testLeaf, testLeaf],
        [testProof, testProof, testProof],
        [4, 4, 4],
        [0, 1, 2]
      );
      expect(await gridZero.isSettled(0, 0)).to.equal(true);
      expect(await gridZero.isSettled(1, 0)).to.equal(true);
      expect(await gridZero.isSettled(2, 0)).to.equal(true);
    });

    it("should skip already settled cells in batch", async function () {
      await gridZero.settleMining(0, 0, testAggregationId, testLeaf, testProof, 8, 0);
      // Batch should skip cell (0,0) and still settle (1,0) and (2,0)
      await gridZero.batchSettleMining(
        [0, 1, 2], [0, 0, 0],
        testAggregationId,
        [testLeaf, testLeaf, testLeaf],
        [testProof, testProof, testProof],
        [4, 4, 4],
        [0, 1, 2]
      );
      expect(await gridZero.isSettled(1, 0)).to.equal(true);
    });
  });

  describe("Difficulty (EZKL Integration)", function () {
    beforeEach(async function () {
      await mockAttestation.setValidAggregation(DIFFICULTY_DOMAIN, testAggregationId, testRoot);
    });

    it("should update difficulty with valid aggregation proof", async function () {
      const tx = await gridZero.updateDifficulty(
        200, testAggregationId, testLeaf, testProof, 4, 0
      );
      await expect(tx).to.emit(gridZero, "DifficultyUpdated").withArgs(128, 200, testAggregationId);
      expect(await gridZero.difficultyThreshold()).to.equal(200);
    });

    it("should reject invalid difficulty values", async function () {
      await expect(
        gridZero.updateDifficulty(0, testAggregationId, testLeaf, testProof, 4, 0)
      ).to.be.revertedWith("Invalid difficulty");
      await expect(
        gridZero.updateDifficulty(256, testAggregationId, testLeaf, testProof, 4, 0)
      ).to.be.revertedWith("Invalid difficulty");
    });

    it("should only allow owner to update difficulty", async function () {
      await expect(
        gridZero.connect(player1).updateDifficulty(200, testAggregationId, testLeaf, testProof, 4, 0)
      ).to.be.revertedWith("Not owner");
    });
  });

  describe("Admin", function () {
    it("should allow domain ID updates", async function () {
      await gridZero.updateDomainIds(10, 20, 30);
      expect(await gridZero.vrfDomainId()).to.equal(10);
      expect(await gridZero.leaderboardDomainId()).to.equal(20);
      expect(await gridZero.difficultyDomainId()).to.equal(30);
    });

    it("should allow vkey hash updates", async function () {
      const vrfVkey = ethers.keccak256(ethers.toUtf8Bytes("vrf_vkey"));
      const lbVkey = ethers.keccak256(ethers.toUtf8Bytes("lb_vkey"));
      const diffVkey = ethers.keccak256(ethers.toUtf8Bytes("diff_vkey"));
      
      const tx = await gridZero.setVkeyHashes(vrfVkey, lbVkey, diffVkey);
      await expect(tx).to.emit(gridZero, "VkeyHashUpdated");
      
      expect(await gridZero.vrfVkeyHash()).to.equal(vrfVkey);
      expect(await gridZero.leaderboardVkeyHash()).to.equal(lbVkey);
      expect(await gridZero.difficultyVkeyHash()).to.equal(diffVkey);
    });

    it("should allow ownership transfer", async function () {
      await gridZero.transferOwnership(player1.address);
      expect(await gridZero.owner()).to.equal(player1.address);
    });
  });

  describe("Leaf Computation", function () {
    it("should compute groth16 leaf deterministically", async function () {
      const vrfVkey = ethers.keccak256(ethers.toUtf8Bytes("vrf_vkey"));
      await gridZero.setVkeyHashes(vrfVkey, ethers.ZeroHash, ethers.ZeroHash);
      
      const pihash = ethers.keccak256(ethers.toUtf8Bytes("test_public_inputs"));
      const leaf = await gridZero.computeGroth16Leaf(pihash);
      expect(leaf).to.not.equal(ethers.ZeroHash);
    });

    it("should produce different leaves for different proof systems", async function () {
      const vkey = ethers.keccak256(ethers.toUtf8Bytes("some_vkey"));
      await gridZero.setVkeyHashes(vkey, vkey, vkey);
      
      const pihash = ethers.keccak256(ethers.toUtf8Bytes("same_inputs"));
      const groth16Leaf = await gridZero.computeGroth16Leaf(pihash);
      const risc0Leaf = await gridZero.computeRisc0Leaf(pihash);
      const ezklLeaf = await gridZero.computeEzklLeaf(pihash);
      
      expect(groth16Leaf).to.not.equal(risc0Leaf);
      expect(risc0Leaf).to.not.equal(ezklLeaf);
    });
  });

  describe("Endianness Helper", function () {
    it("should be involutory (double swap = identity)", async function () {
      const input = ethers.toBigInt("0xDEADBEEF");
      const swapped = await gridZero.changeEndianness(input);
      const restored = await gridZero.changeEndianness(swapped);
      expect(restored).to.equal(input);
    });
  });

  describe("Leaderboard", function () {
    it("should add players to leaderboard", async function () {
      await gridZero.recordMining(player1.address, 0, 0, 5, false, 111);
      const top = await gridZero.getTopPlayers();
      expect(top).to.include(player1.address);
    });

    it("should track multiple players", async function () {
      await gridZero.recordMining(player1.address, 0, 0, 5, false, 111);
      await gridZero.recordMining(player2.address, 1, 0, 6, false, 222);
      const top = await gridZero.getTopPlayers();
      expect(top.length).to.equal(2);
    });
  });

  describe("GridZeroOre (ERC1155)", function () {
    it("should mint ore from game contract", async function () {
      await ore.setGameContract(owner.address);
      await ore.mintOre(player1.address, 7, true, 1);
      expect(await ore.balanceOf(player1.address, 107)).to.equal(1);
    });

    it("should have correct ore names", async function () {
      expect(await ore.oreNames(0)).to.equal("Stone");
      expect(await ore.oreNames(7)).to.equal("Mythril");
      expect(await ore.oreNames(107)).to.equal("Rare Mythril");
    });
  });
});

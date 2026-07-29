// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IZkVerifyAttestation.sol";

/**
 * @title GridZero
 * @notice Provably fair grid-based mining game powered by zkVerify
 * @dev Players mine ore on a 32x32 grid. Each mining result is verified
 *      through zkVerify's Groth16 VRF proof → aggregation → Base attestation.
 *
 * Architecture:
 *   1. Player submits mine action → server generates VRF proof (Circom/Groth16)
 *   2. Proof submitted to zkVerify mainnet via zkVerifyJS
 *   3. zkVerify verifies proof, aggregates into Merkle tree per domain
 *   4. Relayer posts aggregation root to this contract's chain (Base)
 *   5. settleMining() verifies the Merkle inclusion proof on-chain
 *
 * zkVerify Features Demonstrated:
 *   - Groth16 verification (VRF mining proofs)
 *   - RISC Zero verification (leaderboard integrity)
 *   - EZKL verification (ML difficulty adjustment)
 *   - Domain management (separate domains per proof type)
 *   - Batch verification (batch settle multiple proofs)
 *   - Cross-chain attestation (zkVerify → Base)
 */
contract GridZero {
    // ============================================================
    // Types
    // ============================================================

    enum OreType {
        Stone,    // 0 - Common
        Coal,     // 1 - Common
        Iron,     // 2 - Uncommon
        Copper,   // 3 - Uncommon
        Silver,   // 4 - Rare
        Gold,     // 5 - Rare
        Diamond,  // 6 - Epic
        Mythril   // 7 - Legendary
    }

    struct MiningResult {
        address player;
        uint8 gridX;
        uint8 gridY;
        OreType oreType;
        bool isRare;
        uint256 randomOutput;
        uint256 timestamp;
        bool settled;       // True after zkVerify attestation verified
    }

    struct PlayerStats {
        uint256 totalMined;
        uint256 score;
        uint256[8] oreInventory;  // Count per ore type
        uint256 lastMineBlock;
    }

    // ============================================================
    // Constants
    // ============================================================

    /// @dev Proving system ID for Groth16 proofs (Circom VRF)
    bytes32 public constant GROTH16_PROVING_SYSTEM_ID = keccak256(abi.encodePacked("groth16"));

    /// @dev Proving system ID for RISC Zero proofs (leaderboard)
    bytes32 public constant RISC0_PROVING_SYSTEM_ID = keccak256(abi.encodePacked("risc0"));

    /// @dev Proving system ID for EZKL proofs (difficulty model)
    bytes32 public constant EZKL_PROVING_SYSTEM_ID = keccak256(abi.encodePacked("ezkl"));

    /// @dev Version hash for Groth16 (empty string for Circom/snarkjs)
    bytes32 public constant GROTH16_VERSION_HASH = sha256(abi.encodePacked(""));

    /// @dev Version hash for RISC Zero v1.1
    bytes32 public constant RISC0_VERSION_HASH = sha256(abi.encodePacked("risc0:v1.1"));

    /// @dev Version hash for EZKL (empty)
    bytes32 public constant EZKL_VERSION_HASH = sha256(abi.encodePacked(""));

    // ============================================================
    // State
    // ============================================================

    /// @notice zkVerify attestation contract on Base (ZkVerifyAggregationGlobal proxy)
    IZkVerifyAttestation public immutable zkVerifyAttestation;

    /// @notice Game owner (server that submits proofs)
    address public owner;

    /// @notice Grid state: cellKey => MiningResult
    mapping(bytes32 => MiningResult) public grid;

    /// @notice Player stats
    mapping(address => PlayerStats) public players;

    /// @notice Leaderboard (top score tracking)
    address[] public topPlayers;
    uint256 public constant MAX_LEADERBOARD = 100;

    /// @notice Grid dimensions
    uint8 public constant GRID_SIZE = 32;

    /// @notice Current difficulty (updated by EZKL proof)
    uint256 public difficultyThreshold = 128;

    /// @notice Mining cooldown (blocks)
    uint256 public constant MINE_COOLDOWN = 1;

    /// @notice Total mined cells
    uint256 public totalMined;

    /// @notice Domain IDs for zkVerify aggregation
    uint256 public vrfDomainId;
    uint256 public leaderboardDomainId;
    uint256 public difficultyDomainId;

    /// @notice Verification key hashes (registered on zkVerify)
    bytes32 public vrfVkeyHash;
    bytes32 public leaderboardVkeyHash;
    bytes32 public difficultyVkeyHash;

    /// @notice Track verified aggregations to prevent replay
    mapping(uint256 => mapping(uint256 => bool)) public verifiedAggregations;

    // ============================================================
    // Events
    // ============================================================

    event Mined(
        address indexed player,
        uint8 gridX,
        uint8 gridY,
        OreType oreType,
        bool isRare,
        uint256 randomOutput
    );

    event MiningSettled(
        bytes32 indexed cellKey,
        uint256 domainId,
        uint256 aggregationId
    );

    event DifficultyUpdated(
        uint256 oldDifficulty,
        uint256 newDifficulty,
        uint256 aggregationId
    );

    event LeaderboardUpdated(
        address indexed player,
        uint256 newScore
    );

    event VkeyHashUpdated(
        string proofType,
        bytes32 newVkeyHash
    );

    // ============================================================
    // Modifiers
    // ============================================================

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier validCell(uint8 x, uint8 y) {
        require(x < GRID_SIZE && y < GRID_SIZE, "Out of bounds");
        _;
    }

    // ============================================================
    // Constructor
    // ============================================================

    constructor(
        address _zkVerifyAttestation,
        uint256 _vrfDomainId,
        uint256 _leaderboardDomainId,
        uint256 _difficultyDomainId
    ) {
        zkVerifyAttestation = IZkVerifyAttestation(_zkVerifyAttestation);
        owner = msg.sender;
        vrfDomainId = _vrfDomainId;
        leaderboardDomainId = _leaderboardDomainId;
        difficultyDomainId = _difficultyDomainId;
    }

    // ============================================================
    // Core Mining
    // ============================================================

    /**
     * @notice Record a mining result (called by game server after proof generation)
     * @dev The actual proof verification happens on zkVerify. This records the
     *      result optimistically and marks it for settlement.
     */
    function recordMining(
        address player,
        uint8 gridX,
        uint8 gridY,
        uint8 oreType,
        bool isRare,
        uint256 randomOutput
    ) external onlyOwner validCell(gridX, gridY) {
        bytes32 cellKey = getCellKey(gridX, gridY);
        require(grid[cellKey].player == address(0), "Cell already mined");
        require(oreType < 8, "Invalid ore type");

        grid[cellKey] = MiningResult({
            player: player,
            gridX: gridX,
            gridY: gridY,
            oreType: OreType(oreType),
            isRare: isRare,
            randomOutput: randomOutput,
            timestamp: block.timestamp,
            settled: false
        });

        PlayerStats storage stats = players[player];
        stats.totalMined++;
        stats.oreInventory[oreType]++;

        uint256 score = _calculateScore(oreType, isRare);
        stats.score += score;
        stats.lastMineBlock = block.number;

        totalMined++;

        emit Mined(player, gridX, gridY, OreType(oreType), isRare, randomOutput);
        _updateLeaderboard(player);
    }

    // ============================================================
    // zkVerify Attestation Verification
    // ============================================================

    /**
     * @notice Verify a mining result via zkVerify aggregation proof
     * @dev Checks the Merkle proof against the zkVerify attestation contract
     *      to confirm the VRF proof was genuinely verified on zkVerify
     * @param gridX X coordinate of the mined cell
     * @param gridY Y coordinate of the mined cell
     * @param aggregationId The aggregation batch ID from zkVerify
     * @param leaf The leaf digest (statement hash) of the verified proof
     * @param merklePath Merkle path from leaf to aggregation root
     * @param leafCount Total leaves in the aggregation tree
     * @param leafIndex Index of this proof's leaf
     */
    function settleMining(
        uint8 gridX,
        uint8 gridY,
        uint256 aggregationId,
        bytes32 leaf,
        bytes32[] calldata merklePath,
        uint256 leafCount,
        uint256 leafIndex
    ) external validCell(gridX, gridY) {
        bytes32 cellKey = getCellKey(gridX, gridY);
        MiningResult storage result = grid[cellKey];

        require(result.player != address(0), "Cell not mined");
        require(!result.settled, "Already settled");

        // Verify against zkVerify attestation contract on Base
        bool verified = zkVerifyAttestation.verifyProofAggregation(
            vrfDomainId,
            aggregationId,
            leaf,
            merklePath,
            leafCount,
            leafIndex
        );

        require(verified, "Attestation verification failed");

        result.settled = true;
        verifiedAggregations[vrfDomainId][aggregationId] = true;

        emit MiningSettled(cellKey, vrfDomainId, aggregationId);
    }

    /**
     * @notice Batch settle multiple mining results from one aggregation
     * @dev When an aggregation contains multiple proofs, settle them all at once
     */
    function batchSettleMining(
        uint8[] calldata gridXs,
        uint8[] calldata gridYs,
        uint256 aggregationId,
        bytes32[] calldata leaves,
        bytes32[][] calldata merklePaths,
        uint256[] calldata leafCounts,
        uint256[] calldata leafIndexes
    ) external {
        require(gridXs.length == gridYs.length, "Array length mismatch");
        require(gridXs.length == leaves.length, "Array length mismatch");
        require(gridXs.length == merklePaths.length, "Array length mismatch");

        for (uint256 i = 0; i < gridXs.length; i++) {
            bytes32 cellKey = getCellKey(gridXs[i], gridYs[i]);
            MiningResult storage result = grid[cellKey];

            if (result.player == address(0) || result.settled) continue;

            bool verified = zkVerifyAttestation.verifyProofAggregation(
                vrfDomainId,
                aggregationId,
                leaves[i],
                merklePaths[i],
                leafCounts[i],
                leafIndexes[i]
            );

            if (verified) {
                result.settled = true;
                emit MiningSettled(cellKey, vrfDomainId, aggregationId);
            }
        }

        verifiedAggregations[vrfDomainId][aggregationId] = true;
    }

    // ============================================================
    // Difficulty Management (EZKL Integration)
    // ============================================================

    /**
     * @notice Update difficulty based on EZKL-verified ML model output
     * @dev Called after EZKL proof is verified on zkVerify and attested to Base
     */
    function updateDifficulty(
        uint256 newDifficulty,
        uint256 aggregationId,
        bytes32 leaf,
        bytes32[] calldata merklePath,
        uint256 leafCount,
        uint256 leafIndex
    ) external onlyOwner {
        require(newDifficulty > 0 && newDifficulty <= 255, "Invalid difficulty");

        bool verified = zkVerifyAttestation.verifyProofAggregation(
            difficultyDomainId,
            aggregationId,
            leaf,
            merklePath,
            leafCount,
            leafIndex
        );

        require(verified, "Difficulty attestation failed");

        uint256 oldDifficulty = difficultyThreshold;
        difficultyThreshold = newDifficulty;

        emit DifficultyUpdated(oldDifficulty, newDifficulty, aggregationId);
    }

    // ============================================================
    // Leaf Computation Helpers
    // ============================================================

    /**
     * @notice Compute the leaf digest for a Groth16 proof (Circom VRF)
     * @dev leaf = keccak256(PROVING_SYSTEM_ID || vkeyHash || VERSION_HASH || publicInputsHash)
     *      For Groth16/Circom, public inputs need endianness conversion
     * @param publicInputsHash The keccak256 of the public inputs (after endian swap)
     */
    function computeGroth16Leaf(bytes32 publicInputsHash) external view returns (bytes32) {
        return keccak256(abi.encodePacked(
            GROTH16_PROVING_SYSTEM_ID,
            vrfVkeyHash,
            GROTH16_VERSION_HASH,
            publicInputsHash
        ));
    }

    /**
     * @notice Compute the leaf digest for a RISC Zero proof (leaderboard)
     * @param publicInputsHash The keccak256 of the RISC Zero journal
     */
    function computeRisc0Leaf(bytes32 publicInputsHash) external view returns (bytes32) {
        return keccak256(abi.encodePacked(
            RISC0_PROVING_SYSTEM_ID,
            leaderboardVkeyHash,
            RISC0_VERSION_HASH,
            publicInputsHash
        ));
    }

    /**
     * @notice Compute the leaf for an EZKL proof (difficulty model)
     * @param publicInputsHash The keccak256 of the EZKL public inputs
     */
    function computeEzklLeaf(bytes32 publicInputsHash) external view returns (bytes32) {
        return keccak256(abi.encodePacked(
            EZKL_PROVING_SYSTEM_ID,
            difficultyVkeyHash,
            EZKL_VERSION_HASH,
            publicInputsHash
        ));
    }

    /**
     * @notice Helper to swap endianness of a uint256 (needed for Groth16 public inputs)
     * @dev zkVerify's Groth16 pallet uses big-endian but EVM uses little-endian
     */
    function changeEndianness(uint256 input) public pure returns (uint256 v) {
        v = input;
        // swap bytes
        v = ((v & 0xFF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00) >> 8) |
            ((v & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF) << 8);
        // swap 2-byte pairs
        v = ((v & 0xFFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000) >> 16) |
            ((v & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF) << 16);
        // swap 4-byte pairs
        v = ((v & 0xFFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000) >> 32) |
            ((v & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF) << 32);
        // swap 8-byte pairs
        v = ((v & 0xFFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF0000000000000000) >> 64) |
            ((v & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF) << 64);
        // swap 16-byte pairs
        v = (v >> 128) | (v << 128);
    }

    // ============================================================
    // Views
    // ============================================================

    function getCellKey(uint8 x, uint8 y) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(x, y));
    }

    function getCell(uint8 x, uint8 y) external view returns (MiningResult memory) {
        return grid[getCellKey(x, y)];
    }

    function getPlayerStats(address player) external view returns (PlayerStats memory) {
        return players[player];
    }

    function getPlayerScore(address player) external view returns (uint256) {
        return players[player].score;
    }

    function getPlayerOreCount(address player, uint8 oreType) external view returns (uint256) {
        require(oreType < 8, "Invalid ore type");
        return players[player].oreInventory[oreType];
    }

    function getTopPlayers() external view returns (address[] memory) {
        return topPlayers;
    }

    function isSettled(uint8 x, uint8 y) external view returns (bool) {
        return grid[getCellKey(x, y)].settled;
    }

    function isMined(uint8 x, uint8 y) external view returns (bool) {
        return grid[getCellKey(x, y)].player != address(0);
    }

    /// @notice Check if a specific aggregation has been used for settlement
    function isAggregationVerified(uint256 domainId, uint256 aggregationId) external view returns (bool) {
        return verifiedAggregations[domainId][aggregationId];
    }

    // ============================================================
    // Internal
    // ============================================================

    function _calculateScore(uint8 oreType, bool isRare) internal pure returns (uint256) {
        uint256[8] memory baseScores = [
            uint256(1),   // Stone
            uint256(2),   // Coal
            uint256(5),   // Iron
            uint256(5),   // Copper
            uint256(15),  // Silver
            uint256(25),  // Gold
            uint256(100), // Diamond
            uint256(500)  // Mythril
        ];

        uint256 base = baseScores[oreType];
        return isRare ? base * 3 : base;
    }

    function _updateLeaderboard(address player) internal {
        uint256 score = players[player].score;

        // Check if already in leaderboard
        for (uint256 i = 0; i < topPlayers.length; i++) {
            if (topPlayers[i] == player) {
                emit LeaderboardUpdated(player, score);
                return;
            }
        }

        // Add to leaderboard if space available
        if (topPlayers.length < MAX_LEADERBOARD) {
            topPlayers.push(player);
            emit LeaderboardUpdated(player, score);
            return;
        }

        // Replace lowest scorer if new player has higher score
        uint256 lowestIdx = 0;
        uint256 lowestScore = players[topPlayers[0]].score;

        for (uint256 i = 1; i < topPlayers.length; i++) {
            uint256 s = players[topPlayers[i]].score;
            if (s < lowestScore) {
                lowestScore = s;
                lowestIdx = i;
            }
        }

        if (score > lowestScore) {
            topPlayers[lowestIdx] = player;
            emit LeaderboardUpdated(player, score);
        }
    }

    // ============================================================
    // Admin
    // ============================================================

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }

    function updateDomainIds(
        uint256 _vrfDomainId,
        uint256 _leaderboardDomainId,
        uint256 _difficultyDomainId
    ) external onlyOwner {
        vrfDomainId = _vrfDomainId;
        leaderboardDomainId = _leaderboardDomainId;
        difficultyDomainId = _difficultyDomainId;
    }

    function setVkeyHashes(
        bytes32 _vrfVkeyHash,
        bytes32 _leaderboardVkeyHash,
        bytes32 _difficultyVkeyHash
    ) external onlyOwner {
        vrfVkeyHash = _vrfVkeyHash;
        leaderboardVkeyHash = _leaderboardVkeyHash;
        difficultyVkeyHash = _difficultyVkeyHash;
        emit VkeyHashUpdated("groth16", _vrfVkeyHash);
        emit VkeyHashUpdated("risc0", _leaderboardVkeyHash);
        emit VkeyHashUpdated("ezkl", _difficultyVkeyHash);
    }
}

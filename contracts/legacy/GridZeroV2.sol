// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IZeroToken {
    function mint(address to, uint256 amount) external;
}

/// @title GridZero V2 - Round-Based Mining Game
/// @notice 5x5 grid, USDC entry, VRF determines winning cell, winners split pot + earn $ZERO
/// @dev Rounds are driven by Base block timestamps via Railway resolver bot
contract GridZeroV2 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════════
    // Constants
    // ══════════════════════════════════════════════════════════════

    uint256 public constant GRID_SIZE = 25;        // 5x5 grid → cells 0-24
    uint256 public constant BPS_BASE = 10_000;

    // ══════════════════════════════════════════════════════════════
    // State - Config
    // ══════════════════════════════════════════════════════════════

    IERC20 public immutable usdc;                   // USDC on Base
    IZeroToken public zeroToken;                    // $ZERO reward token

    address public fulfiller;                       // Railway resolver bot
    address public feeRecipient;                    // Protocol fee destination

    uint256 public entryFee = 1e6;                  // 1 USDC (6 decimals)
    uint256 public roundDuration = 30;              // 30 seconds per round
    uint256 public protocolFeeBps = 1000;           // 10% protocol fee
    uint256 public resolverReward = 0.1e6;          // 0.1 USDC to resolver bot

    // $ZERO emission config
    uint256 public zeroPerRound = 1e18;             // 1 $ZERO split among winners per round

    // Motherlode config - big $ZERO bonus
    uint256 public motherlodePerRound = 10e18;      // 10 $ZERO for motherlode
    uint256 public bonusRoundOdds = 100;            // 1 in 100 chance
    uint256 public bonusMultiplier = 10;            // 10x USDC payout in bonus round

    // ══════════════════════════════════════════════════════════════
    // State - Rounds
    // ══════════════════════════════════════════════════════════════

    uint256 public currentRoundId;

    struct Round {
        uint64 startTime;
        uint64 endTime;
        uint256 totalDeposits;          // Total USDC in the pot
        uint256 totalPlayers;           // Total entries (one per player)
        uint8 winningCell;              // 0-24, set on resolve
        bool resolved;
        bool pendingVRF;
        bool isBonusRound;             // Motherlode round
        bool claimed;                  // For tracking if pool was distributed
    }

    mapping(uint256 => Round) public rounds;

    // roundId => cell => list of players who picked that cell
    mapping(uint256 => mapping(uint8 => address[])) public cellPlayers;

    // roundId => player => cell they picked (+ 1, so 0 = not entered)
    // Store as cell+1 so we can distinguish "not entered" (0) from "picked cell 0" (1)
    mapping(uint256 => mapping(address => uint8)) public playerCell;

    // roundId => player => claimed
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    // Accumulated USDC for treasury from protocol fees
    uint256 public accumulatedFees;

    // ══════════════════════════════════════════════════════════════
    // Events
    // ══════════════════════════════════════════════════════════════

    event RoundStarted(uint256 indexed roundId, uint64 startTime, uint64 endTime);
    event CellPicked(uint256 indexed roundId, address indexed player, uint8 cell);
    event RoundResolved(uint256 indexed roundId, uint8 winningCell, uint256 winnersCount, bool isBonusRound);
    event WinningsClaimed(uint256 indexed roundId, address indexed player, uint256 usdcAmount, uint256 zeroAmount);
    event NoWinners(uint256 indexed roundId, uint256 rolledOverAmount);
    event ConfigUpdated(string key, uint256 value);

    // ══════════════════════════════════════════════════════════════
    // Constructor
    // ══════════════════════════════════════════════════════════════

    constructor(
        address _usdc,
        address _zeroToken,
        address _fulfiller,
        address _feeRecipient
    ) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
        zeroToken = IZeroToken(_zeroToken);
        fulfiller = _fulfiller;
        feeRecipient = _feeRecipient;

        // Start first round
        _startNewRound();
    }

    // ══════════════════════════════════════════════════════════════
    // Player Actions
    // ══════════════════════════════════════════════════════════════

    /// @notice Pick a cell in the current round. Costs 1 USDC.
    /// @param cell Cell index 0-24 (5x5 grid, row-major: cell = row*5 + col)
    function pickCell(uint8 cell) external nonReentrant {
        require(cell < GRID_SIZE, "Invalid cell");

        Round storage round = rounds[currentRoundId];
        require(block.timestamp < round.endTime, "Round ended");
        require(playerCell[currentRoundId][msg.sender] == 0, "Already entered");

        // Transfer USDC entry fee from player
        usdc.safeTransferFrom(msg.sender, address(this), entryFee);

        // Record pick (store cell+1 to distinguish from "not entered")
        playerCell[currentRoundId][msg.sender] = cell + 1;
        cellPlayers[currentRoundId][cell].push(msg.sender);

        round.totalDeposits += entryFee;
        round.totalPlayers++;

        emit CellPicked(currentRoundId, msg.sender, cell);
    }

    /// @notice Claim winnings for a resolved round
    /// @param roundId The round to claim from
    function claim(uint256 roundId) external nonReentrant {
        Round storage round = rounds[roundId];
        require(round.resolved, "Not resolved");
        require(!hasClaimed[roundId][msg.sender], "Already claimed");

        uint8 pickedCell = playerCell[roundId][msg.sender];
        require(pickedCell != 0, "Not entered");
        require(pickedCell - 1 == round.winningCell, "Not a winner");

        hasClaimed[roundId][msg.sender] = true;

        address[] storage winners = cellPlayers[roundId][round.winningCell];
        uint256 winnersCount = winners.length;
        require(winnersCount > 0, "No winners");

        // Calculate USDC payout
        uint256 pool = round.totalDeposits;
        uint256 fee = (pool * protocolFeeBps) / BPS_BASE;
        uint256 resolverCut = resolverReward;
        uint256 distributable = pool - fee - resolverCut;

        // Bonus round multiplier (funded from accumulated fees / treasury)
        if (round.isBonusRound) {
            distributable = distributable * bonusMultiplier;
        }

        uint256 usdcPerWinner = distributable / winnersCount;

        // Calculate $ZERO payout
        uint256 zeroBase = round.isBonusRound ? motherlodePerRound : zeroPerRound;
        uint256 zeroPerWinner = zeroBase / winnersCount;

        // Transfer USDC to winner
        if (usdcPerWinner > 0) {
            usdc.safeTransfer(msg.sender, usdcPerWinner);
        }

        // Mint $ZERO to winner
        if (zeroPerWinner > 0) {
            zeroToken.mint(msg.sender, zeroPerWinner);
        }

        emit WinningsClaimed(roundId, msg.sender, usdcPerWinner, zeroPerWinner);
    }

    // ══════════════════════════════════════════════════════════════
    // Resolver Bot (Railway Backend)
    // ══════════════════════════════════════════════════════════════

    /// @notice Resolve current round with VRF result. Called by Railway resolver bot.
    /// @param vrfOutput The raw VRF output bytes (from Groth16 proof via Kurier)
    /// @param roundId The round being resolved (safety check)
    function resolveRound(bytes calldata vrfOutput, uint256 roundId) external nonReentrant {
        require(msg.sender == fulfiller, "Not fulfiller");
        require(roundId == currentRoundId, "Wrong round");

        Round storage round = rounds[currentRoundId];
        require(block.timestamp >= round.endTime, "Round not ended");
        require(!round.resolved, "Already resolved");

        // Determine winning cell from VRF output
        uint8 winningCell = uint8(uint256(keccak256(vrfOutput)) % GRID_SIZE);

        // Determine if bonus round (motherlode)
        bool isBonus = (uint256(keccak256(abi.encodePacked(vrfOutput, "bonus"))) % bonusRoundOdds) == 0;

        // Update round state
        round.winningCell = winningCell;
        round.resolved = true;
        round.isBonusRound = isBonus;

        address[] storage winners = cellPlayers[currentRoundId][winningCell];
        uint256 winnersCount = winners.length;

        // Handle protocol fee + resolver reward
        uint256 pool = round.totalDeposits;
        if (pool > 0) {
            uint256 fee = (pool * protocolFeeBps) / BPS_BASE;
            accumulatedFees += fee;

            // Pay resolver
            if (resolverReward > 0 && pool >= resolverReward + fee) {
                usdc.safeTransfer(fulfiller, resolverReward);
            }
        }

        // If no one picked the winning cell, roll USDC into next round
        if (winnersCount == 0) {
            // USDC stays in contract, effectively rolls into future rounds
            // Still mint $ZERO to no one (it's fine, tokens just aren't minted)
            emit NoWinners(currentRoundId, pool);
        }

        emit RoundResolved(currentRoundId, winningCell, winnersCount, isBonus);

        // Start next round automatically
        _startNewRound();
    }

    // ══════════════════════════════════════════════════════════════
    // View Helpers
    // ══════════════════════════════════════════════════════════════

    /// @notice Get how many players picked each cell in a round
    /// @return counts Array of 25 counts (one per cell)
    function getCellCounts(uint256 roundId) external view returns (uint256[25] memory counts) {
        for (uint8 i = 0; i < GRID_SIZE; i++) {
            counts[i] = cellPlayers[roundId][i].length;
        }
    }

    /// @notice Get all players who picked a specific cell
    function getCellPlayers(uint256 roundId, uint8 cell) external view returns (address[] memory) {
        return cellPlayers[roundId][cell];
    }

    /// @notice Check if player won a specific round
    function isWinner(uint256 roundId, address player) external view returns (bool) {
        Round storage round = rounds[roundId];
        if (!round.resolved) return false;
        uint8 picked = playerCell[roundId][player];
        if (picked == 0) return false;
        return (picked - 1) == round.winningCell;
    }

    /// @notice Get current round info
    function getCurrentRound() external view returns (
        uint256 roundId,
        uint64 startTime,
        uint64 endTime,
        uint256 totalDeposits,
        uint256 totalPlayers,
        uint256 timeRemaining
    ) {
        Round storage round = rounds[currentRoundId];
        roundId = currentRoundId;
        startTime = round.startTime;
        endTime = round.endTime;
        totalDeposits = round.totalDeposits;
        totalPlayers = round.totalPlayers;
        timeRemaining = block.timestamp < round.endTime 
            ? round.endTime - block.timestamp 
            : 0;
    }

    /// @notice Calculate potential winnings for a cell in current round
    function getPotentialPayout(uint8 cell) external view returns (uint256 usdcPayout, uint256 zeroPayout) {
        Round storage round = rounds[currentRoundId];
        uint256 pool = round.totalDeposits + entryFee; // +1 for hypothetical entry
        uint256 fee = (pool * protocolFeeBps) / BPS_BASE;
        uint256 distributable = pool - fee - resolverReward;
        uint256 winnersOnCell = cellPlayers[currentRoundId][cell].length + 1; // +1 for hypothetical

        usdcPayout = distributable / winnersOnCell;
        zeroPayout = zeroPerRound / winnersOnCell;
    }

    // ══════════════════════════════════════════════════════════════
    // Internal
    // ══════════════════════════════════════════════════════════════

    function _startNewRound() internal {
        currentRoundId++;
        uint64 start = uint64(block.timestamp);
        uint64 end = start + uint64(roundDuration);

        rounds[currentRoundId] = Round({
            startTime: start,
            endTime: end,
            totalDeposits: 0,
            totalPlayers: 0,
            winningCell: 0,
            resolved: false,
            pendingVRF: false,
            isBonusRound: false,
            claimed: false
        });

        emit RoundStarted(currentRoundId, start, end);
    }

    // ══════════════════════════════════════════════════════════════
    // Admin
    // ══════════════════════════════════════════════════════════════

    function setFulfiller(address _v) external onlyOwner { fulfiller = _v; }
    function setFeeRecipient(address _v) external onlyOwner { feeRecipient = _v; }
    function setZeroToken(address _v) external onlyOwner { zeroToken = IZeroToken(_v); }
    function setEntryFee(uint256 _v) external onlyOwner { entryFee = _v; emit ConfigUpdated("entryFee", _v); }
    function setRoundDuration(uint256 _v) external onlyOwner { roundDuration = _v; emit ConfigUpdated("roundDuration", _v); }
    function setZeroPerRound(uint256 _v) external onlyOwner { zeroPerRound = _v; emit ConfigUpdated("zeroPerRound", _v); }
    function setProtocolFeeBps(uint256 _v) external onlyOwner { require(_v <= 2000, "Fee>20%"); protocolFeeBps = _v; emit ConfigUpdated("protocolFeeBps", _v); }
    function setResolverReward(uint256 _v) external onlyOwner { resolverReward = _v; emit ConfigUpdated("resolverReward", _v); }
    function setMotherlodePerRound(uint256 _v) external onlyOwner { motherlodePerRound = _v; emit ConfigUpdated("motherlodePerRound", _v); }
    function setBonusRoundOdds(uint256 _v) external onlyOwner { require(_v >= 10, "Too frequent"); bonusRoundOdds = _v; emit ConfigUpdated("bonusRoundOdds", _v); }
    function setBonusMultiplier(uint256 _v) external onlyOwner { require(_v >= 1 && _v <= 100, "1-100x"); bonusMultiplier = _v; emit ConfigUpdated("bonusMultiplier", _v); }

    function withdrawFees() external onlyOwner {
        uint256 amount = accumulatedFees;
        accumulatedFees = 0;
        usdc.safeTransfer(feeRecipient, amount);
    }

    function emergencyWithdrawUSDC() external onlyOwner {
        usdc.safeTransfer(owner(), usdc.balanceOf(address(this)));
    }
}

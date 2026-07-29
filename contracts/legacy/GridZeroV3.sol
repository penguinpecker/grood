// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IZeroToken {
    function mint(address to, uint256 amount) external;
}

/// @title GridZero V3 - Round-Based Mining Game (Fixed Winner Selection)
/// @notice 5x5 grid, USDC entry, VRF picks from OCCUPIED cells only = guaranteed winners
/// @dev V3 fixes: winner picked from occupied cells, skip empty rounds, real VRF output
contract GridZeroV3 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════════
    // Constants
    // ══════════════════════════════════════════════════════════════

    uint256 public constant GRID_SIZE = 25;        // 5x5 grid → cells 0-24
    uint256 public constant BPS_BASE = 10_000;

    // ══════════════════════════════════════════════════════════════
    // State - Config
    // ══════════════════════════════════════════════════════════════

    IERC20 public immutable usdc;
    IZeroToken public zeroToken;

    address public fulfiller;                       // Railway resolver bot
    address public feeRecipient;                    // Protocol fee destination

    uint256 public entryFee = 1e6;                  // 1 USDC (6 decimals)
    uint256 public roundDuration = 30;              // 30 seconds per round
    uint256 public protocolFeeBps = 500;            // 5% protocol fee
    uint256 public resolverReward = 0.1e6;          // 0.1 USDC to resolver bot

    uint256 public zeroPerRound = 100e18;           // 100 $ZERO split among winners
    uint256 public motherlodePerRound = 1000e18;    // 1000 $ZERO for motherlode
    uint256 public bonusRoundOdds = 100;            // 1 in 100 chance
    uint256 public bonusMultiplier = 10;            // 10x USDC payout in bonus round

    // ══════════════════════════════════════════════════════════════
    // State - Rounds
    // ══════════════════════════════════════════════════════════════

    uint256 public currentRoundId;

    struct Round {
        uint64 startTime;
        uint64 endTime;
        uint256 totalDeposits;
        uint256 totalPlayers;
        uint8 winningCell;              // 0-24, set on resolve
        bool resolved;
        bool isBonusRound;
    }

    mapping(uint256 => Round) public rounds;

    // roundId => cell => list of players
    mapping(uint256 => mapping(uint8 => address[])) public cellPlayers;

    // roundId => player => cell+1 (0 = not entered)
    mapping(uint256 => mapping(address => uint8)) public playerCell;

    // roundId => player => claimed
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    uint256 public accumulatedFees;

    // ══════════════════════════════════════════════════════════════
    // Events
    // ══════════════════════════════════════════════════════════════

    event RoundStarted(uint256 indexed roundId, uint64 startTime, uint64 endTime);
    event CellPicked(uint256 indexed roundId, address indexed player, uint8 cell);
    event RoundResolved(uint256 indexed roundId, uint8 winningCell, uint256 winnersCount, bool isBonusRound);
    event WinningsClaimed(uint256 indexed roundId, address indexed player, uint256 usdcAmount, uint256 zeroAmount);
    event EmptyRoundSkipped(uint256 indexed roundId);
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
        _startNewRound();
    }

    // ══════════════════════════════════════════════════════════════
    // Player Actions
    // ══════════════════════════════════════════════════════════════

    function pickCell(uint8 cell) external nonReentrant {
        require(cell < GRID_SIZE, "Invalid cell");

        Round storage round = rounds[currentRoundId];
        require(block.timestamp < round.endTime, "Round ended");
        require(playerCell[currentRoundId][msg.sender] == 0, "Already entered");

        usdc.safeTransferFrom(msg.sender, address(this), entryFee);

        playerCell[currentRoundId][msg.sender] = cell + 1;
        cellPlayers[currentRoundId][cell].push(msg.sender);

        round.totalDeposits += entryFee;
        round.totalPlayers++;

        emit CellPicked(currentRoundId, msg.sender, cell);
    }

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

        uint256 pool = round.totalDeposits;
        uint256 fee = (pool * protocolFeeBps) / BPS_BASE;
        uint256 resolverCut = resolverReward;
        
        // Guard against underflow if pool is too small
        uint256 distributable;
        if (pool > fee + resolverCut) {
            distributable = pool - fee - resolverCut;
        } else {
            distributable = 0;
        }

        if (round.isBonusRound) {
            // Cap bonus payout to actual contract balance
            uint256 bonusAmount = distributable * bonusMultiplier;
            uint256 contractBalance = usdc.balanceOf(address(this));
            // Reserve fees that haven't been withdrawn yet
            uint256 available = contractBalance > accumulatedFees ? contractBalance - accumulatedFees : 0;
            distributable = bonusAmount > available ? available : bonusAmount;
        }

        uint256 usdcPerWinner = winnersCount > 0 ? distributable / winnersCount : 0;
        uint256 zeroBase = round.isBonusRound ? motherlodePerRound : zeroPerRound;
        uint256 zeroPerWinner = zeroBase / winnersCount;

        if (usdcPerWinner > 0) {
            usdc.safeTransfer(msg.sender, usdcPerWinner);
        }

        if (zeroPerWinner > 0) {
            zeroToken.mint(msg.sender, zeroPerWinner);
        }

        emit WinningsClaimed(roundId, msg.sender, usdcPerWinner, zeroPerWinner);
    }

    // ══════════════════════════════════════════════════════════════
    // Resolver Bot - FIXED: picks from occupied cells only
    // ══════════════════════════════════════════════════════════════

    /// @notice Resolve round with real VRF output. Winner picked from OCCUPIED cells only.
    /// @param vrfOutput The VRF random_output from Groth16 proof (publicSignals[0] as bytes32)
    /// @param roundId Safety check
    function resolveRound(bytes32 vrfOutput, uint256 roundId) external nonReentrant {
        require(msg.sender == fulfiller, "Not fulfiller");
        require(roundId == currentRoundId, "Wrong round");

        Round storage round = rounds[currentRoundId];
        require(block.timestamp >= round.endTime, "Round not ended");
        require(!round.resolved, "Already resolved");
        require(round.totalPlayers > 0, "Use skipEmptyRound");

        // ─── Build array of occupied cells ───
        uint8[25] memory occupied;
        uint256 occupiedCount = 0;

        for (uint8 i = 0; i < 25; i++) {
            if (cellPlayers[currentRoundId][i].length > 0) {
                occupied[occupiedCount] = i;
                occupiedCount++;
            }
        }

        // Pick winner from OCCUPIED cells only → guaranteed winner!
        uint256 randomIndex = uint256(vrfOutput) % occupiedCount;
        uint8 winningCell = occupied[randomIndex];

        // Bonus round check
        bool isBonus = (uint256(keccak256(abi.encodePacked(vrfOutput, "bonus"))) % bonusRoundOdds) == 0;

        // Update state
        round.winningCell = winningCell;
        round.resolved = true;
        round.isBonusRound = isBonus;

        address[] storage winners = cellPlayers[currentRoundId][winningCell];
        uint256 winnersCount = winners.length;

        // Fees
        uint256 pool = round.totalDeposits;
        uint256 fee = (pool * protocolFeeBps) / BPS_BASE;
        accumulatedFees += fee;

        // Pay resolver (skip if contract can't afford it — don't brick resolve)
        if (resolverReward > 0 && usdc.balanceOf(address(this)) >= resolverReward) {
            usdc.safeTransfer(fulfiller, resolverReward);
        }

        emit RoundResolved(currentRoundId, winningCell, winnersCount, isBonus);
        _startNewRound();
    }

    /// @notice Skip empty round (0 players) — saves gas, no VRF needed
    function skipEmptyRound(uint256 roundId) external {
        require(msg.sender == fulfiller, "Not fulfiller");
        require(roundId == currentRoundId, "Wrong round");

        Round storage round = rounds[currentRoundId];
        require(block.timestamp >= round.endTime, "Round not ended");
        require(!round.resolved, "Already resolved");
        require(round.totalPlayers == 0, "Has players");

        round.resolved = true;
        emit EmptyRoundSkipped(currentRoundId);
        _startNewRound();
    }

    // ══════════════════════════════════════════════════════════════
    // View Helpers
    // ══════════════════════════════════════════════════════════════

    function getCellCounts(uint256 roundId) external view returns (uint256[25] memory counts) {
        for (uint8 i = 0; i < GRID_SIZE; i++) {
            counts[i] = cellPlayers[roundId][i].length;
        }
    }

    function getCellPlayers(uint256 roundId, uint8 cell) external view returns (address[] memory) {
        return cellPlayers[roundId][cell];
    }

    function isWinner(uint256 roundId, address player) external view returns (bool) {
        Round storage round = rounds[roundId];
        if (!round.resolved) return false;
        uint8 picked = playerCell[roundId][player];
        if (picked == 0) return false;
        return (picked - 1) == round.winningCell;
    }

    function hasJoined(uint256 roundId, address player) external view returns (bool) {
        return playerCell[roundId][player] != 0;
    }

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

    function getPotentialPayout(uint8 cell) external view returns (uint256 usdcPayout, uint256 zeroPayout) {
        Round storage round = rounds[currentRoundId];
        uint256 pool = round.totalDeposits + entryFee;
        uint256 fee = (pool * protocolFeeBps) / BPS_BASE;
        uint256 deductions = fee + resolverReward;
        uint256 distributable = pool > deductions ? pool - deductions : 0;
        uint256 winnersOnCell = cellPlayers[currentRoundId][cell].length + 1;
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
            isBonusRound: false
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

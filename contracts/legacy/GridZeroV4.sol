// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IZeroToken {
    function mint(address to, uint256 amount) external;
}

/// @title GridZero V4 - Auto-Pay Winners on Resolve
/// @notice 5x5 grid, USDC entry, VRF picks from OCCUPIED cells, winnings sent automatically
contract GridZeroV4 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant GRID_SIZE = 25;
    uint256 public constant BPS_BASE = 10_000;

    IERC20 public immutable usdc;
    IZeroToken public zeroToken;

    address public fulfiller;
    address public feeRecipient;

    uint256 public entryFee = 1e6;              // 1 USDC
    uint256 public roundDuration = 30;           // 30s
    uint256 public protocolFeeBps = 500;         // 5%
    uint256 public resolverReward = 0.1e6;       // 0.1 USDC

    uint256 public zeroPerRound = 100e18;
    uint256 public motherlodePerRound = 1000e18;
    uint256 public bonusRoundOdds = 100;
    uint256 public bonusMultiplier = 10;

    uint256 public currentRoundId;
    uint256 public accumulatedFees;

    struct Round {
        uint64 startTime;
        uint64 endTime;
        uint256 totalDeposits;
        uint256 totalPlayers;
        uint8 winningCell;
        bool resolved;
        bool isBonusRound;
    }

    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(uint8 => address[])) public cellPlayers;
    mapping(uint256 => mapping(address => uint8)) public playerCell;

    // Track per-round payouts for transparency
    mapping(uint256 => uint256) public roundUsdcPerWinner;
    mapping(uint256 => uint256) public roundZeroPerWinner;

    event RoundStarted(uint256 indexed roundId, uint64 startTime, uint64 endTime);
    event CellPicked(uint256 indexed roundId, address indexed player, uint8 cell);
    event RoundResolved(uint256 indexed roundId, uint8 winningCell, uint256 winnersCount, bool isBonusRound);
    event WinningsPaid(uint256 indexed roundId, address indexed player, uint256 usdcAmount, uint256 zeroAmount);
    event EmptyRoundSkipped(uint256 indexed roundId);
    event ConfigUpdated(string key, uint256 value);

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

    // ══════════════════════════════════════════════════════════════
    // Resolver — AUTO-PAY winners during resolve
    // ══════════════════════════════════════════════════════════════

    function resolveRound(bytes32 vrfOutput, uint256 roundId) external nonReentrant {
        require(msg.sender == fulfiller, "Not fulfiller");
        require(roundId == currentRoundId, "Wrong round");

        Round storage round = rounds[currentRoundId];
        require(block.timestamp >= round.endTime, "Round not ended");
        require(!round.resolved, "Already resolved");
        require(round.totalPlayers > 0, "Use skipEmptyRound");

        // ─── Pick winner from occupied cells ───
        uint8[25] memory occupied;
        uint256 occupiedCount = 0;
        for (uint8 i = 0; i < 25; i++) {
            if (cellPlayers[currentRoundId][i].length > 0) {
                occupied[occupiedCount] = i;
                occupiedCount++;
            }
        }

        uint256 randomIndex = uint256(vrfOutput) % occupiedCount;
        uint8 winningCell = occupied[randomIndex];

        bool isBonus = (uint256(keccak256(abi.encodePacked(vrfOutput, "bonus"))) % bonusRoundOdds) == 0;

        round.winningCell = winningCell;
        round.resolved = true;
        round.isBonusRound = isBonus;

        address[] storage winners = cellPlayers[currentRoundId][winningCell];
        uint256 winnersCount = winners.length;

        // ─── Calculate payouts ───
        uint256 pool = round.totalDeposits;
        uint256 fee = (pool * protocolFeeBps) / BPS_BASE;
        accumulatedFees += fee;

        uint256 resolverCut = resolverReward;
        uint256 distributable;
        if (pool > fee + resolverCut) {
            distributable = pool - fee - resolverCut;
        } else {
            distributable = 0;
        }

        if (isBonus) {
            uint256 bonusAmount = distributable * bonusMultiplier;
            uint256 available = usdc.balanceOf(address(this)) > accumulatedFees
                ? usdc.balanceOf(address(this)) - accumulatedFees
                : 0;
            distributable = bonusAmount > available ? available : bonusAmount;
        }

        uint256 usdcPerWinner = winnersCount > 0 ? distributable / winnersCount : 0;
        uint256 zeroBase = isBonus ? motherlodePerRound : zeroPerRound;
        uint256 zeroPerWinner = winnersCount > 0 ? zeroBase / winnersCount : 0;

        // Store for transparency / frontend reads
        roundUsdcPerWinner[currentRoundId] = usdcPerWinner;
        roundZeroPerWinner[currentRoundId] = zeroPerWinner;

        // ─── AUTO-PAY all winners ───
        for (uint256 i = 0; i < winnersCount; i++) {
            address winner = winners[i];

            if (usdcPerWinner > 0) {
                usdc.safeTransfer(winner, usdcPerWinner);
            }
            if (zeroPerWinner > 0) {
                zeroToken.mint(winner, zeroPerWinner);
            }

            emit WinningsPaid(currentRoundId, winner, usdcPerWinner, zeroPerWinner);
        }

        // Pay resolver
        if (resolverCut > 0 && usdc.balanceOf(address(this)) >= resolverCut) {
            usdc.safeTransfer(fulfiller, resolverCut);
        }

        emit RoundResolved(currentRoundId, winningCell, winnersCount, isBonus);
        _startNewRound();
    }

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

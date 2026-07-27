// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DrandBeacon} from "./drand/DrandBeacon.sol";

interface IGroodToken {
    function mint(address to, uint256 amount) external;
}

/// @title Grood — drand-powered 5x5 grid game on Robinhood Chain
/// @notice 5x5 grid, USDG entry, drand beacon picks from OCCUPIED cells,
///         winnings sent automatically on resolve.
/// @dev Port of GridZeroV4 with the trusted-fulfiller VRF replaced by
///      on-chain verification of drand evmnet beacon signatures (BN254).
///      Every round pins the drand round number whose beacon is emitted
///      strictly AFTER entries close, so the randomness cannot exist while
///      betting is open, and resolution is permissionless: anyone holding
///      the public beacon signature can resolve and earn the resolver tip.
contract Grood is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant GRID_SIZE = 25;
    uint256 public constant BPS_BASE = 10_000;
    /// @notice If a round is still unresolved this long after it ended
    ///         (drand dead AND nobody resolved), it can be voided and
    ///         players refunded. Beacons are unchained, so any past round
    ///         stays resolvable forever under normal operation.
    uint256 public constant REFUND_DELAY = 30 days;

    IERC20 public immutable usdg;
    DrandBeacon public immutable beacon;
    IGroodToken public groodToken;

    address public feeRecipient;

    uint256 public entryFee = 1e6;              // 1 USDG (6 decimals)
    uint256 public roundDuration = 30;           // 30s
    uint256 public protocolFeeBps = 500;         // 5%
    uint256 public resolverReward = 0.1e6;       // 0.1 USDG

    uint256 public groodPerRound = 100e18;
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
        uint64 drandRound;
    }

    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(uint8 => address[])) public cellPlayers;
    mapping(uint256 => mapping(address => uint8)) public playerCell;

    // Track per-round payouts for transparency
    mapping(uint256 => uint256) public roundUsdcPerWinner;
    mapping(uint256 => uint256) public roundZeroPerWinner;

    // Liveness backstop
    mapping(uint256 => bool) public roundVoided;
    mapping(uint256 => mapping(address => bool)) public refunded;

    event RoundStarted(uint256 indexed roundId, uint64 startTime, uint64 endTime, uint64 drandRound);
    event CellPicked(uint256 indexed roundId, address indexed player, uint8 cell);
    event RoundResolved(uint256 indexed roundId, uint8 winningCell, uint256 winnersCount, bool isBonusRound);
    event WinningsPaid(uint256 indexed roundId, address indexed player, uint256 usdcAmount, uint256 zeroAmount);
    event RewardMintFailed(uint256 indexed roundId, address indexed player, uint256 zeroAmount);
    event EmptyRoundSkipped(uint256 indexed roundId);
    event RoundVoided(uint256 indexed roundId);
    event Refunded(uint256 indexed roundId, address indexed player, uint256 amount);
    event ConfigUpdated(string key, uint256 value);
    event FeeRecipientUpdated(address recipient);
    event GroodTokenUpdated(address token);

    constructor(
        address _usdg,
        address _groodToken,
        address _feeRecipient,
        address _beacon
    ) Ownable(msg.sender) {
        require(_usdg != address(0) && _beacon != address(0), "Zero address");
        usdg = IERC20(_usdg);
        groodToken = IGroodToken(_groodToken);
        feeRecipient = _feeRecipient;
        beacon = DrandBeacon(_beacon);
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

        usdg.safeTransferFrom(msg.sender, address(this), entryFee);

        playerCell[currentRoundId][msg.sender] = cell + 1;
        cellPlayers[currentRoundId][cell].push(msg.sender);

        round.totalDeposits += entryFee;
        round.totalPlayers++;

        emit CellPicked(currentRoundId, msg.sender, cell);
    }

    // ══════════════════════════════════════════════════════════════
    // Resolution — permissionless, drand-beacon verified, auto-pay
    // ══════════════════════════════════════════════════════════════

    /// @notice Resolve the current round with the drand beacon signature for
    ///         the round's pinned drand round. Anyone can call; the caller
    ///         earns `resolverReward`.
    /// @param roundId Round to resolve (must be the current round)
    /// @param signature drand evmnet BLS signature for `rounds[roundId].drandRound`,
    ///        as the uncompressed G1 point (x, y)
    function resolveRound(uint256 roundId, uint256[2] calldata signature) external nonReentrant {
        require(roundId == currentRoundId, "Wrong round");

        Round storage round = rounds[currentRoundId];
        require(block.timestamp >= round.endTime, "Round not ended");
        require(!round.resolved, "Already resolved");
        require(round.totalPlayers > 0, "Use skipEmptyRound");

        // Reverts if the signature is not the beacon's unique signature for
        // this drand round — nobody, including the caller, can bias it.
        beacon.verifyBeaconRound(round.drandRound, signature);
        bytes32 vrfOutput = keccak256(abi.encodePacked(signature[0], signature[1]));

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
            uint256 available = usdg.balanceOf(address(this)) > accumulatedFees
                ? usdg.balanceOf(address(this)) - accumulatedFees
                : 0;
            distributable = bonusAmount > available ? available : bonusAmount;
        }

        uint256 usdcPerWinner = winnersCount > 0 ? distributable / winnersCount : 0;
        uint256 zeroBase = isBonus ? motherlodePerRound : groodPerRound;
        uint256 zeroPerWinner = winnersCount > 0 ? zeroBase / winnersCount : 0;

        // Store for transparency / frontend reads
        roundUsdcPerWinner[currentRoundId] = usdcPerWinner;
        roundZeroPerWinner[currentRoundId] = zeroPerWinner;

        // ─── AUTO-PAY all winners ───
        for (uint256 i = 0; i < winnersCount; i++) {
            address winner = winners[i];

            if (usdcPerWinner > 0) {
                usdg.safeTransfer(winner, usdcPerWinner);
            }
            if (zeroPerWinner > 0) {
                // A misbehaving reward token must never block USDG payouts
                try groodToken.mint(winner, zeroPerWinner) {} catch {
                    emit RewardMintFailed(currentRoundId, winner, zeroPerWinner);
                }
            }

            emit WinningsPaid(currentRoundId, winner, usdcPerWinner, zeroPerWinner);
        }

        // Pay resolver
        if (resolverCut > 0 && usdg.balanceOf(address(this)) >= resolverCut) {
            usdg.safeTransfer(msg.sender, resolverCut);
        }

        emit RoundResolved(currentRoundId, winningCell, winnersCount, isBonus);
        _startNewRound();
    }

    /// @notice Skip an ended round with no players. Permissionless.
    function skipEmptyRound(uint256 roundId) external {
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
    // Liveness backstop — only matters if drand itself disappears
    // ══════════════════════════════════════════════════════════════

    /// @notice Void a round that has sat unresolved for REFUND_DELAY after it
    ///         ended, unfreezing the game and opening refunds. Permissionless.
    function voidStuckRound(uint256 roundId) external {
        require(roundId == currentRoundId, "Wrong round");

        Round storage round = rounds[currentRoundId];
        require(!round.resolved, "Already resolved");
        require(round.totalPlayers > 0, "Use skipEmptyRound");
        require(block.timestamp > uint256(round.endTime) + REFUND_DELAY, "Not stuck");

        round.resolved = true;
        roundVoided[currentRoundId] = true;
        emit RoundVoided(currentRoundId);
        _startNewRound();
    }

    /// @notice Reclaim the entry paid into a voided round.
    function refund(uint256 roundId) external nonReentrant {
        require(roundVoided[roundId], "Not voided");
        require(playerCell[roundId][msg.sender] != 0, "Not entered");
        require(!refunded[roundId][msg.sender], "Already refunded");

        refunded[roundId][msg.sender] = true;
        Round storage round = rounds[roundId];
        uint256 amount = round.totalDeposits / round.totalPlayers;
        usdg.safeTransfer(msg.sender, amount);
        emit Refunded(roundId, msg.sender, amount);
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
        if (!round.resolved || roundVoided[roundId]) return false;
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
        zeroPayout = groodPerRound / winnersOnCell;
    }

    // ══════════════════════════════════════════════════════════════
    // Internal
    // ══════════════════════════════════════════════════════════════

    function _startNewRound() internal {
        currentRoundId++;
        uint64 start = uint64(block.timestamp);
        uint64 end = start + uint64(roundDuration);
        // First beacon emitted at-or-after `end`, plus one full period of
        // safety margin: entries provably close before the beacon exists.
        uint64 drandRound = beacon.roundAt(end) + 1;

        rounds[currentRoundId] = Round({
            startTime: start,
            endTime: end,
            totalDeposits: 0,
            totalPlayers: 0,
            winningCell: 0,
            resolved: false,
            isBonusRound: false,
            drandRound: drandRound
        });

        emit RoundStarted(currentRoundId, start, end, drandRound);
    }

    // ══════════════════════════════════════════════════════════════
    // Admin
    // ══════════════════════════════════════════════════════════════

    function setFeeRecipient(address _v) external onlyOwner { require(_v != address(0), "Zero address"); feeRecipient = _v; emit FeeRecipientUpdated(_v); }
    function setGroodToken(address _v) external onlyOwner { require(_v != address(0), "Zero address"); groodToken = IGroodToken(_v); emit GroodTokenUpdated(_v); }
    function setEntryFee(uint256 _v) external onlyOwner { entryFee = _v; emit ConfigUpdated("entryFee", _v); }
    function setRoundDuration(uint256 _v) external onlyOwner { roundDuration = _v; emit ConfigUpdated("roundDuration", _v); }
    function setGroodPerRound(uint256 _v) external onlyOwner { groodPerRound = _v; emit ConfigUpdated("groodPerRound", _v); }
    function setProtocolFeeBps(uint256 _v) external onlyOwner { require(_v <= 2000, "Fee>20%"); protocolFeeBps = _v; emit ConfigUpdated("protocolFeeBps", _v); }
    function setResolverReward(uint256 _v) external onlyOwner { resolverReward = _v; emit ConfigUpdated("resolverReward", _v); }
    function setMotherlodePerRound(uint256 _v) external onlyOwner { motherlodePerRound = _v; emit ConfigUpdated("motherlodePerRound", _v); }
    function setBonusRoundOdds(uint256 _v) external onlyOwner { require(_v >= 10, "Too frequent"); bonusRoundOdds = _v; emit ConfigUpdated("bonusRoundOdds", _v); }
    function setBonusMultiplier(uint256 _v) external onlyOwner { require(_v >= 1 && _v <= 100, "1-100x"); bonusMultiplier = _v; emit ConfigUpdated("bonusMultiplier", _v); }

    function withdrawFees() external onlyOwner {
        uint256 amount = accumulatedFees;
        accumulatedFees = 0;
        usdg.safeTransfer(feeRecipient, amount);
    }

    function emergencyWithdrawUSDG() external onlyOwner {
        usdg.safeTransfer(owner(), usdg.balanceOf(address(this)));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BountyPool — auto bounty for Rite app users / agent makers
/// @notice 50% of research + agent fees are credited with the payer as entrant.
///         After INTERACTION_THRESHOLD (20) app/agent fee events, the round
///         auto-finalizes: one random weighted winner takes the full pool.
contract BountyPool {
    // -------------------------------------------------------------------------
    // Config
    // -------------------------------------------------------------------------

    address public owner;
    /// @notice Fee credits needed this round before auto-draw (research + agent)
    uint256 public interactionThreshold;
    /// @notice Contracts allowed to credit fees (ResearchDesk, RadarAgent, …)
    mapping(address => bool) public isFeeder;

    // -------------------------------------------------------------------------
    // Round state
    // -------------------------------------------------------------------------

    uint256 public roundId = 1;
    uint256 public roundStartedAt;
    uint256 public totalPoints;
    /// @notice Number of fee interactions this round (each credit = 1)
    uint256 public interactionCount;

    address[] private _entrants;
    mapping(address => uint256) public points;
    mapping(address => bool) private _inRound;

    // -------------------------------------------------------------------------
    // Last winner (site-wide banner)
    // -------------------------------------------------------------------------

    address public lastWinner;
    uint256 public lastPayout;
    uint256 public lastFinalizedAt;
    uint256 public lastRoundId;
    uint256 public totalPaidOut;
    uint256 public totalRoundsFinalized;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event FeederUpdated(address indexed feeder, bool allowed);
    event ThresholdUpdated(uint256 previous, uint256 next);
    event Credited(
        uint256 indexed roundId,
        address indexed user,
        uint256 amount,
        uint256 newPoints,
        uint256 interactionCount,
        address indexed feeder
    );
    event WinnerPaid(
        uint256 indexed roundId,
        address indexed winner,
        uint256 amount,
        uint256 entrants,
        uint256 totalPoints,
        uint256 interactions
    );
    event AutoFinalized(uint256 indexed roundId, address indexed winner, uint256 amount);
    event OwnershipTransferred(address indexed previous, address indexed next);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error NotOwner();
    error NotFeeder();
    error ZeroAddress();
    error ZeroAmount();
    error NoEntrants();
    error EmptyPool();
    error ThresholdNotMet(uint256 have, uint256 need);
    error TransferFailed();
    error BadThreshold();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param _threshold interactions per round before auto-draw (0 → default 20)
    constructor(uint256 _threshold) {
        owner = msg.sender;
        interactionThreshold = _threshold == 0 ? 20 : _threshold;
        roundStartedAt = block.timestamp;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ThresholdUpdated(0, interactionThreshold);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setFeeder(address feeder, bool allowed) external onlyOwner {
        if (feeder == address(0)) revert ZeroAddress();
        isFeeder[feeder] = allowed;
        emit FeederUpdated(feeder, allowed);
    }

    function setInteractionThreshold(uint256 next) external onlyOwner {
        if (next == 0) revert BadThreshold();
        emit ThresholdUpdated(interactionThreshold, next);
        interactionThreshold = next;
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    // -------------------------------------------------------------------------
    // Credit — each call is one interaction; may auto-finalize
    // -------------------------------------------------------------------------

    /// @notice Feeder contracts send bounty share; counts as 1 interaction.
    function credit(address user) external payable {
        if (!isFeeder[msg.sender]) revert NotFeeder();
        if (user == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();

        if (!_inRound[user]) {
            _inRound[user] = true;
            _entrants.push(user);
        }
        points[user] += msg.value;
        totalPoints += msg.value;
        interactionCount += 1;

        emit Credited(
            roundId, user, msg.value, points[user], interactionCount, msg.sender
        );

        // Auto-draw when threshold hit (random weighted winner)
        if (interactionCount >= interactionThreshold) {
            _finalizeIfReady(true);
        }
    }

    function sponsor() external payable onlyOwner {
        if (msg.value == 0) revert ZeroAmount();
    }

    // -------------------------------------------------------------------------
    // Finalize
    // -------------------------------------------------------------------------

    /// @notice Manual finalize only if interactions already hit the threshold
    ///         (backup if auto path was skipped). Anyone may call.
    function finalizeRound() external returns (address winner, uint256 amount) {
        if (interactionCount < interactionThreshold) {
            revert ThresholdNotMet(interactionCount, interactionThreshold);
        }
        return _finalizeIfReady(false);
    }

    /// @dev isAuto=true no-ops when not ready; isAuto=false reverts for manual callers.
    function _finalizeIfReady(bool isAuto) internal returns (address winner, uint256 amount) {
        uint256 n = _entrants.length;
        if (n == 0 || totalPoints == 0) {
            if (isAuto) return (address(0), 0);
            revert NoEntrants();
        }
        amount = address(this).balance;
        if (amount == 0) {
            if (isAuto) return (address(0), 0);
            revert EmptyPool();
        }
        if (interactionCount < interactionThreshold) {
            if (isAuto) return (address(0), 0);
            revert ThresholdNotMet(interactionCount, interactionThreshold);
        }

        // Random weighted lottery among entrants (weight = fee points)
        uint256 seed = uint256(
            keccak256(
                abi.encodePacked(
                    block.prevrandao,
                    block.timestamp,
                    block.number,
                    roundId,
                    totalPoints,
                    interactionCount,
                    n,
                    amount
                )
            )
        );
        uint256 ticket = seed % totalPoints;
        uint256 cursor;
        winner = _entrants[n - 1];
        for (uint256 i = 0; i < n; i++) {
            address e = _entrants[i];
            cursor += points[e];
            if (ticket < cursor) {
                winner = e;
                break;
            }
        }

        uint256 paidRound = roundId;
        uint256 nEntrants = n;
        uint256 pts = totalPoints;
        uint256 interactions = interactionCount;
        _resetRound();

        (bool ok,) = winner.call{value: amount}("");
        if (!ok) revert TransferFailed();

        lastWinner = winner;
        lastPayout = amount;
        lastFinalizedAt = block.timestamp;
        lastRoundId = paidRound;
        totalPaidOut += amount;
        totalRoundsFinalized += 1;

        emit WinnerPaid(paidRound, winner, amount, nEntrants, pts, interactions);
        if (isAuto) {
            emit AutoFinalized(paidRound, winner, amount);
        }
    }

    function _resetRound() internal {
        uint256 n = _entrants.length;
        for (uint256 i = 0; i < n; i++) {
            address e = _entrants[i];
            points[e] = 0;
            _inRound[e] = false;
        }
        delete _entrants;
        totalPoints = 0;
        interactionCount = 0;
        roundId += 1;
        roundStartedAt = block.timestamp;
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function poolBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function entrantCount() external view returns (uint256) {
        return _entrants.length;
    }

    function entrantAt(uint256 index) external view returns (address) {
        return _entrants[index];
    }

    function getEntrants() external view returns (address[] memory) {
        return _entrants;
    }

    function interactionsRemaining() external view returns (uint256) {
        if (interactionCount >= interactionThreshold) return 0;
        return interactionThreshold - interactionCount;
    }

    function canFinalize() external view returns (bool) {
        return interactionCount >= interactionThreshold
            && _entrants.length > 0
            && totalPoints > 0
            && address(this).balance > 0;
    }

    /// @notice Snapshot for the top-of-app banner.
    function lastWinnerInfo()
        external
        view
        returns (
            address winner,
            uint256 amount,
            uint256 finalizedAt,
            uint256 wonRoundId,
            uint256 currentPool,
            uint256 currentEntrants,
            uint256 currentRoundId,
            bool ready,
            uint256 interactions,
            uint256 threshold
        )
    {
        winner = lastWinner;
        amount = lastPayout;
        finalizedAt = lastFinalizedAt;
        wonRoundId = lastRoundId;
        currentPool = address(this).balance;
        currentEntrants = _entrants.length;
        currentRoundId = roundId;
        interactions = interactionCount;
        threshold = interactionThreshold;
        ready = interactionCount >= interactionThreshold
            && _entrants.length > 0
            && totalPoints > 0
            && address(this).balance > 0;
    }

    receive() external payable {}
}

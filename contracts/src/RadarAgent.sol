// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBountyPoolRadar {
    function credit(address user) external payable;
}

/// @title RadarAgent — persistent & sovereign data agents for Rite
/// @notice Two agent classes:
///         - Persistent: deploy fee 0.1 RITUAL, never dies from tick count
///         - Sovereign:  deploy fee 0.01 RITUAL, dies after 3 ticks
///         Deploy + run fees: 50% treasury, 50% BountyPool (auto bounty).
contract RadarAgent {
    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum Status {
        None, // 0
        Active, // 1
        Paused, // 2
        OutOfFunds, // 3
        Dead // 4 — sovereign finished its life (3 ticks)
    }

    enum AgentKind {
        Persistent, // 0 — immortal (by tick count)
        Sovereign // 1 — dies after maxRuns
    }

    struct Agent {
        address owner;
        Status status;
        AgentKind kind;
        uint256 balance; // native RITUAL held for run fees
        uint256 createdAt;
        uint256 lastRunAt;
        uint256 runCount;
        uint256 maxRuns; // 0 = unlimited (persistent); 3 = sovereign
        uint256 wakeIntervalBlocks;
        string name;
        bytes32 lastDigest;
        string lastTopic;
    }

    // -------------------------------------------------------------------------
    // Config
    // -------------------------------------------------------------------------

    uint256 public constant PERSISTENT_DEPLOY_FEE = 0.1 ether;
    uint256 public constant SOVEREIGN_DEPLOY_FEE = 0.01 ether;
    uint256 public constant SOVEREIGN_MAX_RUNS = 3;

    address public immutable treasury;
    address public immutable bountyPool;
    uint256 public runFee; // deducted per runTick → 50% treasury / 50% bounty

    uint256 public nextAgentId = 1;
    mapping(uint256 => Agent) public agents;
    mapping(uint256 => string[]) private _watchlist;
    mapping(address => uint256[]) private _byOwner;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event AgentCreated(
        uint256 indexed agentId,
        address indexed owner,
        string name,
        AgentKind kind,
        uint256 deployFee,
        uint256 fundedBalance
    );
    event AgentFunded(uint256 indexed agentId, address indexed from, uint256 amount, uint256 newBalance);
    event AgentWithdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event StatusChanged(uint256 indexed agentId, Status status);
    event WatchlistUpdated(uint256 indexed agentId, uint256 itemCount);
    event AgentTick(
        uint256 indexed agentId,
        address indexed caller,
        string topic,
        bytes32 digest,
        uint256 feePaid,
        uint256 runCount
    );
    event AgentDied(uint256 indexed agentId, AgentKind kind, uint256 runCount);
    event AgentKilled(uint256 indexed agentId, address indexed owner, uint256 refunded);
    event RunFeeUpdated(uint256 fee);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error NotOwner();
    error UnknownAgent();
    error BadName();
    error BadStatus();
    error BadKind();
    error InsufficientPayment();
    error InsufficientBalance();
    error EmptyWatchlist();
    error TransferFailed();
    error ZeroAmount();
    error AgentIsDead();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _treasury, address _bountyPool, uint256 _runFee) {
        require(_treasury != address(0), "treasury");
        require(_bountyPool != address(0), "bounty");
        treasury = _treasury;
        bountyPool = _bountyPool;
        runFee = _runFee == 0 ? 0.005 ether : _runFee;
    }

    /// @dev 50% → bounty (credits user), 50% → treasury
    function _splitFee(address user, uint256 amount) internal {
        uint256 toBounty = amount / 2;
        uint256 toTreasury = amount - toBounty;
        if (toBounty > 0) {
            IBountyPoolRadar(bountyPool).credit{value: toBounty}(user);
        }
        if (toTreasury > 0) {
            (bool ok,) = treasury.call{value: toTreasury}("");
            if (!ok) revert TransferFailed();
        }
    }

    // -------------------------------------------------------------------------
    // Views (fees / labels)
    // -------------------------------------------------------------------------

    function deployFee(AgentKind kind) public pure returns (uint256) {
        if (kind == AgentKind.Persistent) return PERSISTENT_DEPLOY_FEE;
        if (kind == AgentKind.Sovereign) return SOVEREIGN_DEPLOY_FEE;
        revert BadKind();
    }

    function statusLabel(Status s) external pure returns (string memory) {
        if (s == Status.None) return "None";
        if (s == Status.Active) return "Active";
        if (s == Status.Paused) return "Paused";
        if (s == Status.OutOfFunds) return "OutOfFunds";
        if (s == Status.Dead) return "Dead";
        return "?";
    }

    function kindLabel(AgentKind k) external pure returns (string memory) {
        if (k == AgentKind.Persistent) return "Persistent";
        if (k == AgentKind.Sovereign) return "Sovereign";
        return "?";
    }

    // -------------------------------------------------------------------------
    // Create / fund / control
    // -------------------------------------------------------------------------

    /// @notice Deploy an agent. `msg.value` must cover deploy fee; surplus funds run balance.
    /// @param kind Persistent (0.1 fee, never dies) or Sovereign (0.01 fee, dies after 3 ticks)
    function createAgent(string calldata name, uint256 wakeIntervalBlocks, AgentKind kind)
        external
        payable
        returns (uint256 agentId)
    {
        if (bytes(name).length == 0 || bytes(name).length > 64) revert BadName();
        if (kind != AgentKind.Persistent && kind != AgentKind.Sovereign) revert BadKind();

        uint256 fee = deployFee(kind);
        if (msg.value < fee) revert InsufficientPayment();

        uint256 funded = msg.value - fee;
        _splitFee(msg.sender, fee);

        agentId = nextAgentId++;
        uint256 maxRuns = kind == AgentKind.Sovereign ? SOVEREIGN_MAX_RUNS : 0;

        agents[agentId] = Agent({
            owner: msg.sender,
            status: Status.Paused,
            kind: kind,
            balance: funded,
            createdAt: block.timestamp,
            lastRunAt: 0,
            runCount: 0,
            maxRuns: maxRuns,
            wakeIntervalBlocks: wakeIntervalBlocks == 0 ? 1000 : wakeIntervalBlocks,
            name: name,
            lastDigest: bytes32(0),
            lastTopic: ""
        });
        _byOwner[msg.sender].push(agentId);

        emit AgentCreated(agentId, msg.sender, name, kind, fee, funded);
        if (funded > 0) {
            emit AgentFunded(agentId, msg.sender, funded, funded);
        }
        emit StatusChanged(agentId, Status.Paused);
    }

    function fundAgent(uint256 agentId) external payable {
        Agent storage a = _requireAgent(agentId);
        if (a.status == Status.Dead) revert AgentIsDead();
        if (msg.value == 0) revert ZeroAmount();
        a.balance += msg.value;
        if (a.status == Status.OutOfFunds && a.balance >= runFee) {
            a.status = Status.Paused;
            emit StatusChanged(agentId, Status.Paused);
        }
        emit AgentFunded(agentId, msg.sender, msg.value, a.balance);
    }

    /// @notice Withdraw unused RITUAL from agent balance back to owner.
    /// @dev Allowed even after kill so any residual can be recovered.
    function withdraw(uint256 agentId, uint256 amount) external {
        Agent storage a = _requireOwner(agentId);
        if (amount == 0 || amount > a.balance) revert InsufficientBalance();
        a.balance -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit AgentWithdrawn(agentId, msg.sender, amount);
        if (a.status != Status.Dead && a.balance < runFee && a.status == Status.Active) {
            a.status = Status.OutOfFunds;
            emit StatusChanged(agentId, Status.OutOfFunds);
        }
    }

    /// @notice Permanently kill agent (Persistent or Sovereign). Refunds full balance to owner.
    function killAgent(uint256 agentId) external {
        Agent storage a = _requireOwner(agentId);
        if (a.status == Status.Dead) revert AgentIsDead();

        uint256 refund = a.balance;
        a.balance = 0;
        a.status = Status.Dead;

        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert TransferFailed();
            emit AgentWithdrawn(agentId, msg.sender, refund);
        }

        emit StatusChanged(agentId, Status.Dead);
        emit AgentKilled(agentId, msg.sender, refund);
        emit AgentDied(agentId, a.kind, a.runCount);
    }

    function setActive(uint256 agentId) external {
        Agent storage a = _requireOwner(agentId);
        if (a.status == Status.Dead) revert AgentIsDead();
        if (a.balance < runFee) {
            a.status = Status.OutOfFunds;
            emit StatusChanged(agentId, Status.OutOfFunds);
            revert InsufficientBalance();
        }
        // Sovereign already used all lives
        if (a.maxRuns > 0 && a.runCount >= a.maxRuns) {
            a.status = Status.Dead;
            emit StatusChanged(agentId, Status.Dead);
            emit AgentDied(agentId, a.kind, a.runCount);
            revert AgentIsDead();
        }
        a.status = Status.Active;
        emit StatusChanged(agentId, Status.Active);
    }

    function setPaused(uint256 agentId) external {
        Agent storage a = _requireOwner(agentId);
        if (a.status == Status.Dead) revert AgentIsDead();
        a.status = Status.Paused;
        emit StatusChanged(agentId, Status.Paused);
    }

    function setWakeInterval(uint256 agentId, uint256 blocks_) external {
        Agent storage a = _requireOwner(agentId);
        if (a.status == Status.Dead) revert AgentIsDead();
        a.wakeIntervalBlocks = blocks_ == 0 ? 1000 : blocks_;
    }

    /// @notice Lock data stream (max 12 cells; app uses one `kind|target` cell).
    function setWatchlist(uint256 agentId, string[] calldata topics) external {
        Agent storage a = _requireOwner(agentId);
        if (a.status == Status.Dead) revert AgentIsDead();
        if (topics.length > 12) revert BadName();
        delete _watchlist[agentId];
        for (uint256 i = 0; i < topics.length; i++) {
            if (bytes(topics[i]).length == 0 || bytes(topics[i]).length > 48) revert BadName();
            _watchlist[agentId].push(topics[i]);
        }
        emit WatchlistUpdated(agentId, topics.length);
    }

    // -------------------------------------------------------------------------
    // Run tick
    // -------------------------------------------------------------------------

    /// @notice Pull is off-chain (Surf Data API); this seals the digest and charges runFee.
    function runTick(uint256 agentId, bytes32 digest) external {
        Agent storage a = _requireAgent(agentId);
        if (a.status == Status.Dead) revert AgentIsDead();
        if (a.status != Status.Active) revert BadStatus();
        if (_watchlist[agentId].length == 0) revert EmptyWatchlist();

        // Sovereign life check before charging
        if (a.maxRuns > 0 && a.runCount >= a.maxRuns) {
            a.status = Status.Dead;
            emit StatusChanged(agentId, Status.Dead);
            emit AgentDied(agentId, a.kind, a.runCount);
            revert AgentIsDead();
        }

        if (a.balance < runFee) {
            a.status = Status.OutOfFunds;
            emit StatusChanged(agentId, Status.OutOfFunds);
            revert InsufficientBalance();
        }

        a.balance -= runFee;
        // Credit agent owner for bounty eligibility
        _splitFee(a.owner, runFee);

        uint256 idx = a.runCount % _watchlist[agentId].length;
        string memory topic = _watchlist[agentId][idx];
        a.runCount += 1;
        a.lastRunAt = block.timestamp;
        a.lastTopic = topic;
        a.lastDigest =
            digest == bytes32(0) ? keccak256(abi.encodePacked(topic, block.timestamp, a.runCount)) : digest;

        emit AgentTick(agentId, msg.sender, topic, a.lastDigest, runFee, a.runCount);

        // Sovereign dies after 3rd successful tick
        if (a.maxRuns > 0 && a.runCount >= a.maxRuns) {
            a.status = Status.Dead;
            emit StatusChanged(agentId, Status.Dead);
            emit AgentDied(agentId, a.kind, a.runCount);
            return;
        }

        if (a.balance < runFee) {
            a.status = Status.OutOfFunds;
            emit StatusChanged(agentId, Status.OutOfFunds);
        }
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getAgent(uint256 agentId) external view returns (Agent memory) {
        return _requireAgentView(agentId);
    }

    function getWatchlist(uint256 agentId) external view returns (string[] memory) {
        _requireAgentView(agentId);
        return _watchlist[agentId];
    }

    function ownerAgentCount(address user) external view returns (uint256) {
        return _byOwner[user].length;
    }

    function ownerAgentIds(address user) external view returns (uint256[] memory) {
        return _byOwner[user];
    }

    function ticksRemaining(uint256 agentId) external view returns (uint256) {
        Agent memory a = _requireAgentView(agentId);
        if (a.maxRuns == 0) return type(uint256).max; // persistent
        if (a.runCount >= a.maxRuns) return 0;
        return a.maxRuns - a.runCount;
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _requireAgent(uint256 agentId) internal view returns (Agent storage a) {
        a = agents[agentId];
        if (a.owner == address(0)) revert UnknownAgent();
    }

    function _requireAgentView(uint256 agentId) internal view returns (Agent memory a) {
        a = agents[agentId];
        if (a.owner == address(0)) revert UnknownAgent();
    }

    function _requireOwner(uint256 agentId) internal view returns (Agent storage a) {
        a = _requireAgent(agentId);
        if (a.owner != msg.sender) revert NotOwner();
    }

    receive() external payable {}
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBountyPool {
    function credit(address user) external payable;
}

/// @title ResearchDesk — pay-per-prompt crypto research ledger on Ritual
/// @notice Users pay a fixed fee; 50% → treasury, 50% → BountyPool (auto bounty).
contract ResearchDesk {
    struct Record {
        address researcher;
        uint256 feePaid;
        uint256 paidAt;
        uint256 settledAt;
        bytes32 promptHash;
        bytes32 resultHash;
        bool settled;
    }

    address public owner;
    address public treasury;
    address public bountyPool;
    uint256 public researchFee;

    uint256 public nextId = 1;
    mapping(uint256 => Record) public records;
    mapping(address => uint256[]) private _byResearcher;

    event ResearchPaid(
        uint256 indexed id,
        address indexed researcher,
        bytes32 promptHash,
        uint256 fee,
        uint256 timestamp
    );
    event ResearchSettled(
        uint256 indexed id, address indexed researcher, bytes32 resultHash, uint256 timestamp
    );
    event TreasuryUpdated(address indexed previous, address indexed next);
    event BountyPoolUpdated(address indexed previous, address indexed next);
    event FeeUpdated(uint256 previous, uint256 next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    error NotOwner();
    error InvalidTreasury();
    error InvalidFee();
    error WrongPayment(uint256 expected, uint256 got);
    error UnknownId();
    error NotResearcher();
    error AlreadySettled();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _treasury, address _bountyPool, uint256 _fee) {
        if (_treasury == address(0)) revert InvalidTreasury();
        if (_bountyPool == address(0)) revert InvalidTreasury();
        if (_fee == 0) revert InvalidFee();
        owner = msg.sender;
        treasury = _treasury;
        bountyPool = _bountyPool;
        researchFee = _fee;
        emit OwnershipTransferred(address(0), msg.sender);
        emit TreasuryUpdated(address(0), _treasury);
        emit BountyPoolUpdated(address(0), _bountyPool);
        emit FeeUpdated(0, _fee);
    }

    function payForResearch(bytes32 promptHash) external payable returns (uint256 id) {
        if (msg.value != researchFee) revert WrongPayment(researchFee, msg.value);

        id = nextId++;
        records[id] = Record({
            researcher: msg.sender,
            feePaid: msg.value,
            paidAt: block.timestamp,
            settledAt: 0,
            promptHash: promptHash,
            resultHash: bytes32(0),
            settled: false
        });
        _byResearcher[msg.sender].push(id);

        // 50% bounty / 50% treasury
        uint256 toBounty = msg.value / 2;
        uint256 toTreasury = msg.value - toBounty;

        IBountyPool(bountyPool).credit{value: toBounty}(msg.sender);

        (bool ok,) = treasury.call{value: toTreasury}("");
        if (!ok) revert TransferFailed();

        emit ResearchPaid(id, msg.sender, promptHash, msg.value, block.timestamp);
    }

    function settleResearch(uint256 id, bytes32 resultHash) external {
        Record storage r = records[id];
        if (r.researcher == address(0)) revert UnknownId();
        if (r.researcher != msg.sender) revert NotResearcher();
        if (r.settled) revert AlreadySettled();

        r.resultHash = resultHash;
        r.settled = true;
        r.settledAt = block.timestamp;

        emit ResearchSettled(id, msg.sender, resultHash, block.timestamp);
    }

    function getRecord(uint256 id) external view returns (Record memory) {
        if (records[id].researcher == address(0)) revert UnknownId();
        return records[id];
    }

    function researcherCount(address user) external view returns (uint256) {
        return _byResearcher[user].length;
    }

    function researcherIds(address user) external view returns (uint256[] memory) {
        return _byResearcher[user];
    }

    function researcherIdAt(address user, uint256 index) external view returns (uint256) {
        return _byResearcher[user][index];
    }

    function setTreasury(address next) external onlyOwner {
        if (next == address(0)) revert InvalidTreasury();
        emit TreasuryUpdated(treasury, next);
        treasury = next;
    }

    function setBountyPool(address next) external onlyOwner {
        if (next == address(0)) revert InvalidTreasury();
        emit BountyPoolUpdated(bountyPool, next);
        bountyPool = next;
    }

    function setResearchFee(uint256 next) external onlyOwner {
        if (next == 0) revert InvalidFee();
        emit FeeUpdated(researchFee, next);
        researchFee = next;
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert InvalidTreasury();
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    receive() external payable {}
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RadarAgent} from "../src/RadarAgent.sol";
import {BountyPool} from "../src/BountyPool.sol";

contract RadarAgentTest is Test {
    RadarAgent radar;
    BountyPool pool;
    address treasury = makeAddr("treasury");
    address user = makeAddr("user");

    function setUp() public {
        pool = new BountyPool(20);
        radar = new RadarAgent(treasury, address(pool), 0.005 ether);
        pool.setFeeder(address(radar), true);
        vm.deal(user, 5 ether);
    }

    function test_PersistentDeployFeeAndImmortal() public {
        vm.startPrank(user);
        uint256 id = radar.createAgent{value: 0.15 ether}(
            "Persist", 500, RadarAgent.AgentKind.Persistent
        );
        RadarAgent.Agent memory a = radar.getAgent(id);
        assertEq(uint256(a.kind), uint256(RadarAgent.AgentKind.Persistent));
        assertEq(a.maxRuns, 0);
        assertEq(a.balance, 0.05 ether);
        // 0.1 deploy → 0.05 treasury + 0.05 bounty
        assertEq(treasury.balance, 0.05 ether);
        assertEq(address(pool).balance, 0.05 ether);

        string[] memory topics = new string[](1);
        topics[0] = "market_price|BTC";
        radar.setWatchlist(id, topics);
        radar.setActive(id);

        for (uint256 i = 0; i < 4; i++) {
            radar.runTick(id, keccak256(abi.encodePacked(i)));
        }
        a = radar.getAgent(id);
        assertEq(a.runCount, 4);
        assertTrue(uint256(a.status) != uint256(RadarAgent.Status.Dead));
        assertEq(uint256(a.status), uint256(RadarAgent.Status.Active));
        assertEq(radar.ticksRemaining(id), type(uint256).max);
        vm.stopPrank();
    }

    function test_SovereignDeployFeeAndDiesAfter3() public {
        vm.startPrank(user);
        uint256 id = radar.createAgent{value: 0.03 ether}(
            "Sov", 100, RadarAgent.AgentKind.Sovereign
        );
        RadarAgent.Agent memory a = radar.getAgent(id);
        assertEq(uint256(a.kind), uint256(RadarAgent.AgentKind.Sovereign));
        assertEq(a.maxRuns, 3);
        assertEq(a.balance, 0.02 ether);
        // 0.01 deploy → 0.005 each
        assertEq(treasury.balance, 0.005 ether);
        assertEq(address(pool).balance, 0.005 ether);

        string[] memory topics = new string[](1);
        topics[0] = "fear_greed|_";
        radar.setWatchlist(id, topics);
        radar.setActive(id);

        radar.runTick(id, bytes32(uint256(1)));
        radar.runTick(id, bytes32(uint256(2)));
        radar.runTick(id, bytes32(uint256(3)));

        a = radar.getAgent(id);
        assertEq(a.runCount, 3);
        assertEq(uint256(a.status), uint256(RadarAgent.Status.Dead));

        vm.expectRevert(RadarAgent.AgentIsDead.selector);
        radar.runTick(id, bytes32(uint256(4)));
        vm.stopPrank();
    }

    function test_CreateUnderpaysReverts() public {
        vm.startPrank(user);
        vm.expectRevert(RadarAgent.InsufficientPayment.selector);
        radar.createAgent{value: 0.05 ether}("Cheap", 100, RadarAgent.AgentKind.Persistent);

        vm.expectRevert(RadarAgent.InsufficientPayment.selector);
        radar.createAgent{value: 0.005 ether}("CheapSov", 100, RadarAgent.AgentKind.Sovereign);
        vm.stopPrank();
    }

    function test_DeployFeeConstants() public view {
        assertEq(radar.deployFee(RadarAgent.AgentKind.Persistent), 0.1 ether);
        assertEq(radar.deployFee(RadarAgent.AgentKind.Sovereign), 0.01 ether);
        assertEq(radar.PERSISTENT_DEPLOY_FEE(), 0.1 ether);
        assertEq(radar.SOVEREIGN_DEPLOY_FEE(), 0.01 ether);
        assertEq(radar.SOVEREIGN_MAX_RUNS(), 3);
    }

    function test_WithdrawAndKillRefund() public {
        vm.startPrank(user);
        uint256 id = radar.createAgent{value: 0.15 ether}(
            "KillMe", 100, RadarAgent.AgentKind.Persistent
        );
        // 0.05 left in agent after 0.1 deploy fee
        assertEq(radar.getAgent(id).balance, 0.05 ether);

        uint256 before = user.balance;
        radar.withdraw(id, 0.02 ether);
        assertEq(radar.getAgent(id).balance, 0.03 ether);
        assertEq(user.balance, before + 0.02 ether);

        before = user.balance;
        radar.killAgent(id);
        assertEq(uint256(radar.getAgent(id).status), uint256(RadarAgent.Status.Dead));
        assertEq(radar.getAgent(id).balance, 0);
        assertEq(user.balance, before + 0.03 ether);

        vm.expectRevert(RadarAgent.AgentIsDead.selector);
        radar.killAgent(id);
        vm.stopPrank();
    }
}

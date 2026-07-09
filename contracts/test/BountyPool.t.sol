// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BountyPool} from "../src/BountyPool.sol";
import {ResearchDesk} from "../src/ResearchDesk.sol";
import {RadarAgent} from "../src/RadarAgent.sol";

contract BountyPoolTest is Test {
    BountyPool pool;
    ResearchDesk desk;
    RadarAgent radar;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        // threshold 3 for fast tests (prod default 20)
        pool = new BountyPool(3);
        desk = new ResearchDesk(treasury, address(pool), 0.005 ether);
        radar = new RadarAgent(treasury, address(pool), 0.005 ether);
        pool.setFeeder(address(desk), true);
        pool.setFeeder(address(radar), true);

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function test_ResearchFeeSplits50_50() public {
        bytes32 h = keccak256("prompt");
        vm.prank(alice);
        desk.payForResearch{value: 0.005 ether}(h);

        assertEq(treasury.balance, 0.0025 ether);
        assertEq(address(pool).balance, 0.0025 ether);
        assertEq(pool.points(alice), 0.0025 ether);
        assertEq(pool.interactionCount(), 1);
        assertEq(pool.entrantCount(), 1);
    }

    function test_AutoFinalizeAtThreshold() public {
        bytes32 h = keccak256("p");
        // 3 interactions → auto finalize (threshold=3)
        vm.prank(alice);
        desk.payForResearch{value: 0.005 ether}(h);
        assertEq(pool.interactionCount(), 1);
        assertEq(pool.roundId(), 1);

        vm.prank(bob);
        desk.payForResearch{value: 0.005 ether}(h);
        assertEq(pool.interactionCount(), 2);
        assertEq(pool.roundId(), 1);

        uint256 poolBefore = address(pool).balance;
        assertGt(poolBefore, 0);

        vm.prank(alice);
        desk.payForResearch{value: 0.005 ether}(h);

        // auto finalized: pool empty, new round, winner set
        assertEq(address(pool).balance, 0);
        assertEq(pool.interactionCount(), 0);
        assertEq(pool.roundId(), 2);
        assertTrue(pool.lastWinner() == alice || pool.lastWinner() == bob);
        assertEq(pool.lastPayout(), poolBefore + 0.0025 ether); // third credit included before draw
        assertEq(pool.totalRoundsFinalized(), 1);
    }

    function test_ManualFinalizeBeforeThresholdReverts() public {
        bytes32 h = keccak256("p");
        vm.prank(alice);
        desk.payForResearch{value: 0.005 ether}(h);
        vm.expectRevert(
            abi.encodeWithSelector(BountyPool.ThresholdNotMet.selector, uint256(1), uint256(3))
        );
        pool.finalizeRound();
    }

    function test_AgentDeployCountsAsInteraction() public {
        vm.prank(alice);
        radar.createAgent{value: 0.03 ether}("A", 100, RadarAgent.AgentKind.Sovereign);
        assertEq(pool.interactionCount(), 1);
        assertEq(address(pool).balance, 0.005 ether); // half of 0.01 deploy
    }

    function test_DefaultThresholdIs20() public {
        BountyPool p2 = new BountyPool(0);
        assertEq(p2.interactionThreshold(), 20);
    }
}

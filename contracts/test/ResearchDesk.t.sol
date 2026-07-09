// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ResearchDesk} from "../src/ResearchDesk.sol";
import {BountyPool} from "../src/BountyPool.sol";

contract ResearchDeskTest is Test {
    ResearchDesk desk;
    BountyPool pool;
    address treasury = makeAddr("treasury");
    address user = makeAddr("user");

    function setUp() public {
        pool = new BountyPool(20);
        desk = new ResearchDesk(treasury, address(pool), 0.005 ether);
        pool.setFeeder(address(desk), true);
        vm.deal(user, 1 ether);
    }

    function test_PayAndSettle() public {
        vm.startPrank(user);
        bytes32 ph = keccak256("hello");
        uint256 id = desk.payForResearch{value: 0.005 ether}(ph);
        assertEq(treasury.balance, 0.0025 ether);
        assertEq(address(pool).balance, 0.0025 ether);

        desk.settleResearch(id, keccak256("result"));
        ResearchDesk.Record memory r = desk.getRecord(id);
        assertTrue(r.settled);
        vm.stopPrank();
    }

    function test_WrongFeeReverts() public {
        vm.prank(user);
        vm.expectRevert();
        desk.payForResearch{value: 0.001 ether}(keccak256("x"));
    }

    function test_OnlyResearcherSettles() public {
        vm.prank(user);
        uint256 id = desk.payForResearch{value: 0.005 ether}(keccak256("a"));
        address other = makeAddr("other");
        vm.prank(other);
        vm.expectRevert();
        desk.settleResearch(id, keccak256("r"));
    }
}

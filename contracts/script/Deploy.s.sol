// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ResearchDesk} from "../src/ResearchDesk.sol";

/// @dev Prefer script/DeployAll.s.sol for full stack.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envAddress("FEE_RECIPIENT_ADDRESS");
        address bounty = vm.envAddress("BOUNTY_POOL_ADDRESS");
        uint256 fee = vm.envOr("RESEARCH_FEE_WEI", uint256(0.005 ether));

        vm.startBroadcast(pk);
        ResearchDesk desk = new ResearchDesk(treasury, bounty, fee);
        vm.stopBroadcast();

        console2.log("ResearchDesk", address(desk));
        console2.log("treasury", treasury);
        console2.log("bounty", bounty);
        console2.log("fee wei", fee);
    }
}

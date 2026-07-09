// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ResearchDesk} from "../src/ResearchDesk.sol";

/// @dev forge script script/Deploy.s.sol:Deploy --rpc-url $RITUAL_RPC_URL --broadcast --private-key $PRIVATE_KEY
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envAddress("FEE_RECIPIENT_ADDRESS");
        uint256 fee = vm.envOr("RESEARCH_FEE_WEI", uint256(0.005 ether));

        vm.startBroadcast(pk);
        ResearchDesk desk = new ResearchDesk(treasury, fee);
        vm.stopBroadcast();

        console2.log("ResearchDesk", address(desk));
        console2.log("treasury", treasury);
        console2.log("fee wei", fee);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BountyPool} from "../src/BountyPool.sol";
import {ResearchDesk} from "../src/ResearchDesk.sol";
import {RadarAgent} from "../src/RadarAgent.sol";

/// @notice Deploy BountyPool + ResearchDesk + RadarAgent and wire feeders.
contract DeployAll is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envAddress("FEE_RECIPIENT_ADDRESS");
        uint256 fee = vm.envOr("RESEARCH_FEE_WEI", uint256(0.005 ether));
        // Auto-finalize after N interactions (default 20)
        uint256 threshold = vm.envOr("BOUNTY_INTERACTION_THRESHOLD", uint256(20));

        vm.startBroadcast(pk);

        BountyPool pool = new BountyPool(threshold);
        ResearchDesk desk = new ResearchDesk(treasury, address(pool), fee);
        RadarAgent radar = new RadarAgent(treasury, address(pool), fee);

        pool.setFeeder(address(desk), true);
        pool.setFeeder(address(radar), true);

        vm.stopBroadcast();

        console2.log("BountyPool", address(pool));
        console2.log("ResearchDesk", address(desk));
        console2.log("RadarAgent", address(radar));
        console2.log("treasury", treasury);
        console2.log("researchFee", fee);
        console2.log("interactionThreshold", threshold);
        console2.log("persistentDeploy", radar.PERSISTENT_DEPLOY_FEE());
        console2.log("sovereignDeploy", radar.SOVEREIGN_DEPLOY_FEE());
    }
}

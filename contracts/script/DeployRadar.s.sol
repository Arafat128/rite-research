// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RadarAgent} from "../src/RadarAgent.sol";

contract DeployRadar is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envAddress("FEE_RECIPIENT_ADDRESS");
        uint256 fee = vm.envOr("RESEARCH_FEE_WEI", uint256(0.005 ether));

        vm.startBroadcast(pk);
        RadarAgent radar = new RadarAgent(treasury, fee);
        vm.stopBroadcast();

        console2.log("RadarAgent", address(radar));
        console2.log("treasury", treasury);
        console2.log("runFee", fee);
        console2.log("persistentDeployFee", radar.PERSISTENT_DEPLOY_FEE());
        console2.log("sovereignDeployFee", radar.SOVEREIGN_DEPLOY_FEE());
        console2.log("sovereignMaxRuns", radar.SOVEREIGN_MAX_RUNS());
    }
}

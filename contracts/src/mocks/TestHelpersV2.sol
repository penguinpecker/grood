// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GroodV2} from "../GroodV2.sol";

/// @notice Winner whose receive() reverts — exercises the escrow/pull path
contract RevertingReceiver {
    function stakeVia(GroodV2 grood, uint256 roundId, uint8 cell) external payable {
        uint8[] memory cells = new uint8[](1);
        uint256[] memory amounts = new uint256[](1);
        cells[0] = cell;
        amounts[0] = msg.value;
        grood.stake{value: msg.value}(roundId, cells, amounts);
    }

    function withdrawVia(GroodV2 grood) external {
        allowReceive = true;
        grood.withdrawWinnings();
        allowReceive = false;
    }

    bool public allowReceive;

    receive() external payable {
        require(allowReceive, "no thanks");
    }
}

/// @notice Layout-safe next implementation for upgrade tests: appends one var
/// @custom:oz-upgrades-unsafe-allow constructor missing-initializer
contract GroodV2MockNext is GroodV2 {
    uint256 public newVar;

    function setNewVar(uint256 v) external {
        newVar = v;
    }

    function version() external pure returns (uint256) {
        return 2;
    }
}

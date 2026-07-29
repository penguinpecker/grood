// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../IZkVerifyAttestation.sol";

/**
 * @title MockZkVerifyAttestation
 * @notice Mock for testing — returns true for registered aggregation IDs
 */
contract MockZkVerifyAttestation is IZkVerifyAttestation {
    // domainId => aggregationId => root
    mapping(uint256 => mapping(uint256 => bytes32)) public override proofsAggregations;
    
    // For simple testing: aggregationId => valid
    mapping(uint256 => bool) public validAggregations;

    function setValidAggregation(uint256 domainId, uint256 aggregationId, bytes32 root) external {
        proofsAggregations[domainId][aggregationId] = root;
        validAggregations[aggregationId] = true;
    }

    /// @dev Simplified mock: returns true if the aggregationId has been registered
    function verifyProofAggregation(
        uint256 _domainId,
        uint256 _aggregationId,
        bytes32,
        bytes32[] calldata,
        uint256,
        uint256
    ) external view override returns (bool) {
        return proofsAggregations[_domainId][_aggregationId] != bytes32(0);
    }
}

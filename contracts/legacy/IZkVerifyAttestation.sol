// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IZkVerifyAttestation
 * @notice Interface for zkVerify's ZkVerifyAggregationGlobal contract on Base
 * @dev zkVerify aggregates proofs into Merkle trees per domain and posts roots
 *      to destination chains via relayers. This contract verifies a specific
 *      proof was included in an attested aggregation.
 *
 * Deployed addresses:
 *   Base Mainnet (proxy): 0xCb47A3C3B9Eb2E549a3F2EA4729De28CafbB2b69
 *   Base Sepolia (proxy): 0x312468EbF274F1f584d93d0CCA8458cC91460FC0
 *
 * @dev The leaf is computed off-chain as:
 *   leaf = keccak256(abi.encodePacked(PROVING_SYSTEM_ID, vkeyHash, VERSION_HASH, publicInputsHash))
 *   where PROVING_SYSTEM_ID = keccak256(abi.encodePacked("groth16")) for Circom/snarkjs proofs
 */
interface IZkVerifyAttestation {
    /**
     * @notice Verify that a proof was included in a zkVerify aggregation
     * @param _domainId The aggregation domain ID the proof was submitted to
     * @param _aggregationId The specific aggregation batch ID
     * @param _leaf The statement hash (leaf digest) of the verified proof
     * @param _merklePath The Merkle path from leaf to aggregation root
     * @param _leafCount Total number of leaves in the aggregation tree
     * @param _index Index of this proof's leaf in the tree
     * @return True if the proof was verified and included in the aggregation
     */
    function verifyProofAggregation(
        uint256 _domainId,
        uint256 _aggregationId,
        bytes32 _leaf,
        bytes32[] calldata _merklePath,
        uint256 _leafCount,
        uint256 _index
    ) external view returns (bool);

    /**
     * @notice Get the stored aggregation root for a domain/aggregation pair
     * @param _domainId The domain ID
     * @param _aggregationId The aggregation ID
     * @return The Merkle root of the aggregation (bytes32(0) if not posted)
     */
    function proofsAggregations(
        uint256 _domainId,
        uint256 _aggregationId
    ) external view returns (bytes32);
}

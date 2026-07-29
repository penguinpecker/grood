// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title GridZeroOre
 * @notice ERC1155 multi-token for GridZero ore types
 * @dev Token IDs 0-7 correspond to ore types (Stone → Mythril)
 *      Only the GridZero game contract can mint ores.
 */
contract GridZeroOre is ERC1155, Ownable {
    // Token IDs match OreType enum
    uint256 public constant STONE   = 0;
    uint256 public constant COAL    = 1;
    uint256 public constant IRON    = 2;
    uint256 public constant COPPER  = 3;
    uint256 public constant SILVER  = 4;
    uint256 public constant GOLD    = 5;
    uint256 public constant DIAMOND = 6;
    uint256 public constant MYTHRIL = 7;

    // Rare variants (token ID + 100)
    uint256 public constant RARE_OFFSET = 100;

    // Game contract authorized to mint
    address public gameContract;

    // Token names
    mapping(uint256 => string) public oreNames;

    event GameContractUpdated(address indexed oldContract, address indexed newContract);

    modifier onlyGame() {
        require(msg.sender == gameContract, "Only game contract");
        _;
    }

    constructor(string memory uri_) ERC1155(uri_) Ownable(msg.sender) {
        oreNames[STONE]   = "Stone";
        oreNames[COAL]    = "Coal";
        oreNames[IRON]    = "Iron";
        oreNames[COPPER]  = "Copper";
        oreNames[SILVER]  = "Silver";
        oreNames[GOLD]    = "Gold";
        oreNames[DIAMOND] = "Diamond";
        oreNames[MYTHRIL] = "Mythril";

        // Rare variants
        oreNames[STONE   + RARE_OFFSET] = "Rare Stone";
        oreNames[COAL    + RARE_OFFSET] = "Rare Coal";
        oreNames[IRON    + RARE_OFFSET] = "Rare Iron";
        oreNames[COPPER  + RARE_OFFSET] = "Rare Copper";
        oreNames[SILVER  + RARE_OFFSET] = "Rare Silver";
        oreNames[GOLD    + RARE_OFFSET] = "Rare Gold";
        oreNames[DIAMOND + RARE_OFFSET] = "Rare Diamond";
        oreNames[MYTHRIL + RARE_OFFSET] = "Rare Mythril";
    }

    /**
     * @notice Mint ore to a player after verified mining
     * @param to Player address
     * @param oreType Ore type (0-7)
     * @param isRare Whether this is a rare variant
     * @param amount Amount to mint (usually 1)
     */
    function mintOre(
        address to,
        uint256 oreType,
        bool isRare,
        uint256 amount
    ) external onlyGame {
        require(oreType < 8, "Invalid ore type");
        
        uint256 tokenId = isRare ? oreType + RARE_OFFSET : oreType;
        _mint(to, tokenId, amount, "");
    }

    /**
     * @notice Batch mint multiple ores
     */
    function batchMintOre(
        address to,
        uint256[] calldata oreTypes,
        bool[] calldata isRares,
        uint256[] calldata amounts
    ) external onlyGame {
        require(oreTypes.length == isRares.length, "Length mismatch");
        require(oreTypes.length == amounts.length, "Length mismatch");

        uint256[] memory ids = new uint256[](oreTypes.length);
        for (uint256 i = 0; i < oreTypes.length; i++) {
            require(oreTypes[i] < 8, "Invalid ore type");
            ids[i] = isRares[i] ? oreTypes[i] + RARE_OFFSET : oreTypes[i];
        }

        _mintBatch(to, ids, amounts, "");
    }

    /**
     * @notice Set the authorized game contract
     */
    function setGameContract(address _gameContract) external onlyOwner {
        address old = gameContract;
        gameContract = _gameContract;
        emit GameContractUpdated(old, _gameContract);
    }

    /**
     * @notice Update metadata URI
     */
    function setURI(string memory newuri) external onlyOwner {
        _setURI(newuri);
    }
}

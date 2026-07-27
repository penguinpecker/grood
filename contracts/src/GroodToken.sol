// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title $GROOD Token
/// @notice ERC20 token minted as rewards to Grood round winners
contract GroodToken is ERC20, Ownable {
    mapping(address => bool) public minters;

    event MinterUpdated(address indexed minter, bool allowed);

    constructor() ERC20("Grood", "GROOD") Ownable(msg.sender) {}

    modifier onlyMinter() {
        require(minters[msg.sender], "Not a minter");
        _;
    }

    function setMinter(address _minter, bool _allowed) external onlyOwner {
        minters[_minter] = _allowed;
        emit MinterUpdated(_minter, _allowed);
    }

    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }
}

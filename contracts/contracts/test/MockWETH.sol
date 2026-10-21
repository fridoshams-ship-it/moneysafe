// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestToken} from "../testnet/TestnetMarket.sol";

/// Local tests only: WETH9-style wrapper whose yield can be minted by the test market.
contract MockWETH is TestToken {
    constructor() TestToken("Wrapped Ether", "WETH", 18, 0) {}

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    receive() external payable {
        deposit();
    }
}

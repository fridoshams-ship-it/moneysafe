// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestToken} from "../testnet/TestnetMarket.sol";

/// Local tests only: a Compound III-like market with a fixed per-second supply rate and the read functions the app uses.
/// Interest is paid from a reserve sent to the contract at deployment.
contract LocalComet {
    TestToken public immutable base;
    uint64 public immutable ratePerSecond; // 1e18 scale, like Comet.getSupplyRate
    uint256 public immutable t0;
    mapping(address => uint256) public principalOf; // in "index units"

    constructor(TestToken b, uint256 aprBps) {
        base = b;
        ratePerSecond = uint64((aprBps * 1e18) / 10000 / 365 days);
        t0 = block.timestamp;
    }

    function baseToken() external view returns (address) { return address(base); }
    function getUtilization() external pure returns (uint64) { return 5e17; }
    function getSupplyRate(uint64) external view returns (uint64) { return ratePerSecond; }
    function index() public view returns (uint256) { return 1e18 + uint256(ratePerSecond) * (block.timestamp - t0); }
    function balanceOf(address a) public view returns (uint256) { return (principalOf[a] * index()) / 1e18; }

    function supply(address asset, uint256 amount) external {
        require(asset == address(base), "asset");
        IERC20(address(base)).transferFrom(msg.sender, address(this), amount);
        principalOf[msg.sender] += (amount * 1e18) / index();
    }

    function withdraw(address asset, uint256 amount) external {
        require(asset == address(base), "asset");
        uint256 bal = balanceOf(msg.sender);
        if (amount == type(uint256).max) amount = bal;
        require(amount <= bal, "insufficient");
        if (amount == bal) principalOf[msg.sender] = 0;
        else principalOf[msg.sender] -= (amount * 1e18 + index() - 1) / index();
        IERC20(address(base)).transfer(msg.sender, amount);
    }
}

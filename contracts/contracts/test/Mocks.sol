// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPool} from "../interfaces/IPool.sol";

/// Test-only token with configurable decimals.
contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// Test-only aToken: balances grow with a liquidity index, like Aave.
contract MockAToken {
    uint256 internal constant RAY = 1e27;
    MockPool public immutable pool;
    mapping(address => uint256) public scaledBalanceOf;

    constructor(MockPool p) {
        pool = p;
    }

    function balanceOf(address a) external view returns (uint256) {
        return (scaledBalanceOf[a] * pool.index()) / RAY;
    }

    function mintScaled(address to, uint256 amount) external {
        require(msg.sender == address(pool), "only pool");
        scaledBalanceOf[to] += (amount * RAY) / pool.index();
    }

    function burnAll(address from) external returns (uint256 amount) {
        require(msg.sender == address(pool), "only pool");
        amount = (scaledBalanceOf[from] * pool.index()) / RAY;
        scaledBalanceOf[from] = 0;
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == address(pool), "only pool");
        uint256 s = (amount * RAY + pool.index() - 1) / pool.index();
        scaledBalanceOf[from] = s >= scaledBalanceOf[from] ? 0 : scaledBalanceOf[from] - s;
    }
}

/// Test-only Aave V3 pool supporting one asset, interest via `setIndex`, and a pause switch.
contract MockPool {
    uint256 public index = 1e27;
    bool public paused;
    uint256 public liquidityCap = type(uint256).max; // simulates high utilization
    IERC20 public immutable underlying;
    MockAToken public immutable aToken;

    constructor(IERC20 u) {
        underlying = u;
        aToken = new MockAToken(this);
    }

    function setIndex(uint256 i) external {
        index = i;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setLiquidityCap(uint256 c) external {
        liquidityCap = c;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(!paused, "pool paused");
        require(asset == address(underlying), "asset");
        underlying.transferFrom(msg.sender, address(this), amount);
        aToken.mintScaled(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(!paused, "pool paused");
        require(asset == address(underlying), "asset");
        uint256 bal = aToken.balanceOf(msg.sender);
        uint256 out = amount == type(uint256).max ? bal : amount;
        require(out <= bal, "not enough balance");
        require(out <= liquidityCap, "not enough liquidity");
        if (out == bal) aToken.burnAll(msg.sender);
        else aToken.burn(msg.sender, out);
        underlying.transfer(to, out);
        return out;
    }

    function getReserveData(address asset) external view returns (IPool.ReserveData memory d) {
        if (asset == address(underlying)) d.aTokenAddress = address(aToken);
    }
}

/// Test-only USDT-like token: approve must go to zero before a new non-zero value.
contract MockUSDTLike is ERC20 {
    constructor() ERC20("Tether", "USDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        require(value == 0 || allowance(msg.sender, spender) == 0, "USDT: reset to 0 first");
        return super.approve(spender, value);
    }
}

/// Test-only Compound III market: base balance grows with an index; supports pause and max-withdraw.
contract MockComet {
    IERC20 public immutable base;
    uint256 public index = 1e18;
    bool public paused;
    mapping(address => uint256) public principalOf; // scaled by index

    constructor(IERC20 b) {
        base = b;
    }

    function baseToken() external view returns (address) {
        return address(base);
    }

    function setIndex(uint256 i) external {
        index = i;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function balanceOf(address a) public view returns (uint256) {
        return (principalOf[a] * index) / 1e18;
    }

    function supply(address asset, uint256 amount) external {
        require(!paused, "comet paused");
        require(asset == address(base), "asset");
        base.transferFrom(msg.sender, address(this), amount);
        principalOf[msg.sender] += (amount * 1e18) / index;
    }

    function withdraw(address asset, uint256 amount) external {
        require(!paused, "comet paused");
        require(asset == address(base), "asset");
        uint256 bal = balanceOf(msg.sender);
        if (amount == type(uint256).max) amount = bal;
        require(amount <= bal, "insufficient");
        if (amount == bal) principalOf[msg.sender] = 0;
        else principalOf[msg.sender] -= (amount * 1e18 + index - 1) / index;
        base.transfer(msg.sender, amount);
    }
}

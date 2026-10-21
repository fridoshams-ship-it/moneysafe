// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPool} from "../interfaces/IPool.sol";

/// @title Test tokens and an Aave-compatible lending market for the MoneySafe TESTNET beta.
/// @notice NOT FOR MAINNET. Tokens have no value. Anyone can take a limited amount from the faucet.
///         The market pays a fixed APR that accrues every second, so the app shows real on-chain yield.

/// Faucet token: anyone can mint `faucetAmount` once per `faucetCooldown`. The market may mint yield.
contract TestToken is ERC20 {
    uint8 private immutable _dec;
    uint256 public immutable faucetAmount;
    uint256 public constant faucetCooldown = 1 days;
    address public minter;
    mapping(address => uint256) public lastFaucet;

    error FaucetCooldown(uint256 nextAt);
    error OnlyMinter();

    constructor(string memory n, string memory s, uint8 d, uint256 faucetAmount_) ERC20(n, s) {
        _dec = d;
        faucetAmount = faucetAmount_;
        minter = msg.sender;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function setMinter(address m) external {
        if (msg.sender != minter) revert OnlyMinter();
        minter = m;
    }

    function faucet() external {
        uint256 next = lastFaucet[msg.sender] + faucetCooldown;
        if (lastFaucet[msg.sender] != 0 && block.timestamp < next) revert FaucetCooldown(next);
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert OnlyMinter();
        _mint(to, amount);
    }
}

/// Interest-bearing receipt, balance = scaled * current index (like an Aave aToken).
contract TestnetAToken {
    TestnetLendingPool public immutable pool;
    address public immutable underlying;
    mapping(address => uint256) public scaledBalanceOf;

    constructor(address underlying_) {
        pool = TestnetLendingPool(msg.sender);
        underlying = underlying_;
    }

    function balanceOf(address a) external view returns (uint256) {
        return (scaledBalanceOf[a] * pool.currentIndex(underlying)) / 1e27;
    }

    function setScaled(address a, uint256 v) external {
        require(msg.sender == address(pool), "only pool");
        scaledBalanceOf[a] = v;
    }
}

/// Aave-V3-compatible subset: supply / withdraw / getReserveData, with a fixed APR per asset.
contract TestnetLendingPool {
    uint256 internal constant RAY = 1e27;
    uint256 internal constant YEAR = 365 days;

    struct Reserve {
        TestnetAToken aToken;
        uint128 index; // ray, at `updatedAt`
        uint128 rate; // APR in ray
        uint40 updatedAt;
    }

    address public immutable admin;
    mapping(address => Reserve) public reserves;
    address[] public assets;

    event ReserveAdded(address indexed asset, address aToken, uint256 rateRay);

    constructor() {
        admin = msg.sender;
    }

    /// @param aprBps yearly rate in basis points (420 = 4.2%).
    function addReserve(address asset, uint256 aprBps) external {
        require(msg.sender == admin, "only admin");
        require(address(reserves[asset].aToken) == address(0), "exists");
        TestnetAToken a = new TestnetAToken(asset);
        reserves[asset] = Reserve(a, uint128(RAY), uint128((aprBps * RAY) / 10000), uint40(block.timestamp));
        assets.push(asset);
        emit ReserveAdded(asset, address(a), (aprBps * RAY) / 10000);
    }

    function currentIndex(address asset) public view returns (uint256) {
        Reserve memory r = reserves[asset];
        if (address(r.aToken) == address(0)) return RAY;
        return (uint256(r.index) * (RAY + (uint256(r.rate) * (block.timestamp - r.updatedAt)) / YEAR)) / RAY;
    }

    function _touch(address asset) internal returns (Reserve storage r, uint256 idx) {
        r = reserves[asset];
        require(address(r.aToken) != address(0), "no reserve");
        idx = currentIndex(asset);
        r.index = uint128(idx);
        r.updatedAt = uint40(block.timestamp);
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        (Reserve storage r, uint256 idx) = _touch(asset);
        require(ERC20(asset).transferFrom(msg.sender, address(this), amount), "transfer");
        r.aToken.setScaled(onBehalfOf, r.aToken.scaledBalanceOf(onBehalfOf) + (amount * RAY) / idx);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        (Reserve storage r, uint256 idx) = _touch(asset);
        uint256 scaled = r.aToken.scaledBalanceOf(msg.sender);
        uint256 bal = (scaled * idx) / RAY;
        uint256 out = amount == type(uint256).max ? bal : amount;
        require(out <= bal, "not enough balance");
        uint256 burn = out == bal ? scaled : (out * RAY + idx - 1) / idx;
        r.aToken.setScaled(msg.sender, scaled - burn);
        uint256 held = ERC20(asset).balanceOf(address(this));
        if (held < out) TestToken(asset).mint(address(this), out - held); // test yield is minted
        require(ERC20(asset).transfer(to, out), "transfer");
        return out;
    }

    function getReserveData(address asset) external view returns (IPool.ReserveData memory d) {
        Reserve memory r = reserves[asset];
        d.aTokenAddress = address(r.aToken);
        d.liquidityIndex = uint128(currentIndex(asset));
        d.currentLiquidityRate = r.rate;
        d.lastUpdateTimestamp = r.updatedAt;
    }
}

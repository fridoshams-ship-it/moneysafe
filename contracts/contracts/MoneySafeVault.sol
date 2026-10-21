// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IComet} from "./interfaces/IComet.sol";

/// @title MoneySafeVault
/// @notice One vault = one contract. Holds a single asset supplied to a lending market until `unlockTime`.
///         The market is Aave V3 or Compound III, fixed at creation.
///         There is NO early withdrawal, NO penalty path, NO admin function and NO way to change the date.
///         After `unlockTime` only `owner` can withdraw principal plus all earned yield — in full, or in parts
///         if the market temporarily lacks free liquidity.
/// @dev Deployed as an EIP-1167 minimal proxy by MoneySafeFactory.
contract MoneySafeVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant AAVE = 0;
    uint8 public constant COMET = 1;

    address public factory;
    address public owner;
    IERC20 public asset;
    uint8 public protocol;
    address public market; // Aave Pool or Comet market
    IERC20 public aToken; // Aave only; zero for Comet
    uint64 public unlockTime;
    uint64 public createdAt;
    uint256 public principal;
    uint256 public withdrawnTotal;
    bool public withdrawn; // true once the vault is fully emptied

    event Deposited(uint256 amount, uint256 totalPrincipal);
    event Withdrawn(address indexed to, uint256 amount, bool fully);

    error AlreadyInitialized();
    error OnlyFactory();
    error NotOwner();
    error StillLocked(uint64 unlockTime);
    error AlreadyWithdrawn();
    error NothingToSupply();
    error ZeroAddress();
    error ZeroAmount();
    error BadProtocol();

    /// @dev Locks the implementation contract so it can never be initialized directly.
    constructor() {
        factory = address(0xdead);
    }

    function initialize(address owner_, IERC20 asset_, uint8 protocol_, address market_, IERC20 aToken_, uint64 unlockTime_)
        external
    {
        if (factory != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0) || address(asset_) == address(0) || market_ == address(0)) revert ZeroAddress();
        if (protocol_ > COMET || (protocol_ == AAVE && address(aToken_) == address(0))) revert BadProtocol();
        factory = msg.sender;
        owner = owner_;
        asset = asset_;
        protocol = protocol_;
        market = market_;
        aToken = aToken_;
        unlockTime = unlockTime_;
        createdAt = uint64(block.timestamp);
    }

    /// @notice Supplies every idle token held by the vault to the market. Called by the factory right after a transfer.
    function supplyIdle() external {
        if (msg.sender != factory) revert OnlyFactory();
        uint256 idle = asset.balanceOf(address(this));
        if (idle == 0) revert NothingToSupply();
        principal += idle;
        asset.forceApprove(market, idle);
        if (protocol == AAVE) IPool(market).supply(address(asset), idle, address(this), 0);
        else IComet(market).supply(address(asset), idle);
        emit Deposited(idle, principal);
    }

    /// @notice Sends everything (principal + yield) to the owner. Works only on or after `unlockTime`.
    /// @dev If the market pauses or lacks liquidity this reverts atomically; retry later or use `withdrawPartial`.
    function withdraw() external nonReentrant {
        _withdraw(type(uint256).max);
    }

    /// @notice Sends `amount` to the owner (on or after `unlockTime`). Useful when market liquidity is temporarily short.
    function withdrawPartial(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _withdraw(amount);
    }

    function _withdraw(uint256 amount) internal {
        if (msg.sender != owner) revert NotOwner();
        if (block.timestamp < unlockTime) revert StillLocked(unlockTime);
        if (withdrawn) revert AlreadyWithdrawn();

        uint256 inMarket = _marketBalance();
        if (inMarket > 0) {
            uint256 idleBefore = asset.balanceOf(address(this));
            uint256 need = amount == type(uint256).max ? type(uint256).max : (amount > idleBefore ? amount - idleBefore : 0);
            if (need > 0) {
                uint256 req = need >= inMarket ? type(uint256).max : need;
                if (protocol == AAVE) IPool(market).withdraw(address(asset), req, address(this));
                else IComet(market).withdraw(address(asset), req);
            }
        }
        uint256 idle = asset.balanceOf(address(this));
        uint256 out = amount == type(uint256).max || amount > idle ? idle : amount;
        if (out > 0) asset.safeTransfer(owner, out);
        withdrawnTotal += out;
        bool fully = _marketBalance() == 0 && asset.balanceOf(address(this)) == 0;
        if (fully) withdrawn = true;
        emit Withdrawn(owner, out, fully);
    }

    function _marketBalance() internal view returns (uint256) {
        return protocol == AAVE ? aToken.balanceOf(address(this)) : IComet(market).balanceOf(address(this));
    }

    // ---------- views ----------

    /// @notice Current value still in the vault (principal + accrued yield − already withdrawn).
    function balance() public view returns (uint256) {
        if (withdrawn) return 0;
        return _marketBalance() + asset.balanceOf(address(this));
    }

    /// @notice Total yield earned over the vault's life, including parts already withdrawn.
    function earned() external view returns (uint256) {
        uint256 total = balance() + withdrawnTotal;
        return total > principal ? total - principal : 0;
    }

    function isUnlocked() public view returns (bool) {
        return block.timestamp >= unlockTime;
    }

    function timeLeft() external view returns (uint256) {
        return isUnlocked() ? 0 : unlockTime - block.timestamp;
    }
}

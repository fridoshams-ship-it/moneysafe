// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IComet} from "./interfaces/IComet.sol";

/// @title MoneySafeAllowance — "money for every day"
/// @notice One budget = one contract. The owner deposits a sum (e.g. 200 USDC) and a portion per period
///         (e.g. 20 USDC per day). One portion becomes available at the start of every period, starting with the first.
///         Portions not taken stay available (they accumulate); nothing can be taken ahead of time.
///         Rules that make the budget impossible to cheat:
///           • lowering the portion is allowed at any time;
///           • raising it is allowed only 30 days after the last change;
///           • any change applies from the NEXT period — today's portion is never recalculated.
///         The money waits in Aave V3 or Compound III; the yield is released together with the last portion.
///         There is no admin function, and nobody — including MoneySafe — can release money faster.
/// @dev Deployed as an EIP-1167 minimal proxy by MoneySafeFactory.
contract MoneySafeAllowance is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant AAVE = 0;
    uint8 public constant COMET = 1;
    uint64 public constant RAISE_COOLDOWN = 30 days;

    address public factory;
    address public owner;
    IERC20 public asset;
    uint8 public protocol;
    address public market;
    IERC20 public aToken;
    uint64 public createdAt;
    uint64 public start; // first portion is available from this moment
    uint64 public period; // 1 day or 7 days
    uint64 public lastRateChange;
    uint256 public rate; // amount released per period
    uint256 public deposited; // total principal put in
    uint256 public withdrawnTotal;
    uint256 public checkpointPeriods; // periods already counted into accruedAtCheckpoint
    uint256 public accruedAtCheckpoint;
    bool public closed; // true once fully emptied

    event Deposited(uint256 amount, uint256 totalDeposited);
    event Withdrawn(address indexed to, uint256 amount, bool fully);
    event RateChanged(uint256 oldRate, uint256 newRate, uint256 effectiveFromPeriod);

    error AlreadyInitialized();
    error OnlyFactory();
    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error BadProtocol();
    error NothingToSupply();
    error MoreThanAvailable(uint256 available);
    error RaiseTooSoon(uint64 allowedFrom);
    error SameRate();
    error Closed();

    constructor() {
        factory = address(0xdead);
    }

    function initialize(
        address owner_,
        IERC20 asset_,
        uint8 protocol_,
        address market_,
        IERC20 aToken_,
        uint256 rate_,
        uint64 period_,
        uint64 start_
    ) external {
        if (factory != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0) || address(asset_) == address(0) || market_ == address(0)) revert ZeroAddress();
        if (protocol_ > COMET || (protocol_ == AAVE && address(aToken_) == address(0))) revert BadProtocol();
        if (rate_ == 0) revert ZeroAmount();
        factory = msg.sender;
        owner = owner_;
        asset = asset_;
        protocol = protocol_;
        market = market_;
        aToken = aToken_;
        rate = rate_;
        period = period_;
        start = start_;
        createdAt = uint64(block.timestamp);
        lastRateChange = uint64(block.timestamp);
    }

    function supplyIdle() external {
        if (msg.sender != factory) revert OnlyFactory();
        if (closed) revert Closed();
        uint256 idle = asset.balanceOf(address(this));
        if (idle == 0) revert NothingToSupply();
        // Top-ups join the schedule from the next period: unused "virtual" portions beyond the old deposit never count.
        uint256 n = periodsAt(block.timestamp);
        if (deposited > 0 && n > checkpointPeriods) {
            accruedAtCheckpoint = released();
            checkpointPeriods = n;
        }
        deposited += idle;
        asset.forceApprove(market, idle);
        if (protocol == AAVE) IPool(market).supply(address(asset), idle, address(this), 0);
        else IComet(market).supply(address(asset), idle);
        emit Deposited(idle, deposited);
    }

    // ---------- schedule ----------

    /// @notice Number of periods that have started by `t` (the first one starts at `start`).
    function periodsAt(uint256 t) public view returns (uint256) {
        return t < start ? 0 : (t - start) / period + 1;
    }

    /// @notice Principal released so far (portions of all started periods), capped at the deposited amount.
    function released() public view returns (uint256) {
        uint256 r = accruedAtCheckpoint + rate * (periodsAt(block.timestamp) - checkpointPeriods);
        return r > deposited ? deposited : r;
    }

    /// @notice What the owner can take right now. After the last portion this includes all earned yield.
    function available() public view returns (uint256) {
        if (closed) return 0;
        uint256 bal = balance();
        uint256 r = released();
        if (r >= deposited) return bal;
        uint256 a = r > withdrawnTotal ? r - withdrawnTotal : 0;
        return a > bal ? bal : a;
    }

    /// @notice When the next portion opens (0 if everything is already released).
    function nextReleaseAt() external view returns (uint256) {
        if (released() >= deposited) return 0;
        uint256 n = periodsAt(block.timestamp);
        return uint256(start) + n * period;
    }

    /// @notice When the last portion opens at the current rate.
    function endsAt() external view returns (uint256) {
        uint256 r = released();
        if (r >= deposited) return block.timestamp;
        uint256 left = (deposited - r + rate - 1) / rate; // periods still needed
        return uint256(start) + (periodsAt(block.timestamp) + left - 1) * period;
    }

    // ---------- owner ----------

    function withdraw(uint256 amount) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        if (amount == 0) revert ZeroAmount();
        uint256 avail = available();
        if (amount == type(uint256).max) amount = avail;
        if (amount == 0 || amount > avail) revert MoreThanAvailable(avail);

        uint256 idleBefore = asset.balanceOf(address(this));
        if (amount > idleBefore) {
            uint256 need = amount - idleBefore;
            uint256 inMarket = _marketBalance();
            uint256 req = need >= inMarket ? type(uint256).max : need;
            if (protocol == AAVE) IPool(market).withdraw(address(asset), req, address(this));
            else IComet(market).withdraw(address(asset), req);
        }
        uint256 idle = asset.balanceOf(address(this));
        uint256 out = amount > idle ? idle : amount;
        asset.safeTransfer(owner, out);
        withdrawnTotal += out;
        bool fully = _marketBalance() == 0 && asset.balanceOf(address(this)) == 0;
        if (fully) closed = true;
        emit Withdrawn(owner, out, fully);
    }

    /// @notice Changes the portion per period, starting from the next period.
    ///         Lowering: any time. Raising: only `RAISE_COOLDOWN` after the last change.
    function setRate(uint256 newRate) external {
        if (msg.sender != owner) revert NotOwner();
        if (closed) revert Closed();
        if (newRate == 0) revert ZeroAmount();
        if (newRate == rate) revert SameRate();
        if (newRate > rate && block.timestamp < uint256(lastRateChange) + RAISE_COOLDOWN) {
            revert RaiseTooSoon(lastRateChange + RAISE_COOLDOWN);
        }
        uint256 n = periodsAt(block.timestamp);
        accruedAtCheckpoint = accruedAtCheckpoint + rate * (n - checkpointPeriods);
        checkpointPeriods = n;
        emit RateChanged(rate, newRate, n + 1);
        rate = newRate;
        lastRateChange = uint64(block.timestamp);
    }

    // ---------- views ----------

    function _marketBalance() internal view returns (uint256) {
        return protocol == AAVE ? aToken.balanceOf(address(this)) : IComet(market).balanceOf(address(this));
    }

    function balance() public view returns (uint256) {
        if (closed) return 0;
        return _marketBalance() + asset.balanceOf(address(this));
    }

    function earned() external view returns (uint256) {
        uint256 total = balance() + withdrawnTotal;
        return total > deposited ? total - deposited : 0;
    }
}

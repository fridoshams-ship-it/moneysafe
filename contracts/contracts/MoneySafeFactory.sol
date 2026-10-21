// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IComet} from "./interfaces/IComet.sol";
import {MoneySafeVault} from "./MoneySafeVault.sol";
import {MoneySafeAllowance} from "./MoneySafeAllowance.sol";

/// @title MoneySafeFactory
/// @notice Creates a separate MoneySafeVault contract for every safe a user opens.
///         Supported markets per chain are fixed at deployment: one Aave V3 Pool and a list of Compound III markets.
///         The factory owner can only (1) switch an asset on or off for NEW vaults and (2) pause NEW deposits.
///         The owner can never add a new market address, touch, move, unlock or extend any existing vault.
contract MoneySafeFactory is Ownable2Step {
    using SafeERC20 for IERC20;

    uint8 public constant AAVE = 0;
    uint8 public constant COMET = 1;
    uint64 public constant MIN_LOCK = 1 days;
    uint64 public constant MAX_LOCK = 3650 days;
    uint256 public constant MAX_GOAL_BYTES = 64;

    IPool public immutable pool;
    address public immutable vaultImplementation;
    address public immutable allowanceImplementation;
    uint64 public constant MAX_START_DELAY = 365 days;

    bool public depositsPaused;
    /// @notice Aave: asset => aToken (zero = not allowed).
    mapping(address asset => address aToken) public aTokenOf;
    /// @notice Compound III markets fixed at deployment: base asset => Comet. Never changes after the constructor.
    mapping(address asset => address comet) public cometMarketOf;
    /// @notice Compound III: asset switched on for new vaults.
    mapping(address asset => bool) public cometAllowed;
    /// @notice Beta limit: max principal per vault for an asset (0 = no limit). Limits NEW deposits only.
    mapping(address asset => uint256) public vaultCap;
    mapping(address vault => bool) public isVault;
    mapping(address user => address[]) private _vaultsOf;
    mapping(address allowance => bool) public isAllowance;
    mapping(address user => address[]) private _allowancesOf;

    event AssetSet(address indexed asset, uint8 indexed protocol, address market, bool allowed);
    event DepositsPaused(bool paused);
    event VaultCapSet(address indexed asset, uint256 cap);
    event VaultCreated(address indexed owner, address indexed vault, address indexed asset, uint256 amount, uint64 unlockTime, string goal);
    event VaultMarket(address indexed vault, uint8 protocol, address market);
    event VaultGifted(address indexed from, address indexed recipient, address indexed vault);
    event VaultToppedUp(address indexed vault, address indexed from, uint256 amount);
    event AllowanceCreated(address indexed owner, address indexed allowance, address indexed asset, uint256 amount, uint256 rate, uint64 period, uint64 start, string goal);
    event AllowanceToppedUp(address indexed allowance, address indexed from, uint256 amount);

    error DepositsArePaused();
    error AssetNotAllowed();
    error ZeroAmount();
    error BadUnlockTime();
    error UnknownVault();
    error VaultUnlocked();
    error ATokenMismatch();
    error GoalTooLong();
    error ZeroRecipient();
    error BadProtocol();
    error NoCometMarket();
    error AboveVaultCap();
    error BadPeriod();
    error BadStart();
    error RateAboveAmount();

    /// @param pool_ Aave V3 Pool of this chain (zero if Aave is not used on this chain).
    /// @param comets_ Compound III markets of this chain. Each one's base token becomes a possible asset.
    constructor(IPool pool_, address[] memory comets_, address owner_) Ownable(owner_) {
        pool = pool_;
        vaultImplementation = address(new MoneySafeVault());
        allowanceImplementation = address(new MoneySafeAllowance());
        for (uint256 i; i < comets_.length; ++i) {
            address base = IComet(comets_[i]).baseToken();
            cometMarketOf[base] = comets_[i];
        }
    }

    // ---------- admin (cannot affect existing vaults) ----------

    /// @notice Allows an asset on Aave. The aToken is read from Aave itself, so it cannot be set wrong.
    function allowAsset(address asset) external onlyOwner {
        if (address(pool) == address(0)) revert ATokenMismatch();
        address aToken = pool.getReserveData(asset).aTokenAddress;
        if (aToken == address(0)) revert ATokenMismatch();
        aTokenOf[asset] = aToken;
        emit AssetSet(asset, AAVE, aToken, true);
    }

    /// @notice Allows an asset on its Compound III market (only markets fixed at deployment).
    function allowComet(address asset) external onlyOwner {
        address comet = cometMarketOf[asset];
        if (comet == address(0)) revert NoCometMarket();
        cometAllowed[asset] = true;
        emit AssetSet(asset, COMET, comet, true);
    }

    /// @notice Stops new vaults in this asset on the given protocol. Existing vaults are unaffected.
    function disallowAsset(address asset, uint8 protocol) external onlyOwner {
        if (protocol == AAVE) delete aTokenOf[asset];
        else if (protocol == COMET) delete cometAllowed[asset];
        else revert BadProtocol();
        emit AssetSet(asset, protocol, address(0), false);
    }

    /// @notice Pauses NEW deposits only. Withdrawals from vaults can never be paused by MoneySafe.
    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    /// @notice Sets the beta limit per vault for an asset (0 removes it). Only affects new deposits and top-ups.
    function setVaultCap(address asset, uint256 cap) external onlyOwner {
        vaultCap[asset] = cap;
        emit VaultCapSet(asset, cap);
    }

    // ---------- users ----------

    /// @notice Opens a new safe on Aave for the caller.
    function createVault(address asset, uint256 amount, uint64 unlockTime, string calldata goal) external returns (address vault) {
        vault = _create(AAVE, msg.sender, asset, amount, unlockTime, goal);
    }

    /// @notice Opens a safe on Aave as a gift: the caller pays, `recipient` becomes the only owner.
    function createVaultFor(address recipient, address asset, uint256 amount, uint64 unlockTime, string calldata goal)
        external
        returns (address vault)
    {
        vault = _gift(AAVE, recipient, asset, amount, unlockTime, goal);
    }

    /// @notice General form: choose the protocol (0 = Aave V3, 1 = Compound III) and the owner.
    ///         `recipient == msg.sender` opens your own safe; any other address makes it a gift.
    function createVaultWith(uint8 protocol, address recipient, address asset, uint256 amount, uint64 unlockTime, string calldata goal)
        external
        returns (address vault)
    {
        vault = recipient == msg.sender
            ? _create(protocol, msg.sender, asset, amount, unlockTime, goal)
            : _gift(protocol, recipient, asset, amount, unlockTime, goal);
    }

    function _gift(uint8 protocol, address recipient, address asset, uint256 amount, uint64 unlockTime, string calldata goal)
        internal
        returns (address vault)
    {
        if (recipient == address(0)) revert ZeroRecipient();
        vault = _create(protocol, recipient, asset, amount, unlockTime, goal);
        emit VaultGifted(msg.sender, recipient, vault);
    }

    function _create(uint8 protocol, address owner_, address asset, uint256 amount, uint64 unlockTime, string calldata goal)
        internal
        returns (address vault)
    {
        if (depositsPaused) revert DepositsArePaused();
        address market;
        address aToken;
        if (protocol == AAVE) {
            aToken = aTokenOf[asset];
            if (aToken == address(0)) revert AssetNotAllowed();
            market = address(pool);
        } else if (protocol == COMET) {
            if (!cometAllowed[asset]) revert AssetNotAllowed();
            market = cometMarketOf[asset];
        } else {
            revert BadProtocol();
        }
        if (amount == 0) revert ZeroAmount();
        uint256 cap = vaultCap[asset];
        if (cap != 0 && amount > cap) revert AboveVaultCap();
        if (unlockTime < block.timestamp + MIN_LOCK || unlockTime > block.timestamp + MAX_LOCK) revert BadUnlockTime();
        if (bytes(goal).length > MAX_GOAL_BYTES) revert GoalTooLong();

        vault = Clones.clone(vaultImplementation);
        MoneySafeVault(vault).initialize(owner_, IERC20(asset), protocol, market, IERC20(aToken), unlockTime);
        isVault[vault] = true;
        _vaultsOf[owner_].push(vault);

        IERC20(asset).safeTransferFrom(msg.sender, vault, amount);
        MoneySafeVault(vault).supplyIdle();

        emit VaultCreated(owner_, vault, asset, amount, unlockTime, goal);
        emit VaultMarket(vault, protocol, market);
    }

    /// @notice Adds more funds to an existing safe. Anyone may top up (e.g. a gift); funds always belong to the vault owner.
    ///         The unlock date does not change.
    function topUp(address vault, uint256 amount) external {
        if (depositsPaused) revert DepositsArePaused();
        if (!isVault[vault]) revert UnknownVault();
        if (amount == 0) revert ZeroAmount();
        MoneySafeVault v = MoneySafeVault(vault);
        if (v.isUnlocked()) revert VaultUnlocked();
        uint256 cap = vaultCap[address(v.asset())];
        if (cap != 0 && v.principal() + amount > cap) revert AboveVaultCap();

        v.asset().safeTransferFrom(msg.sender, vault, amount);
        v.supplyIdle();
        emit VaultToppedUp(vault, msg.sender, amount);
    }

    // ---------- money for every day ----------

    /// @notice Opens a budget: `amount` is released `rate` per `period` (1 day or 7 days), the first portion at `start`.
    /// @param start_ 0 = now; otherwise a moment within the next year.
    function createAllowance(uint8 protocol, address asset, uint256 amount, uint256 rate, uint64 period, uint64 start_, string calldata goal)
        external
        returns (address allowance)
    {
        if (depositsPaused) revert DepositsArePaused();
        if (amount == 0 || rate == 0) revert ZeroAmount();
        if (rate > amount) revert RateAboveAmount();
        uint256 cap = vaultCap[asset];
        if (cap != 0 && amount > cap) revert AboveVaultCap();
        if (period != 1 days && period != 7 days) revert BadPeriod();
        uint64 st = start_ == 0 ? uint64(block.timestamp) : start_;
        if (st < block.timestamp || st > block.timestamp + MAX_START_DELAY) revert BadStart();
        if (bytes(goal).length > MAX_GOAL_BYTES) revert GoalTooLong();

        allowance = _deployAllowance(protocol, asset, rate, period, st);
        _allowancesOf[msg.sender].push(allowance);

        IERC20(asset).safeTransferFrom(msg.sender, allowance, amount);
        MoneySafeAllowance(allowance).supplyIdle();
        emit AllowanceCreated(msg.sender, allowance, asset, amount, rate, period, st, goal);
    }

    /// @notice Adds money to a budget. It is released after what is already scheduled, at the same rate.
    function topUpAllowance(address allowance, uint256 amount) external {
        if (depositsPaused) revert DepositsArePaused();
        if (!isAllowance[allowance]) revert UnknownVault();
        if (amount == 0) revert ZeroAmount();
        MoneySafeAllowance a = MoneySafeAllowance(allowance);
        uint256 cap = vaultCap[address(a.asset())];
        if (cap != 0 && a.deposited() - a.withdrawnTotal() + amount > cap) revert AboveVaultCap();
        a.asset().safeTransferFrom(msg.sender, allowance, amount);
        a.supplyIdle();
        emit AllowanceToppedUp(allowance, msg.sender, amount);
    }

    function allowancesOf(address user) external view returns (address[] memory) {
        return _allowancesOf[user];
    }

    function _deployAllowance(uint8 protocol, address asset, uint256 rate, uint64 period, uint64 st) internal returns (address allowance) {
        (address market, address aToken) = _market(protocol, asset);
        allowance = Clones.clone(allowanceImplementation);
        MoneySafeAllowance(allowance).initialize(msg.sender, IERC20(asset), protocol, market, IERC20(aToken), rate, period, st);
        isAllowance[allowance] = true;
    }

    function _market(uint8 protocol, address asset) internal view returns (address market, address aToken) {
        if (protocol == AAVE) {
            aToken = aTokenOf[asset];
            if (aToken == address(0)) revert AssetNotAllowed();
            market = address(pool);
        } else if (protocol == COMET) {
            if (!cometAllowed[asset]) revert AssetNotAllowed();
            market = cometMarketOf[asset];
        } else {
            revert BadProtocol();
        }
    }

    function vaultsOf(address user) external view returns (address[] memory) {
        return _vaultsOf[user];
    }
}

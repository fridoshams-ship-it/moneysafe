// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal subset of the Aave V3 Pool interface used by MoneySafe.
interface IPool {
    struct ReserveConfigurationMap {
        uint256 data;
    }

    /// @dev Layout of Aave V3 `getReserveData` (ReserveDataLegacy in v3.1+).
    struct ReserveData {
        ReserveConfigurationMap configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    function getReserveData(address asset) external view returns (ReserveData memory);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal subset of the Compound III (Comet) interface used by MoneySafe.
/// @dev Each Comet market has one base asset (e.g. USDC). Supplying the base asset earns interest;
///      `balanceOf` returns the supplied base amount including accrued interest.
interface IComet {
    function baseToken() external view returns (address);

    function supply(address asset, uint256 amount) external;

    /// @dev `amount == type(uint256).max` withdraws the full base balance.
    function withdraw(address asset, uint256 amount) external;

    function balanceOf(address account) external view returns (uint256);
}

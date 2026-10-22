# MoneySafe — audit scope and brief

This document is for security auditors. It describes what MoneySafe is, the exact contracts in scope, the trust model, the invariants we rely on, how the code is tested, and the findings from our own static analysis. An internal pre-audit in Russian is in [AUDIT-PRELIM.md](AUDIT-PRELIM.md).

## 1. Product in one paragraph

MoneySafe is a "safe from yourself". A user locks a stablecoin or ETH until a chosen date; there is **no early withdrawal, no penalty path and no admin override**. While locked, funds earn interest in Aave V3 or Compound III. A second product, **"money for every day"** (an *allowance*), releases a deposit in equal parts — one part per day or per week — so a user cannot spend a month's budget in one day. Each safe and each allowance is a separate EIP-1167 clone owned by the user.

Target networks: Arbitrum One and Base (Polygon is configured but not verified). Beta deployment uses per-vault deposit caps until the audit is complete.

## 2. Scope

| File | nSLOC | Purpose |
|---|---:|---|
| `contracts/MoneySafeFactory.sol` | ~200 | Creates vault and allowance clones, holds the allow-list of assets/markets, deposit pause, beta caps |
| `contracts/MoneySafeVault.sol` | ~105 | Time-locked vault: supply to the market, withdraw only by the owner on or after `unlockTime` |
| `contracts/MoneySafeAllowance.sol` | ~160 | Allowance: releases `rate` per `period`, carry-over of unused parts, 30-day cooldown on raising the rate |
| `contracts/interfaces/IPool.sol` | ~25 | Subset of the Aave V3 Pool interface |
| `contracts/interfaces/IComet.sol` | ~7 | Subset of the Compound III (Comet) interface |

Total ≈ 500 nSLOC. Solidity 0.8.24, optimizer 200 runs, EVM `cancun`. Dependencies: OpenZeppelin Contracts 5.1 (`Clones`, `SafeERC20`, `Ownable2Step`, `ReentrancyGuard`).

**Out of scope:** `contracts/test/*` (mocks), `contracts/testnet/*` (testnet faucet token and a toy lending pool), scripts, the web/mobile app and the backend indexer.

Commit to audit: the commit that contains this file on `main` of `github.com/fridoshams-ship-it/moneysafe` (the exact hash will be frozen when the audit is booked).

## 3. Architecture

```
user ──createVaultWith / createAllowance / topUp / topUpAllowance──▶ MoneySafeFactory (Ownable2Step)
                                                                          │ Clones.clone(implementation)
                                                                          ▼
                               MoneySafeVault (one per safe)      MoneySafeAllowance (one per budget)
                                   │ supply / withdraw                  │ supply / withdraw
                                   ▼                                    ▼
                         Aave V3 Pool  or  Compound III Comet (fixed per clone at creation)
```

* The factory transfers the user's tokens **directly to the clone** and calls `supplyIdle()`; the clone supplies its whole idle balance to its market.
* The market of a clone (Aave pool or a Comet) is set once in `initialize` and can never change.
* Aave aTokens are read from `pool.getReserveData(asset)`; they cannot be set by hand.
* Comet markets are fixed in the factory constructor (base token read from each Comet). The owner can only switch an asset on/off; it cannot add a new market address.

## 4. Roles and privileges

| Role | Can | Cannot |
|---|---|---|
| Factory owner (to be a Safe multisig; two-step transfer) | `allowAsset`, `allowComet`, `disallowAsset` (new deposits only), `setDepositsPaused` (new deposits only), `setVaultCap` (new deposits and top-ups only) | Touch, move, unlock, extend or pause any existing vault/allowance; add a new Comet; withdraw anyone's funds; upgrade anything (no proxies, no `delegatecall`) |
| Vault owner | `withdraw()`, `withdrawPartial(amount)` on or after `unlockTime` | Withdraw earlier; change the date |
| Allowance owner | `withdraw(amount ≤ available())`, `setRate(newRate)` (lower: any time; raise: ≥ 30 days after the last change) | Take more than released; raise the rate early |
| Anyone | Top up any vault (before unlock) or allowance; this only adds to the owner's balance | Anything else |

## 5. Invariants we rely on (please try to break these)

Vault
1. Only `owner` can move funds out, and only when `block.timestamp >= unlockTime`.
2. `unlockTime`, `owner`, `asset`, `market`, `protocol` are immutable after `initialize`; clones and the implementation cannot be re-initialized.
3. `withdrawn` becomes true only when both the market balance and the idle balance are zero; a paused or illiquid market makes `withdraw()` revert atomically and `withdrawPartial` pays what is available.
4. Top-ups after `unlockTime` are rejected; they never change the date.

Allowance
5. `released() = min(deposited, accruedAtCheckpoint + rate × (periodsAt(now) − checkpointPeriods))`, and `available() = released − withdrawnTotal` (all remaining balance incl. yield once everything is released). The owner can never withdraw more than `available()`.
6. A rate change applies from the next period: the portion of the current period is never recalculated (checkpoint at `periodsAt(now)`).
7. Raising the rate requires `now ≥ lastRateChange + 30 days`; lowering resets that clock.
8. A top-up joins the schedule from the next period (checkpoint before increasing `deposited`): parts that "accrued" beyond the old deposit cannot be paid out of new money.
9. Yield is released only together with the last part.

Factory
10. A clone is registered (`isVault` / `isAllowance`) before any funds move; top-ups are accepted only for registered clones.
11. Pause and caps never affect withdrawals.

## 6. External integrations and assumptions

* Aave V3 Pool `supply`, `withdraw(asset, type(uint256).max | amount, to)`, `getReserveData`. Compound III `supply`, `withdraw`, `balanceOf`, `baseToken`.
* Assets: USDC, USDT (Arbitrum), WETH, WBTC (Arbitrum) / cbBTC (Base). No fee-on-transfer or rebasing tokens are allowed; `forceApprove` handles USDT-style approvals.
* Native ETH is wrapped to WETH by the app before deposit and unwrapped after withdrawal; the contracts never hold native ETH.
* Mainnet addresses are in `config/networks.json`, checked on 2026-10-21 against `bgd-labs/aave-address-book` and `compound-finance/comet/deployments`.

## 7. Testing

* Unit tests: `npx hardhat test` — 37 tests (vault, factory, allowance, Compound path, caps, pause, re-initialization, liquidity shortage, USDT-style approve, 18-decimals asset).
* Fork tests: `test-fork/mainnet.fork.test.js` against forks of **Arbitrum One and Base** with the real Aave V3 and Compound III (USDC, USDT, WETH; full lock → refuse early → withdraw with real interest; allowance on real Aave). Runs in CI on every push (`.github/workflows/contracts.yml`), plus a dry run of the mainnet deploy script on each fork.
* Coverage (`npx hardhat coverage`, solidity-coverage 0.8.16):

| File | Stmts | Branch | Funcs | Lines |
|---|---:|---:|---:|---:|
| MoneySafeAllowance.sol | 100 | 78.2 | 100 | 100 |
| MoneySafeFactory.sol | 100 | 87.8 | 100 | 100 |
| MoneySafeVault.sol | 100 | 69.6 | 100 | 100 |

## 8. Our static analysis (Slither, all detectors) and triage

| Detector | Where | Our assessment |
|---|---|---|
| incorrect-equality | `idle == 0`, `fully = … == 0` | Intended exact checks on balances; no attacker-controlled rounding path known. |
| reentrancy-no-eth | Vault `_withdraw`, Allowance `withdraw`: state written after `market.withdraw` | Both functions are `nonReentrant`; the market is fixed at creation (trusted Aave/Comet). `setRate` is not `nonReentrant` but requires `msg.sender == owner`. Please confirm. |
| reentrancy-benign / reentrancy-events | Factory `_create`: writes and events after `initialize`/`supplyIdle` | Calls go to the freshly cloned, trusted implementation. |
| unused-return | `IPool.withdraw` return value | We measure the resulting balance instead. |
| calls-loop | Factory constructor reads `baseToken()` of each Comet | Constructor only; list fixed at deployment. |
| timestamp | Schedule and unlock comparisons | Intended; second-level miner influence is irrelevant at day granularity. |

## 9. Known limitations / accepted risks

* Protocol risk of Aave/Compound (bugs, pauses, frozen reserves, bad debt) and stablecoin de-peg are passed to the user and disclosed in the app.
* If a market lacks liquidity on the unlock day, the full withdrawal reverts; the user can withdraw in parts (`withdrawPartial` / allowance `withdraw(amount)`).
* The owner can stop **new** deposits per asset; this is a safety valve, not a custody right.
* No upgradeability by design. A bug fix means a new factory; existing clones keep working with their markets.

## 10. Questions we would like the audit to answer

1. Can any party move funds before the date (vault) or faster than the schedule (allowance), including via rounding, top-ups, rate changes around period boundaries, or re-initialization?
2. Is there any path for the factory owner to affect existing funds?
3. Are Aave/Compound edge cases (paused market, `withdraw(max)`, partial liquidity, index rounding) handled without locking funds forever?
4. Are the checkpoint maths in `MoneySafeAllowance` correct for all orders of `withdraw`, `setRate` and `supplyIdle` within and across periods?
5. Deployment review: `scripts/deploy.js` and `config/networks.json` for Arbitrum One and Base.

## 11. How to run

```bash
cd contracts
npm ci
npx hardhat test                                   # unit tests
FORK_NET=arbitrum FORK_URL=https://arb1.arbitrum.io/rpc npx hardhat test test-fork/mainnet.fork.test.js
FORK_NET=base FORK_URL=https://mainnet.base.org npx hardhat test test-fork/mainnet.fork.test.js
npx hardhat coverage
slither . --hardhat-ignore-compile --filter-paths "node_modules|contracts/test|contracts/testnet"
```

# Request for an audit quote (template)

Send to several audit firms at once. Replace the bracketed parts.

---

**Subject:** Audit quote request — MoneySafe (time-locked vaults on Aave V3 / Compound III), ~500 nSLOC

Hello,

We are preparing MoneySafe for a mainnet launch on Arbitrum One and Base and would like a quote for a smart-contract security audit.

* What it is: time-locked savings vaults with no early withdrawal and no admin access to funds, plus daily/weekly allowance contracts. Funds are supplied to Aave V3 or Compound III while locked.
* Scope: 3 contracts + 2 interfaces, about 500 nSLOC, Solidity 0.8.24, OpenZeppelin 5.1, no proxies.
* Repository: https://github.com/fridoshams-ship-it/moneysafe (folder `contracts/`); the brief is in `contracts/AUDIT-SCOPE.md`.
* Already done: 37 unit tests, fork tests on Arbitrum and Base with the real protocols, 100% line coverage of the in-scope files, Slither triage (see the brief).
* Preferred timing: [dates]. Deliverables: report with findings and a fix review.

Could you share price, earliest start date, duration and the team size?

Thank you,
[Name], MoneySafe
[email / Telegram]

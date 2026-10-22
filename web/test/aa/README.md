# Local test of sponsored gas (ERC-4337)

Stands in for Pimlico: EntryPoint v0.7, SimpleAccountFactory and a VerifyingPaymaster on a local Hardhat node,
plus a tiny bundler + ERC-7677 paymaster service on :4337.

```bash
cd contracts && npx hardhat node &                                   # local chain
npx hardhat run scripts/deploy-testnet.js --network localhost         # MoneySafe testnet stack
cd ../web && node test/aa/deploy-aa.cjs && node test/aa/bundler.mjs & # AA contracts + bundler/paymaster
MS_NETWORKS=localhost npm run build
node test/aa/e2e-gasless.cjs dist                                     # a wallet with 0 ETH: faucet, vault, budget, early withdrawal refused
```

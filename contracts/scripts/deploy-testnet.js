// TESTNET BETA: deploys test tokens with a faucet, an Aave-compatible test market with per-second yield,
// and the MoneySafe factory wired to it. Works on arbitrumSepolia, polygonAmoy, localhost or hardhat.
// Usage: DEPLOYER_KEY=0x... ARB_SEPOLIA_RPC=https://... npx hardhat run scripts/deploy-testnet.js --network arbitrumSepolia
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const TOKENS = [
  // symbol, name, decimals, faucet amount, APR in bps
  ["USDC", "Test USD Coin", 6, "10000", 420],
  ["USDT", "Test Tether", 6, "10000", 390],
  ["ETH", "Test Wrapped Ether", 18, "3", 210],
  ["WBTC", "Test Wrapped Bitcoin", 8, "0.1", 40],
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Network:", network.name, "deployer:", deployer.address);
  const pool = await ethers.deployContract("TestnetLendingPool");
  await pool.waitForDeployment();
  const factory = await ethers.deployContract("MoneySafeFactory", [await pool.getAddress(), [], deployer.address]);
  await factory.waitForDeployment();
  const out = { network: network.name, chainId: Number((await ethers.provider.getNetwork()).chainId), testnet: true,
    factory: await factory.getAddress(), pool: await pool.getAddress(), block: await ethers.provider.getBlockNumber(), tokens: {} };
  for (const [sym, name, dec, faucet, apr] of TOKENS) {
    const t = await ethers.deployContract("TestToken", [name, "t" + sym, dec, ethers.parseUnits(faucet, dec)]);
    await t.waitForDeployment();
    const a = await t.getAddress();
    await (await pool.addReserve(a, apr)).wait();
    await (await t.setMinter(await pool.getAddress())).wait();
    await (await factory.allowAsset(a)).wait();
    out.tokens[sym] = { address: a, decimals: dec, faucet, aprBps: apr };
    console.log(sym, a, "APR", apr / 100 + "%");
  }
  const file = path.join(__dirname, "..", "deployments", network.name + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("Factory:", out.factory, "\nSaved", file);
}

main().catch((e) => { console.error(e); process.exit(1); });

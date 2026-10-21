require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
const path = require("path");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Use the bundled solc-js (no compiler download needed).
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === "0.8.24") {
    const compilerPath = path.join(__dirname, "node_modules", "solc", "soljson.js");
    return { compilerPath, isSolcJs: true, version: args.solcVersion, longVersion: "0.8.24+commit.e11b9ed9" };
  }
  return runSuper();
});

// Networks read RPC URLs and the deployer key from environment variables (never commit keys).
const key = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [];
const net = (envName, chainId) => (process.env[envName] ? { url: process.env[envName], chainId, accounts: key } : undefined);
const networks = Object.fromEntries(Object.entries({
  polygon: net("POLYGON_RPC", 137),
  arbitrum: net("ARBITRUM_RPC", 42161),
  polygonAmoy: net("AMOY_RPC", 80002),
  arbitrumSepolia: net("ARB_SEPOLIA_RPC", 421614),
}).filter(([, v]) => v));
if (process.env.FORK_URL) networks.hardhat = { forking: { url: process.env.FORK_URL } };

module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" } },
  networks,
};

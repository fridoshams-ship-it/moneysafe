// Deploy MoneySafeFactory on a real network and switch on its assets.
// Usage:  DEPLOYER_KEY=0x... ARBITRUM_RPC=https://... npx hardhat run scripts/deploy.js --network arbitrum
// Addresses come from config/networks.json (verified against the official Aave and Compound address books).
// OWNER defaults to the deployer so assets and beta caps are set right away; move ownership to a multisig later
// (transferOwnership + acceptOwnership — two steps).
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "networks.json"), "utf8"))[process.env.MS_CONFIG || network.name];
  if (!cfg) throw new Error("No config for network " + network.name);
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (cfg.chainId && chainId !== cfg.chainId && network.name !== "hardhat") throw new Error(`RPC is chain ${chainId}, config expects ${cfg.chainId}`);
  console.log("Network:", network.name, "chain", chainId, "deployer:", deployer.address, "ETH:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));
  const pool = cfg.aavePool || ethers.ZeroAddress;

  const factory = await ethers.deployContract("MoneySafeFactory", [pool, cfg.comets, deployer.address]);
  await factory.waitForDeployment();
  const out = { network: network.name, chainId: cfg.chainId || chainId, testnet: false, factory: await factory.getAddress(),
    pool: pool === ethers.ZeroAddress ? "" : pool, implementation: await factory.vaultImplementation(), owner: deployer.address, block: await ethers.provider.getBlockNumber(), tokens: {} };
  console.log("MoneySafeFactory:", out.factory);

  for (const [sym0, a] of Object.entries(cfg.assets)) {
    const sym = sym0 === "WETH" ? "ETH" : sym0 === "cbBTC" ? "WBTC" : sym0 // the app shows WETH as ETH (wrapping native ETH for the user) and cbBTC in the BTC slot
    const t = new ethers.Contract(a, ["function decimals() view returns (uint8)"], deployer)
    const decimals = Number(await t.decimals())
    const tok = { address: a, decimals, wrapped: sym0 === "WETH", label: sym0, protocols: [] }
    if (pool !== ethers.ZeroAddress) {
      try { await (await factory.allowAsset(a)).wait(); tok.aToken = await factory.aTokenOf(a); tok.protocols.push(0); console.log("Aave", sym, "->", tok.aToken) }
      catch (e) { console.log("Aave", sym, "not listed — skipped") }
    }
    if ((await factory.cometMarketOf(a)) !== ethers.ZeroAddress) {
      await (await factory.allowComet(a)).wait(); tok.comet = await factory.cometMarketOf(a); tok.protocols.push(1); console.log("Compound", sym, "->", tok.comet)
    }
    const cap = (cfg.betaCap || {})[sym0]
    if (cap) { await (await factory.setVaultCap(a, ethers.parseUnits(cap, decimals))).wait(); tok.cap = cap; console.log("Beta cap", sym, cap) }
    if (tok.protocols.length) out.tokens[sym] = tok
  }
  if (process.env.OWNER && process.env.OWNER.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await factory.transferOwnership(process.env.OWNER)).wait()
    console.log("Ownership offered to", process.env.OWNER, "— it must call acceptOwnership()")
  }

  const file = path.join(__dirname, "..", "deployments", (process.env.MS_OUT || network.name) + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("Saved", file);
}

main().catch((e) => { console.error(e); process.exit(1); });

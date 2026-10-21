// Deploy MoneySafeFactory on one chain and switch on its assets.
// Usage:  DEPLOYER_KEY=0x... ARBITRUM_RPC=https://... OWNER=0xSafeMultisig npx hardhat run scripts/deploy.js --network arbitrum
// Addresses come from config/networks.json (check them against the official Aave and Compound address books first).
// OWNER should be a multisig (e.g. Safe). If OWNER is the deployer, assets are switched on right away.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "networks.json"), "utf8"))[network.name];
  if (!cfg) throw new Error("No config for network " + network.name);
  const [deployer] = await ethers.getSigners();
  const owner = process.env.OWNER || deployer.address;
  const pool = cfg.aavePool || ethers.ZeroAddress;

  const factory = await ethers.deployContract("MoneySafeFactory", [pool, cfg.comets, owner]);
  await factory.waitForDeployment();
  const out = { network: network.name, chainId: cfg.chainId, factory: await factory.getAddress(), implementation: await factory.vaultImplementation(), owner, block: await ethers.provider.getBlockNumber(), aave: {}, comet: {} };
  console.log("MoneySafeFactory:", out.factory);

  if (owner.toLowerCase() === deployer.address.toLowerCase()) {
    for (const [sym, a] of Object.entries(cfg.assets)) {
      if (pool !== ethers.ZeroAddress) {
        try { await (await factory.allowAsset(a)).wait(); out.aave[sym] = await factory.aTokenOf(a); console.log("Aave", sym, "->", out.aave[sym]); }
        catch (e) { console.log("Aave", sym, "not listed — skipped"); }
      }
      if ((await factory.cometMarketOf(a)) !== ethers.ZeroAddress) {
        await (await factory.allowComet(a)).wait(); out.comet[sym] = await factory.cometMarketOf(a); console.log("Compound", sym, "->", out.comet[sym]);
      }
    }
  } else console.log("Owner is a multisig: switch assets on with allowAsset / allowComet from it.");

  const file = path.join(__dirname, "..", "deployments", network.name + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("Saved", file);
}

main().catch((e) => { console.error(e); process.exit(1); });

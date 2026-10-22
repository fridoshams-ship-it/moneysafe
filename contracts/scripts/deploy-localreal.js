// Local only: a "real-network-like" deployment (testnet:false, WETH-backed ETH, beta caps) to test the real-money UI.
const { ethers, network } = require("hardhat");
const fs = require("fs"), path = require("path");
async function main() {
  const [d] = await ethers.getSigners();
  const pool = await ethers.deployContract("TestnetLendingPool"); await pool.waitForDeployment();
  const usdc = await ethers.deployContract("TestToken", ["USD Coin", "USDC", 6, ethers.parseUnits("2000", 6)]);
  const weth = await ethers.deployContract("MockWETH");
  await (await weth.deposit({ value: ethers.parseEther("5") })).wait(); // backing for minted test yield
  // Compound-like market for USDC paying more (7%) than the Aave-like pool (5%): the app must pick it
  const comet = await ethers.deployContract("LocalComet", [await usdc.getAddress(), 700]);
  const f = await ethers.deployContract("MoneySafeFactory", [await pool.getAddress(), [await comet.getAddress()], d.address]); await f.waitForDeployment();
  const NAME = process.env.MS_OUT || "localreal";
  const out = { network: NAME, chainId: 31337, testnet: false, factory: await f.getAddress(), pool: await pool.getAddress(), block: await ethers.provider.getBlockNumber(), tokens: {} };
  for (const [sym, t, dec, apr, cap, wrapped] of [["USDC", usdc, 6, 500, "500", false], ["ETH", weth, 18, 250, "0.2", true]]) {
    const a = await t.getAddress();
    await (await pool.addReserve(a, apr)).wait(); await (await t.setMinter(await pool.getAddress())).wait();
    await (await f.allowAsset(a)).wait(); await (await f.setVaultCap(a, ethers.parseUnits(cap, dec))).wait();
    out.tokens[sym] = { address: a, decimals: dec, wrapped, protocols: [0], cap };
  }
  // interest reserve for the comet-like market
  await (await usdc.faucet()).wait(); await (await usdc.transfer(await comet.getAddress(), ethers.parseUnits("2000", 6))).wait();
  await (await f.allowComet(await usdc.getAddress())).wait();
  out.tokens.USDC.protocols.push(1); out.tokens.USDC.comet = await comet.getAddress();
  const file = path.join(__dirname, "..", "deployments", NAME + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(out, null, 2)); console.log(JSON.stringify(out));
}
main().catch((e) => { console.error(e); process.exit(1); });

// Runs against a fork of the real Arbitrum One network with the real Aave V3 and Compound III.
// FORK_URL=https://arb1.arbitrum.io/rpc npx hardhat test test-fork/arbitrum.fork.test.js
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const cfg = require("../config/networks.json").arbitrum;

const DAY = 86400n;
const A = cfg.assets;
// Official aTokens from bgd-labs/aave-address-book (AaveV3Arbitrum.sol)
const ATOKENS = { USDC: "0x724dc807b04555b71ed48a6896b6F41593b8C637", USDT: "0x6ab707Aca953eDAeFBc4fD23bA73294241490620", WETH: "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8", WBTC: "0x078f358208685046a11C85e8ad32895DED33A249" };
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"];

(process.env.FORK_URL ? describe : describe.skip)("Arbitrum One fork: real Aave V3 + Compound III", function () {
  this.timeout(300000);
  let f, user, admin;

  before(async function () {
    [admin, user] = await ethers.getSigners();
    f = await ethers.deployContract("MoneySafeFactory", [cfg.aavePool, cfg.comets, admin.address]);
    for (const [s, a] of Object.entries(A)) {
      await (await f.allowAsset(a)).wait();
      expect((await f.aTokenOf(a)).toLowerCase()).to.equal(ATOKENS[s].toLowerCase());
    }
    for (const s of ["USDC", "USDT", "WETH"]) {
      expect(await f.cometMarketOf(A[s])).to.not.equal(ethers.ZeroAddress);
      await (await f.allowComet(A[s])).wait();
    }
    // get real USDC / USDT: impersonate the Aave aToken contracts which hold the underlying
    for (const s of ["USDC", "USDT"]) {
      await network.provider.request({ method: "hardhat_impersonateAccount", params: [ATOKENS[s]] });
      await network.provider.send("hardhat_setBalance", [ATOKENS[s], "0x56BC75E2D63100000"]);
      const holder = await ethers.getSigner(ATOKENS[s]);
      await (await new ethers.Contract(A[s], ERC20, holder).transfer(user.address, ethers.parseUnits("5000", 6))).wait();
    }
    // WETH: wrap native ETH
    await (await user.sendTransaction({ to: A.WETH, value: ethers.parseEther("2") })).wait();
  });

  async function open(protocol, sym, amount, days) {
    const token = new ethers.Contract(A[sym], ERC20, user);
    await (await token.approve(await f.getAddress(), amount)).wait();
    const unlock = BigInt(await time.latest()) + days * DAY;
    const rc = await (await f.connect(user).createVaultWith(protocol, user.address, A[sym], amount, unlock, sym)).wait();
    const ev = rc.logs.map((l) => { try { return f.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "VaultCreated");
    return { vault: await ethers.getContractAt("MoneySafeVault", ev.args.vault), unlock, token };
  }

  for (const [protocol, label] of [[0, "Aave"], [1, "Compound"]]) {
    for (const [sym, amt] of [["USDC", ethers.parseUnits("1000", 6)], ["USDT", ethers.parseUnits("1000", 6)], ["WETH", ethers.parseEther("0.5")]]) {
      it(`${label} ${sym}: locks, refuses early withdrawal, pays principal + real interest after the date`, async function () {
        const { vault, unlock, token } = await open(protocol, sym, amt, 30n);
        expect(await vault.balance()).to.be.closeTo(amt, amt / 10000n + 2n);
        await expect(vault.connect(user).withdraw()).to.be.revertedWithCustomError(vault, "StillLocked");
        await time.increaseTo(unlock);
        expect(await vault.earned()).to.be.gt(0n);
        const before = await token.balanceOf(user.address);
        await (await vault.connect(user).withdraw()).wait();
        const got = (await token.balanceOf(user.address)) - before;
        expect(got).to.be.gt(amt);
        console.log(`::notice title=Fork ${label} ${sym}::${label} ${sym}: in ${ethers.formatUnits(amt, sym === "WETH" ? 18 : 6)} → out ${ethers.formatUnits(got, sym === "WETH" ? 18 : 6)} after 30 days`);
      });
    }
  }

  after(function () { if (process.env.GITHUB_ACTIONS) console.log("::notice title=Fork::fork tests ran against block " + this.currentTest?.parent?.title) })

  it("Aave USDC daily budget: 100 at 10/day, real interest after the last day", async function () {
    const token = new ethers.Contract(A.USDC, ERC20, user);
    await (await token.approve(await f.getAddress(), ethers.parseUnits("100", 6))).wait();
    const rc = await (await f.connect(user).createAllowance(0, A.USDC, ethers.parseUnits("100", 6), ethers.parseUnits("10", 6), DAY, 0, "Daily")).wait();
    const ev = rc.logs.map((l) => { try { return f.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "AllowanceCreated");
    const a = await ethers.getContractAt("MoneySafeAllowance", ev.args.allowance);
    expect(await a.available()).to.equal(ethers.parseUnits("10", 6));
    await expect(a.connect(user).withdraw(ethers.parseUnits("11", 6))).to.be.revertedWithCustomError(a, "MoreThanAvailable");
    await (await a.connect(user).withdraw(ethers.parseUnits("10", 6))).wait();
    await time.increase(30n * DAY);
    const before = await token.balanceOf(user.address);
    await (await a.connect(user).withdraw(ethers.MaxUint256)).wait();
    const got = (await token.balanceOf(user.address)) - before;
    expect(got).to.be.gt(ethers.parseUnits("90", 6));
    console.log(`::notice title=Fork daily budget::Aave USDC budget: 10 on day 1, then ${ethers.formatUnits(got, 6)} after 30 days`);
  });

  it("Aave WBTC can be switched on (listed reserve)", async function () {
    expect(await f.aTokenOf(A.WBTC)).to.not.equal(ethers.ZeroAddress);
  });
});

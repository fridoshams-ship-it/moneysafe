const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const DAY = 86400n;

describe("Testnet beta market", function () {
  it("faucet gives tokens once a day; a vault earns per-second yield and pays it out on the date", async function () {
    const [admin, alice] = await ethers.getSigners();
    const pool = await ethers.deployContract("TestnetLendingPool");
    const factory = await ethers.deployContract("MoneySafeFactory", [await pool.getAddress(), [], admin.address]);
    const t = await ethers.deployContract("TestToken", ["Test USD Coin", "tUSDC", 6, ethers.parseUnits("10000", 6)]);
    await pool.addReserve(await t.getAddress(), 500); // 5% APR
    await t.setMinter(await pool.getAddress());
    await factory.allowAsset(await t.getAddress());

    await t.connect(alice).faucet();
    expect(await t.balanceOf(alice.address)).to.equal(ethers.parseUnits("10000", 6));
    await expect(t.connect(alice).faucet()).to.be.revertedWithCustomError(t, "FaucetCooldown");
    await expect(t.connect(alice).mint(alice.address, 1n)).to.be.revertedWithCustomError(t, "OnlyMinter");

    const rd = await pool.getReserveData(await t.getAddress());
    expect(rd.currentLiquidityRate).to.equal(5n * 10n ** 25n);

    await t.connect(alice).approve(await factory.getAddress(), ethers.MaxUint256);
    const unlock = BigInt(await time.latest()) + 365n * DAY;
    const rc = await (await factory.connect(alice).createVault(await t.getAddress(), ethers.parseUnits("1000", 6), unlock, "Тест")).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "VaultCreated");
    const vault = await ethers.getContractAt("MoneySafeVault", ev.args.vault);

    await time.increase(Number(182n * DAY));
    const mid = await vault.earned();
    expect(mid).to.be.closeTo(ethers.parseUnits("24.9", 6), ethers.parseUnits("0.2", 6));

    await time.increaseTo(unlock);
    await vault.connect(alice).withdraw();
    const got = await t.balanceOf(alice.address);
    expect(got).to.be.closeTo(ethers.parseUnits("10050", 6), ethers.parseUnits("0.1", 6)); // 9000 left + 1000 back + 50 yield (5%)
    expect(await vault.withdrawn()).to.equal(true);
  });

  it("deploy-testnet script wires 4 assets", async function () {
    const { execSync } = require("child_process");
    const outp = execSync("npx hardhat run scripts/deploy-testnet.js", { cwd: __dirname + "/..", encoding: "utf8" });
    expect(outp).to.match(/USDC 0x[0-9a-fA-F]{40}/);
    expect(outp).to.match(/WBTC 0x[0-9a-fA-F]{40}/);
  });
});

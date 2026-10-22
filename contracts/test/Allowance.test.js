const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 86400n;
const RAY = 10n ** 27n;
const usdc = (n) => ethers.parseUnits(String(n), 6);

describe("Money for every day (MoneySafeAllowance)", function () {
  async function deploy() {
    const [admin, alice, bob] = await ethers.getSigners();
    const USDC = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const pool = await ethers.deployContract("MockPool", [await USDC.getAddress()]);
    const factory = await ethers.deployContract("MoneySafeFactory", [await pool.getAddress(), [], admin.address]);
    await factory.allowAsset(await USDC.getAddress());
    for (const u of [alice, bob]) {
      await USDC.mint(u.address, usdc(100000));
      await USDC.connect(u).approve(await factory.getAddress(), ethers.MaxUint256);
    }
    await USDC.mint(await pool.getAddress(), usdc(1000000));
    return { admin, alice, bob, USDC, pool, factory };
  }

  async function open(f, user, total, rate, period = DAY, start = 0n) {
    const rc = await (await f.factory.connect(user).createAllowance(0, await f.USDC.getAddress(), usdc(total), usdc(rate), period, start, "Бюджет")).wait();
    const ev = rc.logs.map((l) => { try { return f.factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "AllowanceCreated");
    const a = await ethers.getContractAt("MoneySafeAllowance", ev.args.allowance);
    return { a, start: await a.start() };
  }

  it("$200 at $20/day: day 1 opens $20, nothing can be taken ahead", async function () {
    const f = await loadFixture(deploy);
    const { a } = await open(f, f.alice, 200, 20);
    expect(await a.available()).to.equal(usdc(20));
    await expect(a.connect(f.alice).withdraw(usdc(21))).to.be.revertedWithCustomError(a, "MoreThanAvailable").withArgs(usdc(20));
    const before = await f.USDC.balanceOf(f.alice.address);
    await a.connect(f.alice).withdraw(usdc(20));
    expect((await f.USDC.balanceOf(f.alice.address)) - before).to.equal(usdc(20));
    expect(await a.available()).to.equal(0n);
    await expect(a.connect(f.alice).withdraw(1n)).to.be.revertedWithCustomError(a, "MoreThanAvailable");
  });

  it("unused days accumulate; the next portion opens exactly at the period boundary", async function () {
    const f = await loadFixture(deploy);
    const { a, start } = await open(f, f.alice, 200, 20);
    await time.increaseTo(start + DAY - 2n);
    expect(await a.available()).to.equal(usdc(20));
    expect(await a.nextReleaseAt()).to.equal(start + DAY);
    await time.increaseTo(start + 3n * DAY);
    expect(await a.available()).to.equal(usdc(80)); // days 1–4
    await a.connect(f.alice).withdraw(ethers.MaxUint256);
    expect(await a.available()).to.equal(0n);
  });

  it("after the last portion everything, including Aave yield, is available", async function () {
    const f = await loadFixture(deploy);
    const { a, start } = await open(f, f.alice, 200, 20);
    await f.pool.setIndex((RAY * 101n) / 100n); // +1%
    await time.increaseTo(start + 8n * DAY);
    expect(await a.available()).to.equal(usdc(180)); // 9 days, yield not yet
    expect(await a.endsAt()).to.equal(start + 9n * DAY);
    await time.increaseTo(start + 9n * DAY);
    expect(await a.available()).to.equal(usdc(202));
    await expect(a.connect(f.alice).withdraw(ethers.MaxUint256)).to.emit(a, "Withdrawn").withArgs(f.alice.address, usdc(202), true);
    expect(await a.closed()).to.equal(true);
  });

  it("only the owner can withdraw or change the rate", async function () {
    const f = await loadFixture(deploy);
    const { a } = await open(f, f.alice, 200, 20);
    await expect(a.connect(f.bob).withdraw(usdc(1))).to.be.revertedWithCustomError(a, "NotOwner");
    await expect(a.connect(f.admin).withdraw(usdc(1))).to.be.revertedWithCustomError(a, "NotOwner");
    await expect(a.connect(f.bob).setRate(usdc(10))).to.be.revertedWithCustomError(a, "NotOwner");
  });

  it("raising the daily amount is blocked for 30 days; lowering works any time and restarts the 30 days", async function () {
    const f = await loadFixture(deploy);
    const { a, start } = await open(f, f.alice, 1000, 20);
    await expect(a.connect(f.alice).setRate(usdc(30))).to.be.revertedWithCustomError(a, "RaiseTooSoon");
    await time.increaseTo(start + 29n * DAY);
    await expect(a.connect(f.alice).setRate(usdc(50))).to.be.revertedWithCustomError(a, "RaiseTooSoon");
    await a.connect(f.alice).setRate(usdc(10)); // lower: allowed
    await time.increaseTo(start + 31n * DAY);
    await expect(a.connect(f.alice).setRate(usdc(30))).to.be.revertedWithCustomError(a, "RaiseTooSoon"); // 30 days restart after lowering
    await time.increaseTo(start + 29n * DAY + 30n * DAY + 60n);
    await a.connect(f.alice).setRate(usdc(30));
    expect(await a.rate()).to.equal(usdc(30));
  });

  it("a change applies only from the next day — today's portion is never recalculated", async function () {
    const f = await loadFixture(deploy);
    const { a, start } = await open(f, f.alice, 1000, 20);
    await time.increaseTo(start + 30n * DAY + 100n); // day 31
    expect(await a.available()).to.equal(usdc(620));
    await a.connect(f.alice).setRate(usdc(50));
    expect(await a.available()).to.equal(usdc(620)); // same day: unchanged
    await time.increaseTo(start + 31n * DAY);
    expect(await a.available()).to.equal(usdc(670)); // day 32 at the new rate
    await a.connect(f.alice).setRate(usdc(5));
    expect(await a.available()).to.equal(usdc(670));
    await time.increaseTo(start + 32n * DAY);
    expect(await a.available()).to.equal(usdc(675));
  });

  it("a top-up joins the schedule from the next day: skipped days are not paid out of new money", async function () {
    const f = await loadFixture(deploy);
    const { a, start } = await open(f, f.alice, 100, 20);
    await time.increaseTo(start + 20n * DAY); // all 100 released long ago
    expect(await a.available()).to.equal(usdc(100));
    await a.connect(f.alice).withdraw(ethers.MaxUint256);
    // the budget is empty and closed; a new budget is a new contract
    await expect(f.factory.connect(f.alice).topUpAllowance(await a.getAddress(), usdc(100))).to.be.revertedWithCustomError(a, "Closed");
    const { a: b, start: s2 } = await open(f, f.alice, 100, 20);
    await time.increaseTo(s2 + 10n * DAY);
    await f.factory.connect(f.bob).topUpAllowance(await b.getAddress(), usdc(60));
    expect(await b.available()).to.equal(usdc(100)); // old 100 released, the 60 is not
    await time.increaseTo(s2 + 11n * DAY);
    expect(await b.available()).to.equal(usdc(120));
  });

  it("weekly budgets, a future start, and bad parameters", async function () {
    const f = await loadFixture(deploy);
    const asset = await f.USDC.getAddress();
    const now = BigInt(await time.latest());
    await expect(f.factory.connect(f.alice).createAllowance(0, asset, usdc(100), usdc(10), 3n * DAY, 0, "x")).to.be.revertedWithCustomError(f.factory, "BadPeriod");
    await expect(f.factory.connect(f.alice).createAllowance(0, asset, usdc(100), usdc(101), DAY, 0, "x")).to.be.revertedWithCustomError(f.factory, "RateAboveAmount");
    await expect(f.factory.connect(f.alice).createAllowance(0, asset, usdc(100), 0, DAY, 0, "x")).to.be.revertedWithCustomError(f.factory, "ZeroAmount");
    await expect(f.factory.connect(f.alice).createAllowance(0, asset, usdc(100), usdc(10), DAY, now - 10n, "x")).to.be.revertedWithCustomError(f.factory, "BadStart");
    const { a, start } = await open(f, f.alice, 400, 100, 7n * DAY, now + 3n * DAY);
    expect(await a.available()).to.equal(0n);
    await time.increaseTo(start);
    expect(await a.available()).to.equal(usdc(100));
    await time.increaseTo(start + 7n * DAY);
    expect(await a.available()).to.equal(usdc(200));
    expect(await f.factory.allowancesOf(f.alice.address)).to.deep.equal([await a.getAddress()]);
  });

  it("beta cap and pause apply to budgets too; the implementation cannot be initialized", async function () {
    const f = await loadFixture(deploy);
    const asset = await f.USDC.getAddress();
    await f.factory.setVaultCap(asset, usdc(500));
    await expect(f.factory.connect(f.alice).createAllowance(0, asset, usdc(501), usdc(10), DAY, 0, "x")).to.be.revertedWithCustomError(f.factory, "AboveVaultCap");
    const { a } = await open(f, f.alice, 450, 10);
    await expect(f.factory.connect(f.alice).topUpAllowance(await a.getAddress(), usdc(60))).to.be.revertedWithCustomError(f.factory, "AboveVaultCap");
    await f.factory.setDepositsPaused(true);
    await expect(f.factory.connect(f.alice).createAllowance(0, asset, usdc(100), usdc(10), DAY, 0, "x")).to.be.revertedWithCustomError(f.factory, "DepositsArePaused");
    await a.connect(f.alice).withdraw(usdc(10)); // withdrawals never paused
    const impl = await ethers.getContractAt("MoneySafeAllowance", await f.factory.allowanceImplementation());
    await expect(impl.initialize(f.alice.address, asset, 0, asset, asset, 1, DAY, 0)).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
    await expect(a.initialize(f.alice.address, asset, 0, asset, asset, 1, DAY, 0)).to.be.revertedWithCustomError(a, "AlreadyInitialized");
  });
  it("edge cases: same rate, zero amounts, closed budget, earned() and views after the end", async function () {
    const f = await loadFixture(deploy);
    const { a, start } = await open(f, f.alice, 100, 50);
    await expect(a.connect(f.alice).setRate(usdc(50))).to.be.revertedWithCustomError(a, "SameRate");
    await expect(a.connect(f.alice).setRate(0)).to.be.revertedWithCustomError(a, "ZeroAmount");
    await expect(a.connect(f.alice).withdraw(0)).to.be.revertedWithCustomError(a, "ZeroAmount");
    await expect(f.factory.connect(f.alice).topUpAllowance(f.alice.address, usdc(1))).to.be.revertedWithCustomError(f.factory, "UnknownVault");
    await expect(f.factory.connect(f.alice).topUpAllowance(await a.getAddress(), 0)).to.be.revertedWithCustomError(f.factory, "ZeroAmount");
    expect(await a.endsAt()).to.equal(start + DAY);
    await f.pool.setIndex((RAY * 102n) / 100n);
    expect(await a.earned()).to.equal(usdc(2));
    await time.increaseTo(start + DAY);
    expect(await a.nextReleaseAt()).to.equal(0n);
    expect(await a.endsAt()).to.equal(BigInt(await time.latest()));
    await a.connect(f.alice).withdraw(ethers.MaxUint256);
    expect(await a.available()).to.equal(0n);
    expect(await a.balance()).to.equal(0n);
    await expect(a.connect(f.alice).setRate(usdc(10))).to.be.revertedWithCustomError(a, "Closed");
    await expect(a.connect(f.alice).withdraw(1n)).to.be.revertedWithCustomError(a, "MoreThanAvailable");
  });

  it("works on Compound III too, and liquidity shortage only delays a part", async function () {
    const [admin, alice] = await ethers.getSigners();
    const USDC = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const comet = await ethers.deployContract("MockComet", [await USDC.getAddress()]);
    const pool = await ethers.deployContract("MockPool", [await USDC.getAddress()]);
    const factory = await ethers.deployContract("MoneySafeFactory", [await pool.getAddress(), [await comet.getAddress()], admin.address]);
    await expect(factory.connect(alice).createAllowance(1, await USDC.getAddress(), usdc(100), usdc(10), DAY, 0, "x")).to.be.revertedWithCustomError(factory, "AssetNotAllowed");
    await factory.allowComet(await USDC.getAddress());
    await USDC.mint(alice.address, usdc(1000)); await USDC.connect(alice).approve(await factory.getAddress(), ethers.MaxUint256);
    await USDC.mint(await comet.getAddress(), usdc(1000));
    const rc = await (await factory.connect(alice).createAllowance(1, await USDC.getAddress(), usdc(100), usdc(10), DAY, 0, "Comet")).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "AllowanceCreated");
    const a = await ethers.getContractAt("MoneySafeAllowance", ev.args.allowance);
    expect(await a.protocol()).to.equal(1);
    await comet.setPaused(true);
    await expect(a.connect(alice).withdraw(usdc(10))).to.be.reverted;
    expect(await a.available()).to.equal(usdc(10));
    await comet.setPaused(false);
    await comet.setIndex(ethers.parseUnits("1.05", 18));
    await time.increase(20n * DAY);
    expect(await a.available()).to.equal(usdc(105));
    await expect(a.connect(alice).withdraw(ethers.MaxUint256)).to.emit(a, "Withdrawn").withArgs(alice.address, usdc(105), true);
    await expect(factory.connect(alice).createAllowance(2, await USDC.getAddress(), usdc(100), usdc(10), DAY, 0, "x")).to.be.revertedWithCustomError(factory, "BadProtocol");
  });
});

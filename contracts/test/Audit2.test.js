// Second pre-audit (November 2026): one test per finding. Each test describes the SAFE behaviour.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 86400n;
const RAY = 10n ** 27n;
const usdc = (n) => ethers.parseUnits(String(n), 6);

describe("Second pre-audit: findings", function () {
  async function deploy() {
    const [admin, alice, bob, mallory] = await ethers.getSigners();
    const USDC = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const OTHER = await ethers.deployContract("MockERC20", ["Reward", "RWD", 18]);
    const pool = await ethers.deployContract("MockPool", [await USDC.getAddress()]);
    const factory = await ethers.deployContract("MoneySafeFactory", [await pool.getAddress(), [], admin.address]);
    await factory.allowAsset(await USDC.getAddress());
    for (const u of [alice, bob, mallory]) {
      await USDC.mint(u.address, usdc(100000));
      await USDC.connect(u).approve(await factory.getAddress(), ethers.MaxUint256);
    }
    await USDC.mint(await pool.getAddress(), usdc(1000000));
    return { admin, alice, bob, mallory, USDC, OTHER, pool, factory };
  }
  const ev = (f, rc, name) => rc.logs.map((l) => { try { return f.factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === name);
  async function budget(f, user, total, rate) {
    const rc = await (await f.factory.connect(user).createAllowance(0, await f.USDC.getAddress(), usdc(total), usdc(rate), DAY, 0n, "Бюджет")).wait();
    const a = await ethers.getContractAt("MoneySafeAllowance", ev(f, rc, "AllowanceCreated").args.allowance);
    return { a, start: await a.start() };
  }
  async function vault(f, payer, owner, amount, days = 30n) {
    const unlock = BigInt(await time.latest()) + days * DAY;
    const rc = await (await f.factory.connect(payer).createVaultWith(0, owner.address, await f.USDC.getAddress(), usdc(amount), unlock, "Цель")).wait();
    const v = await ethers.getContractAt("MoneySafeVault", ev(f, rc, "VaultCreated").args.vault);
    return { v, unlock };
  }

  describe("A-1. A huge daily amount must not freeze the budget forever", function () {
    it("the daily amount cannot be set above what was deposited", async function () {
      const f = await loadFixture(deploy);
      const { a } = await budget(f, f.alice, 200, 20);
      await time.increase(31n * DAY);
      await expect(a.connect(f.alice).setRate(ethers.MaxUint256)).to.be.revertedWithCustomError(a, "RateAboveDeposit");
      await expect(a.connect(f.alice).setRate(usdc(201))).to.be.revertedWithCustomError(a, "RateAboveDeposit");
      await a.connect(f.alice).setRate(usdc(200)); // "release everything from tomorrow" is the maximum
      await time.increase(5n * DAY);
      expect(await a.available()).to.equal(usdc(200));
      await a.connect(f.alice).withdraw(ethers.MaxUint256);
      expect(await f.USDC.balanceOf(await a.getAddress())).to.equal(0n);
    });
  });

  describe("A-2. Changing the amount must not make a later top-up available at once", function () {
    it("after a rate change, new money still joins the schedule from the next day", async function () {
      const f = await loadFixture(deploy);
      const { a } = await budget(f, f.alice, 40, 20);
      await a.connect(f.alice).withdraw(usdc(20));
      await time.increase(100n * DAY); // the old 40 is long released; 20 still waits to be taken
      await a.connect(f.alice).setRate(usdc(19));
      await f.factory.connect(f.alice).topUpAllowance(await a.getAddress(), usdc(1000));
      expect(await a.available()).to.equal(usdc(20)); // only the old remainder
      await time.increase(DAY);
      expect(await a.available()).to.equal(usdc(39)); // + one new portion
    });
  });

  describe("A-3. Nobody else can interfere with a budget", function () {
    it("only the owner tops up a budget (a stranger's 1-wei top-up could delay the yield)", async function () {
      const f = await loadFixture(deploy);
      const { a } = await budget(f, f.alice, 100, 50);
      await f.pool.setIndex((RAY * 105n) / 100n);
      await time.increase(3n * DAY);
      await expect(f.factory.connect(f.mallory).topUpAllowance(await a.getAddress(), 1n)).to.be.revertedWithCustomError(f.factory, "NotAllowanceOwner");
      expect(await a.available()).to.equal(usdc(105)); // principal and yield stay available
    });

    it("top-up with a cap works even after part of the yield was taken", async function () {
      const f = await loadFixture(deploy);
      const { a } = await budget(f, f.alice, 100, 100);
      await f.pool.setIndex((RAY * 105n) / 100n);
      await a.connect(f.alice).withdraw(usdc(104)); // more than was deposited (yield), 1 USDC left
      await f.factory.setVaultCap(await f.USDC.getAddress(), usdc(1000));
      await f.factory.connect(f.alice).topUpAllowance(await a.getAddress(), usdc(10));
      expect(await a.deposited()).to.equal(usdc(110));
    });
  });

  describe("V-1. Money that arrives after a safe or budget was emptied is not stuck", function () {
    it("safe: tokens sent after the full withdrawal can still be taken by the owner", async function () {
      const f = await loadFixture(deploy);
      const { v, unlock } = await vault(f, f.alice, f.alice, 100);
      await time.increaseTo(unlock);
      await v.connect(f.alice).withdraw();
      expect(await v.withdrawn()).to.equal(true);
      await expect(v.connect(f.alice).withdraw()).to.be.revertedWithCustomError(v, "AlreadyWithdrawn"); // nothing left
      await f.USDC.connect(f.bob).transfer(await v.getAddress(), usdc(5)); // a late transfer by mistake
      expect(await v.balance()).to.equal(usdc(5));
      await expect(v.connect(f.bob).withdraw()).to.be.revertedWithCustomError(v, "NotOwner");
      const before = await f.USDC.balanceOf(f.alice.address);
      await v.connect(f.alice).withdraw();
      expect((await f.USDC.balanceOf(f.alice.address)) - before).to.equal(usdc(5));
    });

    it("budget: tokens sent after it was closed can still be taken by the owner", async function () {
      const f = await loadFixture(deploy);
      const { a } = await budget(f, f.alice, 20, 20);
      await a.connect(f.alice).withdraw(ethers.MaxUint256);
      expect(await a.closed()).to.equal(true);
      await f.USDC.connect(f.bob).transfer(await a.getAddress(), usdc(5));
      expect(await a.available()).to.equal(usdc(5));
      await a.connect(f.alice).withdraw(ethers.MaxUint256);
      expect(await f.USDC.balanceOf(await a.getAddress())).to.equal(0n);
    });
  });

  describe("V-2. Other tokens (rewards, mistakes) can be rescued — but never the locked money", function () {
    it("safe: a foreign token leaves only after the date, only to the owner; the asset and aToken never through rescue", async function () {
      const f = await loadFixture(deploy);
      const { v, unlock } = await vault(f, f.alice, f.alice, 100);
      await f.OTHER.mint(await v.getAddress(), 777n);
      const aToken = await f.factory.aTokenOf(await f.USDC.getAddress());
      await expect(v.connect(f.alice).rescue(await f.OTHER.getAddress())).to.be.revertedWithCustomError(v, "StillLocked");
      await time.increaseTo(unlock);
      await expect(v.connect(f.bob).rescue(await f.OTHER.getAddress())).to.be.revertedWithCustomError(v, "NotOwner");
      await expect(v.connect(f.alice).rescue(await f.USDC.getAddress())).to.be.revertedWithCustomError(v, "NotRescuable");
      await expect(v.connect(f.alice).rescue(aToken)).to.be.revertedWithCustomError(v, "NotRescuable");
      await expect(v.connect(f.alice).rescue(await f.pool.getAddress())).to.be.revertedWithCustomError(v, "NotRescuable");
      await v.connect(f.alice).rescue(await f.OTHER.getAddress());
      expect(await f.OTHER.balanceOf(f.alice.address)).to.equal(777n);
      expect(await v.balance()).to.be.gte(usdc(100)); // the safe itself is untouched
    });

    it("budget: a foreign token leaves only when the whole budget is released", async function () {
      const f = await loadFixture(deploy);
      const { a } = await budget(f, f.alice, 40, 20);
      await f.OTHER.mint(await a.getAddress(), 777n);
      const aToken = await f.factory.aTokenOf(await f.USDC.getAddress());
      await expect(a.connect(f.alice).rescue(await f.OTHER.getAddress())).to.be.revertedWithCustomError(a, "NotReleasedYet");
      await time.increase(DAY);
      await expect(a.connect(f.bob).rescue(await f.OTHER.getAddress())).to.be.revertedWithCustomError(a, "NotOwner");
      await expect(a.connect(f.alice).rescue(await f.USDC.getAddress())).to.be.revertedWithCustomError(a, "NotRescuable");
      await expect(a.connect(f.alice).rescue(aToken)).to.be.revertedWithCustomError(a, "NotRescuable");
      await a.connect(f.alice).rescue(await f.OTHER.getAddress());
      expect(await f.OTHER.balanceOf(f.alice.address)).to.equal(777n);
    });

    it("Compound: the market itself (a transferable balance) can never be 'rescued'", async function () {
      const [admin, alice] = await ethers.getSigners();
      const T = await ethers.deployContract("TestToken", ["USD Coin", "USDC", 6, usdc(10000)]);
      const comet = await ethers.deployContract("LocalComet", [await T.getAddress(), 400]);
      const factory = await ethers.deployContract("MoneySafeFactory", [ethers.ZeroAddress, [await comet.getAddress()], admin.address]);
      await factory.allowComet(await T.getAddress());
      await T.connect(alice).faucet();
      await T.connect(alice).approve(await factory.getAddress(), ethers.MaxUint256);
      const unlock = BigInt(await time.latest()) + 30n * DAY;
      const rc = await (await factory.connect(alice).createVaultWith(1, alice.address, await T.getAddress(), usdc(100), unlock, "")).wait();
      const addr = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "VaultCreated").args.vault;
      const v = await ethers.getContractAt("MoneySafeVault", addr);
      await time.increaseTo(unlock);
      await expect(v.connect(alice).rescue(await comet.getAddress())).to.be.revertedWithCustomError(v, "NotRescuable");
    });
  });

  describe("F-1. Gift spam can be told apart and lists can be read in pages", function () {
    it("a gifted safe records who paid; own safes do not; lists have a count and pages", async function () {
      const f = await loadFixture(deploy);
      const own = await vault(f, f.alice, f.alice, 100);
      const g1 = await vault(f, f.mallory, f.alice, 1);
      const g2 = await vault(f, f.bob, f.alice, 50);
      expect(await f.factory.giftedBy(await own.v.getAddress())).to.equal(ethers.ZeroAddress);
      expect(await f.factory.giftedBy(await g1.v.getAddress())).to.equal(f.mallory.address);
      expect(await f.factory.giftedBy(await g2.v.getAddress())).to.equal(f.bob.address);
      expect(await f.factory.vaultsCount(f.alice.address)).to.equal(3n);
      expect(await f.factory.vaultsSlice(f.alice.address, 1, 10)).to.deep.equal([await g1.v.getAddress(), await g2.v.getAddress()]);
      expect(await f.factory.vaultsSlice(f.alice.address, 0, 1)).to.deep.equal([await own.v.getAddress()]);
      expect(await f.factory.vaultsSlice(f.alice.address, 5, 10)).to.deep.equal([]);
      await budget(f, f.alice, 40, 20);
      expect(await f.factory.allowancesCount(f.alice.address)).to.equal(1n);
      expect((await f.factory.allowancesSlice(f.alice.address, 0, 10)).length).to.equal(1);
    });
  });

  describe("F-2. Switching an asset off also stops top-ups", function () {
    it("no new money enters a market the admin has switched off; withdrawals are unaffected", async function () {
      const f = await loadFixture(deploy);
      const { v, unlock } = await vault(f, f.alice, f.alice, 100);
      const { a } = await budget(f, f.alice, 40, 20);
      await f.factory.disallowAsset(await f.USDC.getAddress(), 0);
      await expect(f.factory.connect(f.alice).topUp(await v.getAddress(), usdc(10))).to.be.revertedWithCustomError(f.factory, "AssetNotAllowed");
      await expect(f.factory.connect(f.alice).topUpAllowance(await a.getAddress(), usdc(10))).to.be.revertedWithCustomError(f.factory, "AssetNotAllowed");
      await a.connect(f.alice).withdraw(usdc(20));
      await time.increaseTo(unlock);
      await v.connect(f.alice).withdraw();
      expect(await v.withdrawn()).to.equal(true);
    });
  });
});

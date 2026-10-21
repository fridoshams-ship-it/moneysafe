const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 86400n;
const RAY = 10n ** 27n;
const usdc = (n) => ethers.parseUnits(String(n), 6);

describe("MoneySafe", function () {
  async function deploy() {
    const [admin, alice, bob, stranger] = await ethers.getSigners();
    const USDC = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const pool = await ethers.deployContract("MockPool", [await USDC.getAddress()]);
    const aToken = await ethers.getContractAt("MockAToken", await pool.aToken());
    const factory = await ethers.deployContract("MoneySafeFactory", [await pool.getAddress(), [], admin.address]);
    await factory.allowAsset(await USDC.getAddress());
    for (const u of [alice, bob]) {
      await USDC.mint(u.address, usdc(100000));
      await USDC.connect(u).approve(await factory.getAddress(), ethers.MaxUint256);
    }
    // extra liquidity in the pool to pay interest
    await USDC.mint(await pool.getAddress(), usdc(1000000));
    return { admin, alice, bob, stranger, USDC, pool, aToken, factory };
  }

  async function openVault(f, user, amount, days, goal = "Квартира") {
    const unlock = BigInt(await time.latest()) + days * DAY;
    const tx = await f.factory.connect(user).createVault(await f.USDC.getAddress(), amount, unlock, goal);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return f.factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "VaultCreated");
    return { vault: await ethers.getContractAt("MoneySafeVault", ev.args.vault), unlock };
  }

  it("creates a separate vault, supplies funds to Aave and records the owner", async function () {
    const f = await loadFixture(deploy);
    const { vault, unlock } = await openVault(f, f.alice, usdc(1000), 365n);
    expect(await vault.owner()).to.equal(f.alice.address);
    expect(await vault.unlockTime()).to.equal(unlock);
    expect(await vault.principal()).to.equal(usdc(1000));
    expect(await f.aToken.balanceOf(await vault.getAddress())).to.equal(usdc(1000));
    expect(await f.USDC.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await f.factory.vaultsOf(f.alice.address)).to.deep.equal([await vault.getAddress()]);
  });

  it("does not allow the owner to withdraw before the date, even one second early", async function () {
    const f = await loadFixture(deploy);
    const { vault, unlock } = await openVault(f, f.alice, usdc(1000), 30n);
    await expect(vault.connect(f.alice).withdraw()).to.be.revertedWithCustomError(vault, "StillLocked").withArgs(unlock);
    await time.setNextBlockTimestamp(unlock - 1n);
    await expect(vault.connect(f.alice).withdraw()).to.be.revertedWithCustomError(vault, "StillLocked");
  });

  it("pays principal plus Aave yield to the owner on the unlock date", async function () {
    const f = await loadFixture(deploy);
    const { vault, unlock } = await openVault(f, f.alice, usdc(1000), 365n);
    await f.pool.setIndex((RAY * 104n) / 100n); // +4% interest
    expect(await vault.earned()).to.equal(usdc(40));
    const before = await f.USDC.balanceOf(f.alice.address);
    await time.setNextBlockTimestamp(unlock);
    await expect(vault.connect(f.alice).withdraw()).to.emit(vault, "Withdrawn").withArgs(f.alice.address, usdc(1040), true);
    expect(await vault.earned()).to.equal(usdc(40));
    expect((await f.USDC.balanceOf(f.alice.address)) - before).to.equal(usdc(1040));
    expect(await vault.balance()).to.equal(0n);
  });

  it("nobody else can withdraw — not a stranger, not the MoneySafe admin", async function () {
    const f = await loadFixture(deploy);
    const { vault, unlock } = await openVault(f, f.alice, usdc(500), 10n);
    await time.increaseTo(unlock + DAY);
    await expect(vault.connect(f.stranger).withdraw()).to.be.revertedWithCustomError(vault, "NotOwner");
    await expect(vault.connect(f.admin).withdraw()).to.be.revertedWithCustomError(vault, "NotOwner");
    await expect(vault.connect(f.admin).supplyIdle()).to.be.revertedWithCustomError(vault, "OnlyFactory");
  });

  it("cannot be withdrawn twice", async function () {
    const f = await loadFixture(deploy);
    const { vault, unlock } = await openVault(f, f.alice, usdc(500), 10n);
    await time.increaseTo(unlock);
    await vault.connect(f.alice).withdraw();
    await expect(vault.connect(f.alice).withdraw()).to.be.revertedWithCustomError(vault, "AlreadyWithdrawn");
  });

  it("top-up adds to the same vault and keeps the date; impossible after unlock", async function () {
    const f = await loadFixture(deploy);
    const { vault, unlock } = await openVault(f, f.alice, usdc(1000), 60n);
    await f.factory.connect(f.bob).topUp(await vault.getAddress(), usdc(250)); // a gift from Bob
    expect(await vault.principal()).to.equal(usdc(1250));
    expect(await vault.unlockTime()).to.equal(unlock);
    await time.increaseTo(unlock);
    await expect(f.factory.connect(f.alice).topUp(await vault.getAddress(), usdc(1))).to.be.revertedWithCustomError(f.factory, "VaultUnlocked");
    const before = await f.USDC.balanceOf(f.alice.address);
    await vault.connect(f.alice).withdraw();
    expect((await f.USDC.balanceOf(f.alice.address)) - before).to.equal(usdc(1250));
  });

  it("rejects bad input: unknown asset, zero amount, date too soon or too far", async function () {
    const f = await loadFixture(deploy);
    const other = await ethers.deployContract("MockERC20", ["X", "X", 18]);
    const now = BigInt(await time.latest());
    const usdcAddr = await f.USDC.getAddress();
    await expect(f.factory.connect(f.alice).createVault(await other.getAddress(), 1n, now + 30n * DAY, "")).to.be.revertedWithCustomError(f.factory, "AssetNotAllowed");
    await expect(f.factory.connect(f.alice).createVault(usdcAddr, 0n, now + 30n * DAY, "")).to.be.revertedWithCustomError(f.factory, "ZeroAmount");
    await expect(f.factory.connect(f.alice).createVault(usdcAddr, usdc(1), now + 3600n, "")).to.be.revertedWithCustomError(f.factory, "BadUnlockTime");
    await expect(f.factory.connect(f.alice).createVault(usdcAddr, usdc(1), now + 3700n * DAY, "")).to.be.revertedWithCustomError(f.factory, "BadUnlockTime");
    await expect(f.factory.connect(f.alice).topUp(f.stranger.address, usdc(1))).to.be.revertedWithCustomError(f.factory, "UnknownVault");
  });

  it("admin pause blocks only new deposits, never withdrawals", async function () {
    const f = await loadFixture(deploy);
    const { vault, unlock } = await openVault(f, f.alice, usdc(1000), 30n);
    await f.factory.setDepositsPaused(true);
    const now = BigInt(await time.latest());
    await expect(f.factory.connect(f.bob).createVault(await f.USDC.getAddress(), usdc(1), now + 30n * DAY, "")).to.be.revertedWithCustomError(f.factory, "DepositsArePaused");
    await time.increaseTo(unlock);
    await expect(vault.connect(f.alice).withdraw()).to.emit(vault, "Withdrawn");
  });

  it("only the admin can change allowed assets or pause; admin role transfer is two-step", async function () {
    const f = await loadFixture(deploy);
    await expect(f.factory.connect(f.alice).setDepositsPaused(true)).to.be.revertedWithCustomError(f.factory, "OwnableUnauthorizedAccount");
    await expect(f.factory.connect(f.alice).disallowAsset(await f.USDC.getAddress(), 0)).to.be.revertedWithCustomError(f.factory, "OwnableUnauthorizedAccount");
    await f.factory.transferOwnership(f.bob.address);
    expect(await f.factory.owner()).to.equal(f.admin.address);
    await f.factory.connect(f.bob).acceptOwnership();
    expect(await f.factory.owner()).to.equal(f.bob.address);
  });

  it("vault implementation and clones cannot be (re)initialized", async function () {
    const f = await loadFixture(deploy);
    const impl = await ethers.getContractAt("MoneySafeVault", await f.factory.vaultImplementation());
    const args = [f.stranger.address, await f.USDC.getAddress(), 0, await f.pool.getAddress(), await f.aToken.getAddress(), 1n];
    await expect(impl.initialize(...args)).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
    const { vault } = await openVault(f, f.alice, usdc(10), 5n);
    await expect(vault.connect(f.stranger).initialize(...args)).to.be.revertedWithCustomError(vault, "AlreadyInitialized");
  });

  it("vaults are isolated: each owner gets exactly their own share of yield", async function () {
    const f = await loadFixture(deploy);
    const a = await openVault(f, f.alice, usdc(1000), 90n);
    await f.pool.setIndex((RAY * 102n) / 100n); // +2% before Bob joins
    const b = await openVault(f, f.bob, usdc(3000), 90n);
    await f.pool.setIndex((RAY * 102n * 103n) / 10000n); // a further +3%
    expect(await a.vault.balance()).to.equal(usdc(1050.6)); // 1000 * 1.02 * 1.03
    expect(await b.vault.balance()).to.be.closeTo(usdc(3090), 1n); // 3000 * 1.03 (±1 unit rounding)
    await time.increaseTo(b.unlock);
    const ba = await f.USDC.balanceOf(f.alice.address);
    await a.vault.connect(f.alice).withdraw();
    expect((await f.USDC.balanceOf(f.alice.address)) - ba).to.equal(usdc(1050.6));
  });

  it("if Aave pauses, withdrawal waits and succeeds once Aave resumes", async function () {
    const f = await loadFixture(deploy);
    const { vault, unlock } = await openVault(f, f.alice, usdc(700), 20n);
    await time.increaseTo(unlock);
    await f.pool.setPaused(true);
    await expect(vault.connect(f.alice).withdraw()).to.be.revertedWith("pool paused");
    expect(await vault.withdrawn()).to.equal(false);
    await f.pool.setPaused(false);
    await expect(vault.connect(f.alice).withdraw()).to.emit(vault, "Withdrawn").withArgs(f.alice.address, usdc(700), true);
  });

  it("when Aave liquidity is short: full withdraw reverts safely, partial withdraw works, the rest later", async function () {
    const f = await loadFixture(deploy);
    const { vault, unlock } = await openVault(f, f.alice, usdc(1000), 30n);
    await time.increaseTo(unlock);
    await f.pool.setLiquidityCap(usdc(300));
    await expect(vault.connect(f.alice).withdraw()).to.be.revertedWith("not enough liquidity");
    const b0 = await f.USDC.balanceOf(f.alice.address);
    await expect(vault.connect(f.alice).withdrawPartial(usdc(300))).to.emit(vault, "Withdrawn").withArgs(f.alice.address, usdc(300), false);
    expect(await vault.withdrawn()).to.equal(false);
    expect(await vault.balance()).to.be.closeTo(usdc(700), 1n);
    await f.pool.setLiquidityCap(ethers.MaxUint256);
    await vault.connect(f.alice).withdraw();
    expect(await vault.withdrawn()).to.equal(true);
    expect((await f.USDC.balanceOf(f.alice.address)) - b0).to.be.closeTo(usdc(1000), 1n);
    await expect(vault.connect(f.alice).withdrawPartial(1n)).to.be.revertedWithCustomError(vault, "AlreadyWithdrawn");
  });

  it("partial withdraw is also impossible before the date and for strangers", async function () {
    const f = await loadFixture(deploy);
    const { vault, unlock } = await openVault(f, f.alice, usdc(1000), 30n);
    await expect(vault.connect(f.alice).withdrawPartial(usdc(1))).to.be.revertedWithCustomError(vault, "StillLocked");
    await time.increaseTo(unlock);
    await expect(vault.connect(f.stranger).withdrawPartial(usdc(1))).to.be.revertedWithCustomError(vault, "NotOwner");
    await expect(vault.connect(f.alice).withdrawPartial(0n)).to.be.revertedWithCustomError(vault, "ZeroAmount");
  });

  it("beta cap limits new deposits and top-ups only; existing vaults still withdraw", async function () {
    const f = await loadFixture(deploy);
    const a = await f.USDC.getAddress();
    await expect(f.factory.connect(f.alice).setVaultCap(a, usdc(500))).to.be.revertedWithCustomError(f.factory, "OwnableUnauthorizedAccount");
    const { vault: old, unlock } = await openVault(f, f.alice, usdc(2000), 30n);
    await expect(f.factory.setVaultCap(a, usdc(500))).to.emit(f.factory, "VaultCapSet").withArgs(a, usdc(500));
    const now = BigInt(await time.latest());
    await expect(f.factory.connect(f.bob).createVault(a, usdc(501), now + 30n * DAY, "x")).to.be.revertedWithCustomError(f.factory, "AboveVaultCap");
    const { vault } = await openVault(f, f.bob, usdc(400), 30n);
    await f.factory.connect(f.bob).topUp(await vault.getAddress(), usdc(100));
    await expect(f.factory.connect(f.bob).topUp(await vault.getAddress(), 1n)).to.be.revertedWithCustomError(f.factory, "AboveVaultCap");
    await time.setNextBlockTimestamp(unlock);
    await expect(old.connect(f.alice).withdraw()).to.emit(old, "Withdrawn").withArgs(f.alice.address, usdc(2000), true);
    await f.factory.setVaultCap(a, 0);
    await openVault(f, f.bob, usdc(5000), 30n);
  });

  it("rejects an over-long goal label", async function () {
    const f = await loadFixture(deploy);
    const now = BigInt(await time.latest());
    await expect(f.factory.connect(f.alice).createVault(await f.USDC.getAddress(), usdc(1), now + 30n * DAY, "x".repeat(65))).to.be.revertedWithCustomError(f.factory, "GoalTooLong");
    await expect(f.factory.connect(f.alice).createVault(await f.USDC.getAddress(), usdc(1), now + 30n * DAY, "Квартира в Ташкенте")).to.emit(f.factory, "VaultCreated");
  });

  it("works with USDT-style approve (must reset to zero) across several deposits", async function () {
    const [admin, alice] = await ethers.getSigners();
    const USDT = await ethers.deployContract("MockUSDTLike");
    const pool = await ethers.deployContract("MockPool", [await USDT.getAddress()]);
    const factory = await ethers.deployContract("MoneySafeFactory", [await pool.getAddress(), [], admin.address]);
    await factory.allowAsset(await USDT.getAddress());
    await USDT.mint(alice.address, usdc(5000));
    await USDT.connect(alice).approve(await factory.getAddress(), ethers.MaxUint256);
    const unlock = BigInt(await time.latest()) + 40n * DAY;
    const rc = await (await factory.connect(alice).createVault(await USDT.getAddress(), usdc(1000), unlock, "USDT")).wait();
    const vaultAddr = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "VaultCreated").args.vault;
    await factory.connect(alice).topUp(vaultAddr, usdc(500));
    await factory.connect(alice).topUp(vaultAddr, usdc(250));
    const vault = await ethers.getContractAt("MoneySafeVault", vaultAddr);
    expect(await vault.principal()).to.equal(usdc(1750));
  });

  it("works with an 18-decimal asset like WETH", async function () {
    const [admin, alice] = await ethers.getSigners();
    const WETH = await ethers.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18]);
    const pool = await ethers.deployContract("MockPool", [await WETH.getAddress()]);
    const factory = await ethers.deployContract("MoneySafeFactory", [await pool.getAddress(), [], admin.address]);
    await factory.allowAsset(await WETH.getAddress());
    await WETH.mint(alice.address, ethers.parseEther("10"));
    await WETH.mint(await pool.getAddress(), ethers.parseEther("100"));
    await WETH.connect(alice).approve(await factory.getAddress(), ethers.MaxUint256);
    const unlock = BigInt(await time.latest()) + 365n * DAY;
    const rc = await (await factory.connect(alice).createVault(await WETH.getAddress(), ethers.parseEther("1.5"), unlock, "HODL")).wait();
    const vaultAddr = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "VaultCreated").args.vault;
    const vault = await ethers.getContractAt("MoneySafeVault", vaultAddr);
    await pool.setIndex((RAY * 1021n) / 1000n); // +2.1%
    await time.increaseTo(unlock);
    const b0 = await WETH.balanceOf(alice.address);
    await vault.connect(alice).withdraw();
    expect((await WETH.balanceOf(alice.address)) - b0).to.equal(ethers.parseEther("1.5315"));
  });

  it("tokens sent straight to a vault are not lost: they go to the owner at unlock", async function () {
    const f = await loadFixture(deploy);
    const { vault, unlock } = await openVault(f, f.alice, usdc(100), 10n);
    await f.USDC.connect(f.bob).transfer(await vault.getAddress(), usdc(5));
    await time.increaseTo(unlock);
    const b0 = await f.USDC.balanceOf(f.alice.address);
    await vault.connect(f.alice).withdraw();
    expect((await f.USDC.balanceOf(f.alice.address)) - b0).to.equal(usdc(105));
  });

  it("gift vault: the payer funds it, only the recipient can withdraw, and only on the date", async function () {
    const f = await loadFixture(deploy);
    const unlock = BigInt(await time.latest()) + 90n * DAY;
    const usdcAddr = await f.USDC.getAddress();
    await expect(f.factory.connect(f.alice).createVaultFor(ethers.ZeroAddress, usdcAddr, usdc(300), unlock, "Подарок"))
      .to.be.revertedWithCustomError(f.factory, "ZeroRecipient");
    const aliceBefore = await f.USDC.balanceOf(f.alice.address);
    const tx = await f.factory.connect(f.alice).createVaultFor(f.bob.address, usdcAddr, usdc(300), unlock, "Подарок Бобу");
    const rc = await tx.wait();
    const evs = rc.logs.map((l) => { try { return f.factory.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    const created = evs.find((e) => e.name === "VaultCreated"), gifted = evs.find((e) => e.name === "VaultGifted");
    expect(created.args.owner).to.equal(f.bob.address);
    expect(gifted.args.from).to.equal(f.alice.address);
    expect(gifted.args.recipient).to.equal(f.bob.address);
    const vault = await ethers.getContractAt("MoneySafeVault", created.args.vault);
    expect(aliceBefore - (await f.USDC.balanceOf(f.alice.address))).to.equal(usdc(300));
    expect(await vault.owner()).to.equal(f.bob.address);
    expect(await f.factory.vaultsOf(f.bob.address)).to.deep.equal([await vault.getAddress()]);
    expect(await f.factory.vaultsOf(f.alice.address)).to.deep.equal([]);
    await expect(vault.connect(f.bob).withdraw()).to.be.revertedWithCustomError(vault, "StillLocked");
    await time.increaseTo(unlock);
    await expect(vault.connect(f.alice).withdraw()).to.be.revertedWithCustomError(vault, "NotOwner");
    const bobBefore = await f.USDC.balanceOf(f.bob.address);
    await vault.connect(f.bob).withdraw();
    expect((await f.USDC.balanceOf(f.bob.address)) - bobBefore).to.equal(usdc(300));
  });

  describe("Compound III markets", function () {
    async function deployComet() {
      const [admin, alice, bob, stranger] = await ethers.getSigners();
      const USDC = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
      const comet = await ethers.deployContract("MockComet", [await USDC.getAddress()]);
      const factory = await ethers.deployContract("MoneySafeFactory", [ethers.ZeroAddress, [await comet.getAddress()], admin.address]);
      await factory.allowComet(await USDC.getAddress());
      for (const u of [alice, bob]) { await USDC.mint(u.address, usdc(100000)); await USDC.connect(u).approve(await factory.getAddress(), ethers.MaxUint256); }
      await USDC.mint(await comet.getAddress(), usdc(1000000));
      return { admin, alice, bob, stranger, USDC, comet, factory };
    }
    const open = async (f, user, recipient, amount, days) => {
      const unlock = BigInt(await time.latest()) + days * DAY;
      const rc = await (await f.factory.connect(user).createVaultWith(1, recipient, await f.USDC.getAddress(), amount, unlock, "Comet")).wait();
      const ev = rc.logs.map((l) => { try { return f.factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "VaultCreated");
      return { vault: await ethers.getContractAt("MoneySafeVault", ev.args.vault), unlock };
    };

    it("locks in Compound III and pays principal plus interest only to the owner on the date", async function () {
      const f = await loadFixture(deployComet);
      const { vault, unlock } = await open(f, f.alice, f.alice.address, usdc(2000), 180n);
      expect(await vault.protocol()).to.equal(1);
      expect(await vault.market()).to.equal(await f.comet.getAddress());
      expect(await f.comet.balanceOf(await vault.getAddress())).to.equal(usdc(2000));
      await f.comet.setIndex(105n * 10n ** 16n); // +5%
      expect(await vault.earned()).to.equal(usdc(100));
      await expect(vault.connect(f.alice).withdraw()).to.be.revertedWithCustomError(vault, "StillLocked");
      await time.increaseTo(unlock);
      await expect(vault.connect(f.stranger).withdraw()).to.be.revertedWithCustomError(vault, "NotOwner");
      const before = await f.USDC.balanceOf(f.alice.address);
      await expect(vault.connect(f.alice).withdraw()).to.emit(vault, "Withdrawn").withArgs(f.alice.address, usdc(2100), true);
      expect((await f.USDC.balanceOf(f.alice.address)) - before).to.equal(usdc(2100));
      await expect(vault.connect(f.alice).withdraw()).to.be.revertedWithCustomError(vault, "AlreadyWithdrawn");
    });

    it("partial withdraw works on Compound, and a paused market only delays the payout", async function () {
      const f = await loadFixture(deployComet);
      const { vault, unlock } = await open(f, f.alice, f.alice.address, usdc(1000), 30n);
      await time.increaseTo(unlock);
      await f.comet.setPaused(true);
      await expect(vault.connect(f.alice).withdraw()).to.be.revertedWith("comet paused");
      expect(await vault.withdrawn()).to.equal(false);
      await f.comet.setPaused(false);
      await vault.connect(f.alice).withdrawPartial(usdc(400));
      expect(await vault.withdrawn()).to.equal(false);
      expect(await vault.balance()).to.equal(usdc(600));
      await vault.connect(f.alice).withdraw();
      expect(await vault.withdrawn()).to.equal(true);
      expect(await vault.withdrawnTotal()).to.equal(usdc(1000));
    });

    it("gift on Compound: only the recipient can withdraw", async function () {
      const f = await loadFixture(deployComet);
      const { vault, unlock } = await open(f, f.alice, f.bob.address, usdc(500), 10n);
      expect(await vault.owner()).to.equal(f.bob.address);
      await time.increaseTo(unlock);
      await expect(vault.connect(f.alice).withdraw()).to.be.revertedWithCustomError(vault, "NotOwner");
      await vault.connect(f.bob).withdraw();
      expect(await vault.withdrawn()).to.equal(true);
    });

    it("admin cannot add a new market: only markets fixed at deployment can be switched on", async function () {
      const f = await loadFixture(deployComet);
      const other = await ethers.deployContract("MockERC20", ["Other", "OTH", 18]);
      await expect(f.factory.allowComet(await other.getAddress())).to.be.revertedWithCustomError(f.factory, "NoCometMarket");
      await expect(f.factory.allowAsset(await f.USDC.getAddress())).to.be.revertedWithCustomError(f.factory, "ATokenMismatch");
      await expect(f.factory.connect(f.alice).allowComet(await f.USDC.getAddress())).to.be.revertedWithCustomError(f.factory, "OwnableUnauthorizedAccount");
      const unlock = BigInt(await time.latest()) + 30n * DAY;
      await expect(f.factory.connect(f.alice).createVaultWith(2, f.alice.address, await f.USDC.getAddress(), usdc(1), unlock, "")).to.be.revertedWithCustomError(f.factory, "BadProtocol");
      await expect(f.factory.connect(f.alice).createVault(await f.USDC.getAddress(), usdc(1), unlock, "")).to.be.revertedWithCustomError(f.factory, "AssetNotAllowed");
      await f.factory.disallowAsset(await f.USDC.getAddress(), 1);
      await expect(f.factory.connect(f.alice).createVaultWith(1, f.alice.address, await f.USDC.getAddress(), usdc(1), unlock, "")).to.be.revertedWithCustomError(f.factory, "AssetNotAllowed");
    });
  });
});

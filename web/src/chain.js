// MoneySafe chain layer: talks to the MoneySafe contracts on a real network.
// Wallets: Reown AppKit (WalletConnect, email and Google/Apple logins) or, for automated tests only, a dev key.
// The app (index.html) calls window.MSChain; it never touches the blockchain directly.
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, parseUnits, getAddress, parseEventLogs } from 'viem'
import { arbitrumSepolia, polygonAmoy, arbitrum, polygon, hardhat } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import deployments from './deployments.json'

const CHAINS = { 421614: arbitrumSepolia, 80002: polygonAmoy, 42161: arbitrum, 137: polygon, 31337: hardhat }
const EXPLORER = { 421614: 'https://sepolia.arbiscan.io', 80002: 'https://amoy.polygonscan.com', 42161: 'https://arbiscan.io', 137: 'https://polygonscan.com' }
const GAS_FAUCET = { 421614: 'https://www.alchemy.com/faucets/arbitrum-sepolia', 80002: 'https://faucet.polygon.technology' }

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function faucet()',
  'function lastFaucet(address) view returns (uint256)',
])
const FACTORY = parseAbi([
  'function createVaultWith(uint8 protocol, address recipient, address asset, uint256 amount, uint64 unlockTime, string goal) returns (address)',
  'function topUp(address vault, uint256 amount)',
  'function vaultsOf(address) view returns (address[])',
  'event VaultCreated(address indexed owner, address indexed vault, address indexed asset, uint256 amount, uint64 unlockTime, string goal)',
  'event VaultGifted(address indexed from, address indexed recipient, address indexed vault)',
])
const VAULT = parseAbi([
  'function asset() view returns (address)',
  'function owner() view returns (address)',
  'function unlockTime() view returns (uint64)',
  'function createdAt() view returns (uint64)',
  'function principal() view returns (uint256)',
  'function balance() view returns (uint256)',
  'function earned() view returns (uint256)',
  'function withdrawn() view returns (bool)',
  'function withdrawnTotal() view returns (uint256)',
  'function withdraw()',
  'function withdrawPartial(uint256)',
])
const POOL = parseAbi(['function getReserveData(address) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))'])

function pickDeployment() {
  const want = (globalThis.MS_NETWORK || '').trim()
  const list = Object.values(deployments || {})
  return list.find((d) => d.network === want) || list.find((d) => d.network === 'arbitrumSepolia') || list[0] || null
}

const D = pickDeployment()
const chain = D ? CHAINS[D.chainId] : null
const rpc = (globalThis.MS_RPC || '').trim() || undefined
const pub = D ? createPublicClient({ chain, transport: http(rpc) }) : null
const symOf = D ? Object.fromEntries(Object.entries(D.tokens).map(([s, t]) => [t.address.toLowerCase(), s])) : {}

let wallet = null // viem wallet client
let address = null
let appkit = null
const listeners = new Set()
const emit = () => listeners.forEach((f) => { try { f(address) } catch (e) {} })

async function initAppKit() {
  if (appkit) return appkit
  const projectId = (globalThis.MS_REOWN_PROJECT_ID || import.meta.env.VITE_REOWN_PROJECT_ID || '').trim()
  if (!projectId) throw new Error('NO_PROJECT_ID')
  const [{ createAppKit }, { WagmiAdapter }, core] = await Promise.all([import('@reown/appkit'), import('@reown/appkit-adapter-wagmi'), import('@wagmi/core')])
  const adapter = new WagmiAdapter({ projectId, networks: [chain] })
  appkit = createAppKit({
    adapters: [adapter], networks: [chain], projectId,
    metadata: { name: 'MoneySafe', description: 'Сейф от самого себя', url: location.origin, icons: [location.origin + location.pathname.replace(/[^/]*$/, '') + 'icon-192.png'] },
    features: { email: true, socials: ['google', 'apple'], emailShowWallets: true, analytics: false },
    themeMode: 'light', themeVariables: { '--w3m-accent': '#0A6CF0', '--w3m-border-radius-master': '4px' },
  })
  core.watchAccount(adapter.wagmiConfig, {
    onChange: async (acc) => {
      if (acc.isConnected && acc.address) {
        const wc = await core.getWalletClient(adapter.wagmiConfig, { chainId: chain.id }).catch(() => null)
        wallet = wc; address = getAddress(acc.address)
      } else { wallet = null; address = null }
      emit()
    },
  })
  return appkit
}

function useDevKey(pk) {
  const account = privateKeyToAccount(pk)
  wallet = createWalletClient({ account, chain, transport: http(rpc) })
  address = account.address
  emit()
}

async function waitTx(hash) {
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error('TX_FAILED')
  return r
}
const write = async (req) => waitTx(await wallet.writeContract({ account: wallet.account, chain, ...req }))
const dec = (sym) => D.tokens[sym].decimals
const toUnits = (sym, n) => parseUnits(String(+(+n).toFixed(dec(sym))), dec(sym))
const fromUnits = (sym, v) => Number(formatUnits(v, dec(sym)))

async function readVault(addr) {
  const c = { address: addr, abi: VAULT }
  const [asset, owner, unlock, created, principal, bal, earned, withdrawn, wTotal] = await Promise.all(
    ['asset', 'owner', 'unlockTime', 'createdAt', 'principal', 'balance', 'earned', 'withdrawn', 'withdrawnTotal'].map((f) => pub.readContract({ ...c, functionName: f })))
  const sym = symOf[asset.toLowerCase()] || '?'
  return { addr, sym, owner, to: Number(unlock) * 1000, from: Number(created) * 1000, q: fromUnits(sym, principal), val: fromUnits(sym, bal),
    earned: fromUnits(sym, earned), withdrawn, withdrawnTotal: fromUnits(sym, wTotal) }
}

async function goals(filterArgs) {
  const logs = await pub.getLogs({ address: D.factory, event: FACTORY[3], args: filterArgs, fromBlock: BigInt(D.block || 0) })
  return Object.fromEntries(logs.map((l) => [l.args.vault.toLowerCase(), l.args.goal]))
}

const MSChain = {
  get ready() { return !!D },
  get address() { return address },
  get connected() { return !!(wallet && address) },
  info() { return D ? { network: D.network, chainId: D.chainId, chainName: chain.name, testnet: !!D.testnet, factory: D.factory, explorer: EXPLORER[D.chainId] || '', gasFaucet: GAS_FAUCET[D.chainId] || '', tokens: Object.keys(D.tokens) } : null },
  onChange(f) { listeners.add(f); return () => listeners.delete(f) },

  async connect() {
    const dev = globalThis.MS_DEV_KEY
    if (dev) { useDevKey(dev); return address }
    const kit = await initAppKit()
    if (address) return address
    await kit.open()
    return new Promise((res, rej) => {
      const off = MSChain.onChange((a) => { if (a) { off(); res(a) } })
      const t = setInterval(() => { if (!kit.isOpen?.() && !address) { clearInterval(t); off(); rej(new Error('CANCELLED')) } }, 800)
    })
  },
  /** Re-attach a session that was connected before (AppKit restores it by itself). */
  async restore(ms = 3500) {
    if (globalThis.MS_DEV_KEY) { useDevKey(globalThis.MS_DEV_KEY); return address }
    try { await initAppKit() } catch (e) { return null }
    if (address) return address
    return new Promise((res) => { const off = MSChain.onChange((a) => { if (a) { off(); res(a) } }); setTimeout(() => { off(); res(address) }, ms) })
  },
  async disconnect() { try { if (appkit) await appkit.disconnect() } catch (e) {} wallet = null; address = null; emit() },

  /** Full picture for the app: balances, my vaults, gifts I sent, gas, rates. */
  async state(who) {
    const me = getAddress(who || address)
    const syms = Object.keys(D.tokens)
    const [bals, gas, myVaults, myGoals, giftLogs, rates] = await Promise.all([
      Promise.all(syms.map((s) => pub.readContract({ address: D.tokens[s].address, abi: ERC20, functionName: 'balanceOf', args: [me] }))),
      pub.getBalance({ address: me }),
      pub.readContract({ address: D.factory, abi: FACTORY, functionName: 'vaultsOf', args: [me] }),
      goals({ owner: me }),
      pub.getLogs({ address: D.factory, event: FACTORY[4], args: { from: me }, fromBlock: BigInt(D.block || 0) }),
      D.pool ? Promise.all(syms.map((s) => pub.readContract({ address: D.pool, abi: POOL, functionName: 'getReserveData', args: [D.tokens[s].address] }).then((r) => Number(r.currentLiquidityRate) / 1e27).catch(() => 0))) : syms.map(() => 0),
    ])
    const wallet = Object.fromEntries(syms.map((s, i) => [s, fromUnits(s, bals[i])]))
    const vaults = await Promise.all(myVaults.map(async (a) => ({ ...(await readVault(a)), goal: myGoals[a.toLowerCase()] || '' })))
    const giftAddrs = giftLogs.map((l) => l.args.vault)
    const giftGoals = giftAddrs.length ? await goals({ vault: giftAddrs }) : {}
    const gifts = await Promise.all(giftAddrs.map(async (a) => ({ ...(await readVault(a)), goal: giftGoals[a.toLowerCase()] || '' })))
    const apr = Object.fromEntries(syms.map((s, i) => [s, rates[i]]))
    return { address: me, wallet, gas: Number(formatUnits(gas, 18)), vaults, gifts, apr, at: Date.now() }
  },

  async faucetStatus(sym, who) {
    const last = Number(await pub.readContract({ address: D.tokens[sym].address, abi: ERC20, functionName: 'lastFaucet', args: [getAddress(who || address)] }))
    return { nextAt: last ? (last + 86400) * 1000 : 0, amount: D.tokens[sym].faucet }
  },
  async faucet(sym) { const r = await write({ address: D.tokens[sym].address, abi: ERC20, functionName: 'faucet' }); return r.transactionHash },

  /** onStep(i, hash): 0 = approved, 1 = vault created, 2 = confirmed. */
  async createVault({ sym, amount, unlockMs, goal, recipient }, onStep = () => {}) {
    const token = D.tokens[sym].address, amt = toUnits(sym, amount)
    const allowance = await pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [address, D.factory] })
    if (allowance < amt) { const r = await write({ address: token, abi: ERC20, functionName: 'approve', args: [D.factory, amt] }); onStep(0, r.transactionHash) } else onStep(0, null)
    const r = await write({ address: D.factory, abi: FACTORY, functionName: 'createVaultWith',
      args: [0, recipient ? getAddress(recipient) : address, token, amt, BigInt(Math.floor(unlockMs / 1000)), String(goal || '').slice(0, 30)] })
    onStep(1, r.transactionHash)
    const ev = parseEventLogs({ abi: FACTORY, logs: r.logs, eventName: 'VaultCreated' })[0]
    const vault = ev ? getAddress(ev.args.vault) : null
    onStep(2, r.transactionHash)
    return { hash: r.transactionHash, vault }
  },
  async topUp(vault, sym, amount) {
    const token = D.tokens[sym].address, amt = toUnits(sym, amount)
    const allowance = await pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [address, D.factory] })
    if (allowance < amt) await write({ address: token, abi: ERC20, functionName: 'approve', args: [D.factory, amt] })
    return (await write({ address: D.factory, abi: FACTORY, functionName: 'topUp', args: [vault, amt] })).transactionHash
  },
  async withdraw(vault) { return (await write({ address: vault, abi: VAULT, functionName: 'withdraw' })).transactionHash },
  async send(sym, to, amount) { return (await write({ address: D.tokens[sym].address, abi: ERC20, functionName: 'transfer', args: [getAddress(to), toUnits(sym, amount)] })).transactionHash },
  txUrl(hash) { return EXPLORER[D?.chainId] ? EXPLORER[D.chainId] + '/tx/' + hash : '' },
  addrUrl(a) { return EXPLORER[D?.chainId] ? EXPLORER[D.chainId] + '/address/' + a : '' },
}

if (!globalThis.MS_API && import.meta.env.VITE_MS_API) globalThis.MS_API = import.meta.env.VITE_MS_API
globalThis.MSChain = MSChain
globalThis.dispatchEvent?.(new Event('mschain-ready'))
export default MSChain

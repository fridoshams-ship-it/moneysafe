// MoneySafe chain layer: talks to the MoneySafe contracts on a real network.
// Wallets: Reown AppKit (WalletConnect, email and Google/Apple logins) or, for automated tests only, a dev key.
// The app (index.html) calls window.MSChain; it never touches the blockchain directly.
import { createPublicClient, createWalletClient, http, custom, parseAbi, numberToHex, parseSignature, formatUnits, parseUnits, getAddress, parseEventLogs } from 'viem'
import { arbitrumSepolia, polygonAmoy, arbitrum, polygon, base, baseSepolia, hardhat } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import deployments from './deployments.json'
import './native.js'

const CHAINS = { 421614: arbitrumSepolia, 80002: polygonAmoy, 42161: arbitrum, 137: polygon, 8453: base, 84532: baseSepolia, 31337: hardhat }
const EXPLORER = { 421614: 'https://sepolia.arbiscan.io', 80002: 'https://amoy.polygonscan.com', 42161: 'https://arbiscan.io', 137: 'https://polygonscan.com', 8453: 'https://basescan.org', 84532: 'https://sepolia.basescan.org' }
const GAS_FAUCET = { 421614: 'https://www.alchemy.com/faucets/arbitrum-sepolia', 80002: 'https://faucet.polygon.technology', 84532: 'https://www.alchemy.com/faucets/base-sepolia' }

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function faucet()',
  'function lastFaucet(address) view returns (uint256)',
])
const WETH = parseAbi(['function deposit() payable', 'function withdraw(uint256)'])
const PERMIT = parseAbi(['function nonces(address) view returns (uint256)', 'function name() view returns (string)', 'function version() view returns (string)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)'])
async function permitDomain(token) {
  const d = await pub.readContract({ address: token, abi: PERMIT, functionName: 'eip712Domain' }).catch(() => null)
  if (d) return { name: d[1], version: d[2], chainId: Number(d[3]), verifyingContract: d[4] }
  await pub.readContract({ address: token, abi: PERMIT, functionName: 'nonces', args: [signerAddress] }) // throws when permit is not supported
  const [name, version] = await Promise.all([pub.readContract({ address: token, abi: PERMIT, functionName: 'name' }), pub.readContract({ address: token, abi: PERMIT, functionName: 'version' }).catch(() => '1')])
  return { name, version, chainId: chain.id, verifyingContract: token }
}
const FACTORY = parseAbi([
  'function createVaultWith(uint8 protocol, address recipient, address asset, uint256 amount, uint64 unlockTime, string goal) returns (address)',
  'function topUp(address vault, uint256 amount)',
  'function vaultsOf(address) view returns (address[])',
  'event VaultCreated(address indexed owner, address indexed vault, address indexed asset, uint256 amount, uint64 unlockTime, string goal)',
  'event VaultGifted(address indexed from, address indexed recipient, address indexed vault)',
  'function vaultCap(address) view returns (uint256)',
  'function createAllowance(uint8 protocol, address asset, uint256 amount, uint256 rate, uint64 period, uint64 start, string goal) returns (address)',
  'function topUpAllowance(address allowance, uint256 amount)',
  'function allowancesOf(address) view returns (address[])',
  'event AllowanceCreated(address indexed owner, address indexed allowance, address indexed asset, uint256 amount, uint256 rate, uint64 period, uint64 start, string goal)',
  'error AboveVaultCap()', 'error DepositsArePaused()', 'error AssetNotAllowed()', 'error BadUnlockTime()', 'error VaultUnlocked()', 'error RateAboveAmount()', 'error Closed()',
])
const ALLOW = parseAbi([
  'function asset() view returns (address)', 'function deposited() view returns (uint256)', 'function withdrawnTotal() view returns (uint256)',
  'function rate() view returns (uint256)', 'function period() view returns (uint64)', 'function start() view returns (uint64)',
  'function createdAt() view returns (uint64)', 'function lastRateChange() view returns (uint64)', 'function checkpointPeriods() view returns (uint256)',
  'function accruedAtCheckpoint() view returns (uint256)', 'function earned() view returns (uint256)', 'function closed() view returns (bool)',
  'function available() view returns (uint256)', 'function withdraw(uint256)', 'function setRate(uint256)',
  'error MoreThanAvailable(uint256 available)', 'error RaiseTooSoon(uint64 allowedFrom)', 'error SameRate()', 'error Closed()', 'error NotOwner()',
])
const ALLOW_EV = FACTORY.find((x) => x.type === 'event' && x.name === 'AllowanceCreated')
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
  'error StillLocked(uint64 unlockTime)', 'error NotOwner()', 'error AlreadyWithdrawn()',
])
const POOL = parseAbi(['function getReserveData(address) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))'])

// MS_NETWORK = a deployment name, or 'real' (first non-test deployment) / 'test' (first test deployment).
function pickDeployment() {
  const want = (globalThis.MS_NETWORK || '').trim()
  const list = Object.values(deployments || {})
  if (want === 'real') return list.find((d) => !d.testnet && d.network === (globalThis.MS_REAL_NET || '').trim()) || list.find((d) => !d.testnet) || null
  if (want === 'test' || !want) return list.find((d) => d.testnet && d.network === 'arbitrumSepolia') || list.find((d) => d.testnet) || null
  return list.find((d) => d.network === want) || null
}
const AVAILABLE = { real: Object.values(deployments || {}).some((d) => !d.testnet), test: Object.values(deployments || {}).some((d) => d.testnet),
  realNets: Object.values(deployments || {}).filter((d) => !d.testnet).map((d) => ({ network: d.network, name: (CHAINS[d.chainId] || {}).name || d.network })) }
const GAS_RESERVE_EOA = 0.0003 // native ETH kept for gas when wrapping ETH into a vault (not needed with sponsored gas)

const D = pickDeployment()

// Sponsored gas (ERC-4337): with a bundler + paymaster the user's MoneySafe address is a smart account owned by their wallet,
// and MoneySafe pays the gas. Pimlico: set VITE_PIMLICO_KEY at build time (or MS_PIMLICO_KEY); any ERC-4337/7677 service: MS_BUNDLER_URL + MS_PAYMASTER_URL.
const PIMLICO = (globalThis.MS_PIMLICO_KEY || import.meta.env.VITE_PIMLICO_KEY || '').trim()
const BUNDLER = (globalThis.MS_BUNDLER_URL || '').trim() || (PIMLICO && D ? `https://api.pimlico.io/v2/${D.chainId}/rpc?apikey=${PIMLICO}` : '')
const PAYMASTER = (globalThis.MS_PAYMASTER_URL || '').trim() || BUNDLER
const AA = globalThis.MS_AA || {} // { entryPoint, factory } overrides, for local tests
let sac = null // smart account client when gas is sponsored
let signerAddress = null
const chain = D ? CHAINS[D.chainId] : null
const rpc = (globalThis.MS_RPC || '').trim() || undefined
const pub = D ? createPublicClient({ chain, transport: http(rpc) }) : null
const symOf = D ? Object.fromEntries(Object.entries(D.tokens).map(([s, t]) => [t.address.toLowerCase(), s])) : {}

let wallet = null // viem wallet client
let address = null
let appkit = null
let injected = null // window.ethereum of MetaMask / Trust / other in-wallet browsers
// Wallets found on this device: EIP-6963 (every modern extension and in-wallet browser announces itself) + legacy window.ethereum.
const found = new Map()
let chosenId = (() => { try { return localStorage.getItem('ms-wallet') || '' } catch (e) { return '' } })()
let connectedVia = null // { kind: 'injected' | 'walletconnect' | 'dev', name, icon }
if (globalThis.addEventListener) {
  globalThis.addEventListener('eip6963:announceProvider', (e) => { const d = e.detail; if (d && d.info && d.provider) found.set(d.info.uuid, d) })
  globalThis.dispatchEvent?.(new Event('eip6963:requestProvider'))
}
const legacyName = (p) => p.isMetaMask ? 'MetaMask' : p.isTrust || p.isTrustWallet ? 'Trust Wallet' : p.isCoinbaseWallet ? 'Coinbase Wallet' : p.isOkxWallet || p.isOKExWallet ? 'OKX Wallet' : p.isBitKeep || p.isBitgetWallet ? 'Bitget Wallet' : p.isPhantom ? 'Phantom' : p.isRabby ? 'Rabby' : 'Кошелёк браузера'
function walletList() {
  const list = [...found.values()].map((d) => ({ id: d.info.uuid, rdns: d.info.rdns, name: d.info.name, icon: d.info.icon, provider: d.provider }))
  if (!list.length && globalThis.ethereum) list.push({ id: 'injected', rdns: '', name: legacyName(globalThis.ethereum), icon: '', provider: globalThis.ethereum })
  return list
}
const providerFor = (id) => { const l = walletList(); return (l.find((w) => w.id === id || (w.rdns && w.rdns === id)) || l[0] || {}).provider || null }
const eth = () => providerFor(chosenId)
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
        connectedVia = { kind: 'walletconnect', name: (appkit && appkit.getWalletInfo && appkit.getWalletInfo()?.name) || 'WalletConnect', icon: (appkit && appkit.getWalletInfo && appkit.getWalletInfo()?.icon) || '' }
        await onSigner(); return
      } else { wallet = null; address = null; sac = null }
      emit()
    },
  })
  return appkit
}

async function switchChain(p) {
  const hex = numberToHex(chain.id)
  try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }) }
  catch (e) {
    if (e && (e.code === 4902 || /Unrecognized|not added|4902/i.test(String(e.message)))) {
      await p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: chain.name, nativeCurrency: chain.nativeCurrency,
        rpcUrls: [rpc || chain.rpcUrls.default.http[0]], blockExplorerUrls: EXPLORER[chain.id] ? [EXPLORER[chain.id]] : [] }] })
    } else throw e
  }
}
function useInjected(p, a) {
  injected = p
  wallet = createWalletClient({ account: getAddress(a), chain, transport: custom(p) })
  address = getAddress(a)
  if (!p.__msListen && p.on) {
    p.__msListen = true
    p.on('accountsChanged', (acc) => { if (acc && acc[0]) useInjected(p, acc[0]); else { wallet = null; address = null; sac = null; emit() } })
    p.on('chainChanged', () => {})
  }
  return onSigner()
}
async function connectInjected(silent, p = eth()) {
  if (!p) return null
  const acc = await p.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' })
  if (!acc || !acc[0]) return null
  if (!silent) await switchChain(p)
  const w = walletList().find((x) => x.provider === p)
  connectedVia = { kind: 'injected', name: w ? w.name : legacyName(p), icon: w ? w.icon : '' }
  return useInjected(p, acc[0])
}
async function ensureChain() {
  if (!injected) return
  const id = Number(await injected.request({ method: 'eth_chainId' }))
  if (id !== chain.id) await switchChain(injected)
}

function useDevKey(pk) {
  const account = privateKeyToAccount(pk)
  wallet = createWalletClient({ account, chain, transport: http(rpc) })
  address = account.address
  return onSigner()
}
const gasReserve = () => (sac ? 0 : GAS_RESERVE_EOA)
/** Sends one user operation and waits for it. A user operation whose inner call reverts still lands on chain, so check `success`. */
async function sendOp(calls) {
  const hash = await sac.sendUserOperation({ calls })
  const r = await sac.waitForUserOperationReceipt({ hash, timeout: 120000 })
  if (!r.success) throw new Error('TX_FAILED')
  return { ...r.receipt, logs: r.logs, transactionHash: r.receipt.transactionHash }
}
/** Called whenever the wallet (signer) changes. With sponsored gas, wraps it into a smart account. */
async function onSigner() {
  sac = null; signerAddress = address
  if (BUNDLER && wallet && address) {
    try {
      const [{ createSmartAccountClient }, { toSimpleSmartAccount }, aa] = await Promise.all([import('permissionless'), import('permissionless/accounts'), import('viem/account-abstraction')])
      const owner = wallet.account && wallet.account.type === 'local' ? wallet.account : wallet
      const account = await toSimpleSmartAccount({ client: pub, owner, entryPoint: { address: AA.entryPoint || aa.entryPoint07Address, version: '0.7' }, ...(AA.factory ? { factoryAddress: AA.factory } : {}) })
      const paymaster = aa.createPaymasterClient({ transport: http(PAYMASTER) })
      const isPimlico = /pimlico\.io/.test(BUNDLER)
      sac = createSmartAccountClient({ account, chain, bundlerTransport: http(BUNDLER), client: pub, paymaster,
        userOperation: { estimateFeesPerGas: async () => {
          if (isPimlico) { const { createPimlicoClient } = await import('permissionless/clients/pimlico'); return (await createPimlicoClient({ transport: http(BUNDLER) }).getUserOperationGasPrice()).fast }
          const f = await pub.estimateFeesPerGas(); return { maxFeePerGas: f.maxFeePerGas * 2n, maxPriorityFeePerGas: f.maxPriorityFeePerGas * 2n } } } })
      address = getAddress(account.address)
    } catch (e) { console.warn('sponsored gas unavailable, using the wallet directly', e && (e.shortMessage || e.message)); sac = null }
  }
  emit()
  return address
}

async function waitTx(hash) {
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error('TX_FAILED')
  return r
}
const write = async (req) => {
  if (sac) {
    // simulate from the smart account first: a revert (e.g. StillLocked) surfaces with its reason and costs no sponsored gas
    await pub.simulateContract({ ...req, account: sac.account.address })
    return sendOp([{ to: req.address, abi: req.abi, functionName: req.functionName, args: req.args, value: req.value }])
  }
  await ensureChain(); return waitTx(await wallet.writeContract({ account: wallet.account, chain, ...req }))
}
const wrapped = (sym) => !!D.tokens[sym].wrapped
/** For WETH-backed ETH: wrap just the missing part from native ETH, keeping a little for gas. */
async function ensureWrapped(sym, amt) {
  if (!wrapped(sym)) return null
  const token = D.tokens[sym].address
  const have = await pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [address] })
  if (have >= amt) return null
  const need = amt - have
  const native = await pub.getBalance({ address })
  if (native - parseUnits(String(gasReserve()), 18) < need) throw new Error('INSUFFICIENT_ETH')
  return (await write({ address: token, abi: WETH, functionName: 'deposit', value: need })).transactionHash
}
const dec = (sym) => D.tokens[sym].decimals
const toUnits = (sym, n) => parseUnits(String(+(+n).toFixed(dec(sym))), dec(sym))
const fromUnits = (sym, v) => Number(formatUnits(v, dec(sym)))

const COMET = parseAbi(['function getUtilization() view returns (uint64)', 'function getSupplyRate(uint64) view returns (uint64)'])
const PROTO = parseAbi(['function protocol() view returns (uint8)'])
const protoName = (p) => (Number(p) === 1 ? 'compound' : 'aave')
/** Current supply APR (0.042 = 4.2%) for each protocol available for `sym`. */
async function ratesOf(sym) {
  const t = D.tokens[sym], out = {}
  const prot = t.protocols || [0]
  if (D.pool && prot.includes(0)) {
    out.aave = await pub.readContract({ address: D.pool, abi: POOL, functionName: 'getReserveData', args: [t.address] }).then((r) => Number(r.currentLiquidityRate) / 1e27).catch(() => 0)
  }
  if (t.comet && prot.includes(1)) {
    out.compound = await pub.readContract({ address: t.comet, abi: COMET, functionName: 'getUtilization' })
      .then((u) => pub.readContract({ address: t.comet, abi: COMET, functionName: 'getSupplyRate', args: [u] }))
      .then((r) => (Number(r) / 1e18) * 31536000).catch(() => 0)
  }
  return out
}
const bestOf = (r) => { const e = Object.entries(r).sort((a, b) => b[1] - a[1])[0]; return e ? { protocol: e[0], apr: e[1] } : { protocol: 'aave', apr: 0 } }
let lastBest = {}
async function bestProtocol(sym) {
  try { const b = bestOf(await ratesOf(sym)); lastBest[sym] = b; return b.protocol === 'compound' ? 1 : 0 } catch (e) { return lastBest[sym]?.protocol === 'compound' ? 1 : 0 }
}

async function readVault(addr) {
  const c = { address: addr, abi: VAULT }
  const [asset, owner, unlock, created, principal, bal, earned, withdrawn, wTotal, proto] = await Promise.all(
    ['asset', 'owner', 'unlockTime', 'createdAt', 'principal', 'balance', 'earned', 'withdrawn', 'withdrawnTotal'].map((f) => pub.readContract({ ...c, functionName: f }))
      .concat(pub.readContract({ address: addr, abi: PROTO, functionName: 'protocol' }).catch(() => 0)))
  const sym = symOf[asset.toLowerCase()] || '?'
  return { addr, sym, owner, to: Number(unlock) * 1000, from: Number(created) * 1000, q: fromUnits(sym, principal), val: fromUnits(sym, bal),
    earned: fromUnits(sym, earned), withdrawn, withdrawnTotal: fromUnits(sym, wTotal), proto: protoName(proto) }
}

async function readAllowance(addr, names) {
  const f = ['asset', 'deposited', 'withdrawnTotal', 'rate', 'period', 'start', 'createdAt', 'lastRateChange', 'checkpointPeriods', 'accruedAtCheckpoint', 'earned', 'closed']
  const r = await Promise.all(f.map((fn) => pub.readContract({ address: addr, abi: ALLOW, functionName: fn })))
  const sym = symOf[r[0].toLowerCase()] || '?', u = (v) => fromUnits(sym, v)
  const proto = protoName(await pub.readContract({ address: addr, abi: PROTO, functionName: 'protocol' }).catch(() => 0))
  return { addr, sym, total: u(r[1]), wd: u(r[2]), rate: u(r[3]), per: Number(r[4]) === 604800 ? 'w' : 'd', start: Number(r[5]) * 1000, from: Number(r[6]) * 1000,
    lastRate: Number(r[7]) * 1000, chk: { n: Number(r[8]), acc: u(r[9]) }, earned: u(r[10]), closed: r[11], goal: names[addr.toLowerCase()] || '', proto }
}
// ---------- event scanning ----------
// Public RPCs limit eth_getLogs ranges, and a factory gets older every day. Logs are therefore read in adaptive chunks,
// and what was read is cached on the device with a cursor, so each sync only reads the new blocks.
const LS = { get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null') } catch (e) { return null } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch (e) {} } }
const REORG_MARGIN = 30n
const ser = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)))
const MIN_CHUNK = 10n, MAX_REQ = 150
let _lc = null // no automatic retries: a refused range is answered by a smaller range, not by waiting
const logClient = () => (_lc ||= createPublicClient({ chain, transport: http(rpc, { retryCount: 0 }) }))
// the largest range this node accepted / the smallest it refused, remembered per network on the device
const CKEY = () => `ms-logchunk:${D ? D.network : "none"}`
let ceil = BigInt(LS.get(CKEY()) || globalThis.MS_LOG_CHUNK || 2000000)
let chunk = ceil
/** Reads logs from `from` to `to` in chunks that shrink when the node refuses a range and grow again after successes.
 *  Calls onChunk(logs, toBlock) after each chunk so progress is saved; stops after MAX_REQ requests (continues next sync). */
async function getLogsChunked(params, from, to, onChunk) {
  let a = from, req = 0
  while (a <= to && req < MAX_REQ) {
    const b = a + chunk - 1n > to ? to : a + chunk - 1n
    req++
    try { const logs = await logClient().getLogs({ ...params, fromBlock: a, toBlock: b }); await onChunk(logs, b); a = b + 1n; chunk = chunk * 2n > ceil ? ceil : chunk * 2n }
    catch (e) {
      if (chunk <= MIN_CHUNK) throw e
      ceil = chunk - 1n; LS.set(CKEY(), String(ceil))
      chunk = chunk / 4n > MIN_CHUNK ? chunk / 4n : MIN_CHUNK
    }
  }
  return a > to
}
/** Incremental scan of one factory event with fixed filter args. Returns serialized args of every matching log seen so far. */
async function scan(name, event, args) {
  const key = `ms-logs:${D.network}:${D.factory}:${name}`
  const c = LS.get(key) || { to: String(BigInt(D.block || 0) - 1n), items: [] }
  try {
    const head = await pub.getBlockNumber({ cacheTime: 2000 })
    const start = BigInt(D.block || 0)
    let from = BigInt(c.to) + 1n - (c.done ? REORG_MARGIN : 0n)
    if (from < start) from = start
    const seen = new Set(c.items.map((i) => i.id))
    c.done = await getLogsChunked({ address: D.factory, event, args }, from, head, (logs, upTo) => {
      for (const l of logs) { const id = l.transactionHash + ':' + l.logIndex; if (!seen.has(id)) { seen.add(id); c.items.push({ id, block: String(l.blockNumber), args: ser(l.args) }) } }
      c.to = String(upTo); LS.set(key, c)
    })
  } catch (e) { /* keep what we have; the next sync continues */ }
  return c.items.map((i) => i.args)
}
/** Names (goals) from the backend, when MS_API is configured: one request instead of log scans. */
async function apiUser(who) {
  const api = (globalThis.MS_API || '').replace(/\/$/, '')
  if (!api) return null
  try { const r = await fetch(`${api}/v1/${D.network}/users/${who}`, { signal: AbortSignal.timeout(6000) }); return r.ok ? await r.json() : null } catch (e) { return null }
}
async function allowanceNames(owner, need = []) {
  if (!D.factory) return {}
  const u = await apiUser(owner)
  if (u && u.budgets) {
    const m = Object.fromEntries(u.budgets.map((b) => [b.address.toLowerCase(), b.goal]))
    if (need.every((a) => m[a.toLowerCase()] !== undefined)) return m
  }
  try { return Object.fromEntries((await scan('allow:' + owner.toLowerCase(), ALLOW_EV, { owner })).map((a) => [a.allowance.toLowerCase(), a.goal])) } catch (e) { return {} }
}
async function goals({ owner, need = [] }) {
  const u = await apiUser(owner)
  if (u && u.vaults) {
    const m = Object.fromEntries(u.vaults.map((v) => [v.address.toLowerCase(), v.goal]))
    if (need.every((a) => m[a.toLowerCase()] !== undefined)) return m // the backend may lag behind a brand-new vault
  }
  return Object.fromEntries((await scan('created:' + owner.toLowerCase(), FACTORY[3], { owner })).map((a) => [a.vault.toLowerCase(), a.goal]))
}
/** Goals of vaults I gifted (owned by other people): cached per vault, scanned only for vaults not seen before. */
async function giftGoalsOf(addrs) {
  const key = `ms-giftgoals:${D.network}:${D.factory}`
  const m = LS.get(key) || {}
  const missing = addrs.filter((a) => m[a.toLowerCase()] === undefined)
  if (missing.length) {
    try {
      const done = await getLogsChunked({ address: D.factory, event: FACTORY[3], args: { vault: missing } }, BigInt(D.block || 0), await pub.getBlockNumber(), (logs) => {
        for (const l of logs) m[l.args.vault.toLowerCase()] = l.args.goal
      })
      if (done) for (const a of missing) if (m[a.toLowerCase()] === undefined) m[a.toLowerCase()] = ''
    } catch (e) {}
    LS.set(key, m)
  }
  return m
}

const MSChain = {
  get ready() { return !!D },
  get address() { return address },
  get connected() { return !!(wallet && address) },
  available: AVAILABLE,
  get hasInjected() { return !!eth() },
  get hasWalletConnect() { return !!(globalThis.MS_REOWN_PROJECT_ID || import.meta.env.VITE_REOWN_PROJECT_ID || '').trim() },
  info() { return D ? { network: D.network, chainId: D.chainId, chainName: chain.name, testnet: !!D.testnet, factory: D.factory, explorer: EXPLORER[D.chainId] || '', gasFaucet: GAS_FAUCET[D.chainId] || '', tokens: Object.keys(D.tokens),
    caps: Object.fromEntries(Object.entries(D.tokens).filter(([, t]) => t.cap).map(([s, t]) => [s, Number(t.cap)])), gasReserve: D.testnet ? 0 : gasReserve(), gasless: !!sac } : null },
  onChange(f) { listeners.add(f); return () => listeners.delete(f) },

  /** Wallets detected on this device (extensions / in-wallet browsers). */
  wallets() { globalThis.dispatchEvent?.(new Event('eip6963:requestProvider')); return walletList().map(({ provider, ...w }) => w) },
  get connectedWallet() { return address ? connectedVia : null },
  /** Connect a specific wallet: an id from wallets(), or 'walletconnect' for the WalletConnect / Reown list. */
  async connectWith(id) {
    if (id === 'walletconnect') {
      const kit = await initAppKit(); if (address && connectedVia && connectedVia.kind === 'walletconnect') return address
      await kit.open()
      return new Promise((res, rej) => {
        const off = MSChain.onChange((a) => { if (a) { off(); res(a) } })
        const t = setInterval(() => { if (!kit.isOpen?.() && !address) { clearInterval(t); off(); rej(new Error('CANCELLED')) } }, 800)
      })
    }
    const p = providerFor(id); if (!p) throw new Error('NO_WALLET')
    const w = walletList().find((x) => x.provider === p)
    chosenId = (w && (w.rdns || w.id)) || id; try { localStorage.setItem('ms-wallet', chosenId) } catch (e) {}
    const a = await connectInjected(false, p); if (!a) throw new Error('CANCELLED'); return a
  },
  /** Ask the connected browser wallet to switch to (or add) this app's network. */
  async addNetwork() { const p = injected || eth(); if (!p) throw new Error('NO_WALLET'); await switchChain(p); return true },
  async connect() {
    const dev = globalThis.MS_DEV_KEY
    if (dev) { connectedVia = { kind: 'dev', name: 'Тестовый ключ', icon: '' }; return useDevKey(dev) }
    if (eth()) { const a = await connectInjected(false); if (a) return a; throw new Error('CANCELLED') }
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
    if (globalThis.MS_DEV_KEY) return useDevKey(globalThis.MS_DEV_KEY)
    if (eth()) { try { return await connectInjected(true) } catch (e) { return null } }
    try { await initAppKit() } catch (e) { return null }
    if (address) return address
    return new Promise((res) => { const off = MSChain.onChange((a) => { if (a) { off(); res(a) } }); setTimeout(() => { off(); res(address) }, ms) })
  },
  async disconnect() { try { if (appkit) await appkit.disconnect() } catch (e) {} try { if (injected && injected.request) await injected.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }) } catch (e) {} connectedVia = null; injected = null; wallet = null; address = null; sac = null; emit() },
  /** true when MoneySafe pays the gas (smart account + paymaster) */
  get gasless() { return !!sac },
  get gaslessConfigured() { return !!BUNDLER },
  get signer() { return signerAddress },

  /** Full picture for the app: balances, my vaults, gifts I sent, gas, rates. */
  async state(who) {
    const me = getAddress(who || address)
    const syms = Object.keys(D.tokens)
    const [bals, gas, myVaults, giftLogs, rates] = await Promise.all([
      Promise.all(syms.map((s) => pub.readContract({ address: D.tokens[s].address, abi: ERC20, functionName: 'balanceOf', args: [me] }))),
      pub.getBalance({ address: me }),
      pub.readContract({ address: D.factory, abi: FACTORY, functionName: 'vaultsOf', args: [me] }),
      scan('gifted:' + me.toLowerCase(), FACTORY[4], { from: me }),
      Promise.all(syms.map((s) => ratesOf(s).catch(() => ({})))),
    ])
    const native = Number(formatUnits(gas, 18))
    const wallet = Object.fromEntries(syms.map((s, i) => [s, fromUnits(s, bals[i]) + (D.tokens[s].wrapped ? Math.max(0, native - gasReserve()) : 0)]))
    const myGoals = await goals({ owner: me, need: myVaults })
    const vaults = await Promise.all(myVaults.map(async (a) => ({ ...(await readVault(a)), goal: myGoals[a.toLowerCase()] || '' })))
    const giftAddrs = giftLogs.map((a) => getAddress(a.vault))
    const giftGoals = giftAddrs.length ? await giftGoalsOf(giftAddrs) : {}
    const gifts = await Promise.all(giftAddrs.map(async (a) => ({ ...(await readVault(a)), goal: giftGoals[a.toLowerCase()] || '' })))
    const best = Object.fromEntries(syms.map((s, i) => [s, bestOf(rates[i])]))
    lastBest = best
    const apr = Object.fromEntries(syms.map((s) => [s, best[s].apr]))
    const proto = Object.fromEntries(syms.map((s) => [s, best[s].protocol]))
    const allRates = Object.fromEntries(syms.map((s, i) => [s, rates[i]]))
    let budgets = []
    try {
      const list = await pub.readContract({ address: D.factory, abi: FACTORY, functionName: 'allowancesOf', args: [me] })
      if (list.length) { const names = await allowanceNames(me, list); budgets = await Promise.all(list.map((a) => readAllowance(a, names))) }
    } catch (e) { /* older factory without budgets */ }
    let chainNow = Date.now()
    try { chainNow = Number((await pub.getBlock({ blockTag: 'latest' })).timestamp) * 1000 } catch (e) {}
    return { address: me, wallet, gas: Number(formatUnits(gas, 18)), vaults, gifts, budgets, apr, proto, rates: allRates, at: Date.now(), chainNow }
  },

  /** Sponsored-gas mode: what is still in the connected wallet itself, and whether it can be moved without gas (EIP-2612 permit). */
  async walletAssets() {
    if (!sac || !signerAddress) return null
    const out = {}
    await Promise.all(Object.entries(D.tokens).map(async ([sym, t]) => {
      const bal = await pub.readContract({ address: t.address, abi: ERC20, functionName: 'balanceOf', args: [signerAddress] }).catch(() => 0n)
      if (bal > 0n) out[sym] = { amount: fromUnits(sym, bal), permit: !!(await permitDomain(t.address).catch(() => null)) }
    }))
    out.ETH_NATIVE = Number(formatUnits(await pub.getBalance({ address: signerAddress }), 18))
    return out
  },
  /** Moves `amount` of `sym` from the wallet into the MoneySafe account: the wallet signs a permit (free), MoneySafe pays the gas. */
  async moveFromWallet(sym, amount, all) {
    if (!sac) throw new Error('NOT_GASLESS')
    const token = D.tokens[sym].address
    const value = all ? await pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [signerAddress] }) : toUnits(sym, amount)
    const domain = await permitDomain(token)
    const nonce = await pub.readContract({ address: token, abi: PERMIT, functionName: 'nonces', args: [signerAddress] })
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const message = { owner: signerAddress, spender: address, value, nonce, deadline }
    const sig = await wallet.signTypedData({ account: wallet.account, domain, primaryType: 'Permit', message,
      types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] } })
    const { r, s, v, yParity } = parseSignature(sig)
    const vv = v !== undefined ? Number(v) : 27 + yParity
    const rc = await sendOp([
      { to: token, abi: PERMIT, functionName: 'permit', args: [signerAddress, address, value, deadline, vv, r, s] },
      { to: token, abi: PERMIT, functionName: 'transferFrom', args: [signerAddress, address, value] },
    ])
    return rc.transactionHash
  },
  async faucetStatus(sym, who) {
    const last = Number(await pub.readContract({ address: D.tokens[sym].address, abi: ERC20, functionName: 'lastFaucet', args: [getAddress(who || address)] }))
    return { nextAt: last ? (last + 86400) * 1000 : 0, amount: D.tokens[sym].faucet }
  },
  async faucet(sym) { const r = await write({ address: D.tokens[sym].address, abi: ERC20, functionName: 'faucet' }); return r.transactionHash },

  /** onStep(i, hash): 0 = approved, 1 = vault created, 2 = confirmed. */
  async createVault({ sym, amount, unlockMs, goal, recipient }, onStep = () => {}) {
    const token = D.tokens[sym].address, amt = toUnits(sym, amount)
    await ensureWrapped(sym, amt)
    const allowance = await pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [address, D.factory] })
    if (allowance < amt) { const r = await write({ address: token, abi: ERC20, functionName: 'approve', args: [D.factory, amt] }); onStep(0, r.transactionHash) } else onStep(0, null)
    const r = await write({ address: D.factory, abi: FACTORY, functionName: 'createVaultWith',
      args: [await bestProtocol(sym), recipient ? getAddress(recipient) : address, token, amt, BigInt(Math.floor(unlockMs / 1000)), String(goal || '').slice(0, 30)] })
    onStep(1, r.transactionHash)
    const ev = parseEventLogs({ abi: FACTORY, logs: r.logs, eventName: 'VaultCreated' })[0]
    const vault = ev ? getAddress(ev.args.vault) : null
    onStep(2, r.transactionHash)
    return { hash: r.transactionHash, vault }
  },
  async topUp(vault, sym, amount) {
    const token = D.tokens[sym].address, amt = toUnits(sym, amount)
    await ensureWrapped(sym, amt)
    const allowance = await pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [address, D.factory] })
    if (allowance < amt) await write({ address: token, abi: ERC20, functionName: 'approve', args: [D.factory, amt] })
    return (await write({ address: D.factory, abi: FACTORY, functionName: 'topUp', args: [vault, amt] })).transactionHash
  },
  /** Withdraws to the owner. For WETH-backed ETH, then offers to unwrap what arrived back into native ETH (optional 2nd signature). */
  /** Money for every day. period: 'd' | 'w'. onStep(i): 0 approved, 1 created. */
  async createBudget({ sym, total, rate, per, goal }, onStep = () => {}) {
    const token = D.tokens[sym].address, amt = toUnits(sym, total), r = toUnits(sym, rate)
    await ensureWrapped(sym, amt)
    const allowance = await pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [address, D.factory] })
    if (allowance < amt) await write({ address: token, abi: ERC20, functionName: 'approve', args: [D.factory, amt] })
    onStep(0)
    const rc = await write({ address: D.factory, abi: FACTORY, functionName: 'createAllowance', args: [await bestProtocol(sym), token, amt, r, per === 'w' ? 604800n : 86400n, 0n, String(goal || '').slice(0, 30)] })
    const ev = parseEventLogs({ abi: FACTORY, logs: rc.logs, eventName: 'AllowanceCreated' })[0]
    onStep(1)
    return { hash: rc.transactionHash, budget: ev ? getAddress(ev.args.allowance) : null }
  },
  async budgetTake(addr, sym, amount, all) {
    const amt = all ? 2n ** 256n - 1n : toUnits(sym, amount), token = D.tokens[sym].address
    const before = wrapped(sym) ? await pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [address] }) : 0n
    const h = (await write({ address: addr, abi: ALLOW, functionName: 'withdraw', args: [amt] })).transactionHash
    if (wrapped(sym)) {
      const got = (await pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [address] })) - before
      if (got > 0n) { try { await write({ address: token, abi: WETH, functionName: 'withdraw', args: [got] }) } catch (e) {} }
    }
    return h
  },
  async budgetRate(addr, sym, rate) { return (await write({ address: addr, abi: ALLOW, functionName: 'setRate', args: [toUnits(sym, rate)] })).transactionHash },
  async budgetTopUp(addr, sym, amount) {
    const token = D.tokens[sym].address, amt = toUnits(sym, amount)
    await ensureWrapped(sym, amt)
    const allowance = await pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [address, D.factory] })
    if (allowance < amt) await write({ address: token, abi: ERC20, functionName: 'approve', args: [D.factory, amt] })
    return (await write({ address: D.factory, abi: FACTORY, functionName: 'topUpAllowance', args: [addr, amt] })).transactionHash
  },
  async withdraw(vault) {
    const sym = symOf[(await pub.readContract({ address: vault, abi: VAULT, functionName: 'asset' })).toLowerCase()]
    const token = sym && D.tokens[sym].address
    const before = wrapped(sym) ? await pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [address] }) : 0n
    const h = (await write({ address: vault, abi: VAULT, functionName: 'withdraw' })).transactionHash
    if (wrapped(sym)) {
      const got = (await pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [address] })) - before
      if (got > 0n) { try { await write({ address: token, abi: WETH, functionName: 'withdraw', args: [got] }) } catch (e) { /* stays as WETH, still shown as ETH */ } }
    }
    return h
  },
  async send(sym, to, amount) {
    const amt = toUnits(sym, amount)
    if (wrapped(sym)) {
      const native = await pub.getBalance({ address })
      if (native - parseUnits(String(gasReserve()), 18) >= amt) { if (sac) return (await sendOp([{ to: getAddress(to), value: amt }])).transactionHash; await ensureChain(); return (await waitTx(await wallet.sendTransaction({ account: wallet.account, chain, to: getAddress(to), value: amt }))).transactionHash }
      const w = await pub.readContract({ address: D.tokens[sym].address, abi: ERC20, functionName: 'balanceOf', args: [address] })
      if (w < amt) await ensureWrapped(sym, amt)
    }
    return (await write({ address: D.tokens[sym].address, abi: ERC20, functionName: 'transfer', args: [getAddress(to), amt] })).transactionHash
  },
  txUrl(hash) { return EXPLORER[D?.chainId] ? EXPLORER[D.chainId] + '/tx/' + hash : '' },
  addrUrl(a) { return EXPLORER[D?.chainId] ? EXPLORER[D.chainId] + '/address/' + a : '' },
}

if (!globalThis.MS_API && import.meta.env.VITE_MS_API) globalThis.MS_API = import.meta.env.VITE_MS_API
globalThis.MSChain = MSChain
globalThis.dispatchEvent?.(new Event('mschain-ready'))
export default MSChain

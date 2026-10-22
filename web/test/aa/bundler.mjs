// Minimal local ERC-4337 bundler + ERC-7677 paymaster service for tests (stands in for Pimlico).
// Methods: eth_chainId, eth_supportedEntryPoints, eth_estimateUserOperationGas, eth_sendUserOperation,
// eth_getUserOperationReceipt, eth_getUserOperationByHash, pm_getPaymasterStubData, pm_getPaymasterData, pimlico_getUserOperationGasPrice.
import http from 'node:http'
import fs from 'node:fs'
import { createPublicClient, createWalletClient, http as vhttp, parseAbi, encodeAbiParameters, concat, pad, toHex, decodeEventLog } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hardhat } from 'viem/chains'
import { toPackedUserOperation, entryPoint07Abi } from 'viem/account-abstraction'

const C = JSON.parse(fs.readFileSync(new URL('./aa-local.json', import.meta.url)))
const pub = createPublicClient({ chain: hardhat, transport: vhttp('http://127.0.0.1:8545') })
const bundler = createWalletClient({ account: privateKeyToAccount('0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0'), chain: hardhat, transport: vhttp('http://127.0.0.1:8545') }) // hardhat #18
const pmSigner = privateKeyToAccount(C.paymasterSignerKey)
const PM = parseAbi(['function getHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp, uint48 validUntil, uint48 validAfter) view returns (bytes32)'])
const big = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) && /Gas|nonce|Fee|gas/.test(k) ? BigInt(v) : v]))
const ops = new Map()
const PMV = 120000n, PMP = 0n
const VALID = () => [Math.floor(Date.now() / 1000) + 3600 * 24 * 365, 0]
const stubData = () => concat([encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [0, 0]), pad('0x', { size: 65 })])
let sponsored = 0

const methods = {
  eth_chainId: () => toHex(31337),
  eth_supportedEntryPoints: () => [C.entryPoint],
  pimlico_getUserOperationGasPrice: async () => { const f = await pub.estimateFeesPerGas(); const x = { maxFeePerGas: toHex(f.maxFeePerGas * 2n), maxPriorityFeePerGas: toHex(f.maxPriorityFeePerGas * 2n) }; return { slow: x, standard: x, fast: x } },
  eth_estimateUserOperationGas: () => ({ preVerificationGas: toHex(120000), verificationGasLimit: toHex(1500000), callGasLimit: toHex(2500000), paymasterVerificationGasLimit: toHex(PMV), paymasterPostOpGasLimit: toHex(PMP) }),
  pm_getPaymasterStubData: () => ({ paymaster: C.paymaster, paymasterData: stubData(), paymasterVerificationGasLimit: toHex(PMV), paymasterPostOpGasLimit: toHex(PMP), isFinal: false }),
  pm_getPaymasterData: async ([op]) => {
    const u = big(op)
    const [until, after] = VALID()
    const packed = toPackedUserOperation({ ...u, paymaster: C.paymaster, paymasterVerificationGasLimit: PMV, paymasterPostOpGasLimit: PMP, paymasterData: stubData(), signature: '0x' })
    const hash = await pub.readContract({ address: C.paymaster, abi: PM, functionName: 'getHash', args: [packed, until, after] })
    const sig = await pmSigner.signMessage({ message: { raw: hash } })
    sponsored++
    return { paymaster: C.paymaster, paymasterData: concat([encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [until, after]), sig]), paymasterVerificationGasLimit: toHex(PMV), paymasterPostOpGasLimit: toHex(PMP) }
  },
  eth_sendUserOperation: async ([op]) => {
    const u = big(op), packed = toPackedUserOperation(u)
    const hash = await pub.readContract({ address: C.entryPoint, abi: entryPoint07Abi, functionName: 'getUserOpHash', args: [packed] })
    const tx = await bundler.writeContract({ address: C.entryPoint, abi: entryPoint07Abi, functionName: 'handleOps', args: [[packed], bundler.account.address], gas: 8000000n })
    ops.set(hash, { tx, op })
    return hash
  },
  eth_getUserOperationReceipt: async ([hash]) => {
    const o = ops.get(hash); if (!o) return null
    const r = await pub.getTransactionReceipt({ hash: o.tx }).catch(() => null); if (!r) return null
    let ev = null
    for (const l of r.logs) { if (l.address.toLowerCase() !== C.entryPoint.toLowerCase()) continue; try { const d = decodeEventLog({ abi: entryPoint07Abi, data: l.data, topics: l.topics }); if (d.eventName === 'UserOperationEvent' && d.args.userOpHash === hash) ev = d.args } catch (e) {} }
    const J = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? toHex(v) : v)))
    return J({ userOpHash: hash, entryPoint: C.entryPoint, sender: o.op.sender, nonce: o.op.nonce, paymaster: ev?.paymaster, actualGasCost: ev?.actualGasCost ?? 0n, actualGasUsed: ev?.actualGasUsed ?? 0n,
      success: ev ? ev.success : r.status === 'success', reason: '', logs: r.logs,
      receipt: { ...r, status: r.status === 'success' ? '0x1' : '0x0', type: '0x2' } })
  },
  eth_getUserOperationByHash: async ([hash]) => { const o = ops.get(hash); return o ? { userOperation: o.op, entryPoint: C.entryPoint, transactionHash: o.tx, blockHash: null, blockNumber: null } : null },
  debug_sponsored: () => sponsored,
}

http.createServer(async (req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'content-type': 'application/json' }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  let raw = ''; for await (const c of req) raw += c
  const body = JSON.parse(raw || '{}'), one = async (m) => {
    try { const f = methods[m.method]; if (!f) throw Object.assign(new Error('method not supported: ' + m.method), { code: -32601 }); return { jsonrpc: '2.0', id: m.id, result: await f(m.params || []) } }
    catch (e) { console.error(m.method, e.shortMessage || e.message); return { jsonrpc: '2.0', id: m.id, error: { code: e.code || -32000, message: String(e.shortMessage || e.message).slice(0, 500) } } }
  }
  const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body)
  res.writeHead(200, cors); res.end(JSON.stringify(out))
}).listen(4337, () => console.log('local bundler+paymaster on :4337', C))

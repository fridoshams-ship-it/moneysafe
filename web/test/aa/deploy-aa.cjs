// Deploys ERC-4337 v0.7 EntryPoint, SimpleAccountFactory and a VerifyingPaymaster on the local node.
const { ethers } = require('ethers'); const fs = require('fs')
const A = (n) => require('@account-abstraction/contracts/artifacts/' + n + '.json')
;(async () => {
  const p = new ethers.JsonRpcProvider('http://127.0.0.1:8545')
  const w = new ethers.Wallet('0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e', p) // hardhat #19
  const dep = async (n, ...args) => { const a = A(n); const f = new ethers.ContractFactory(a.abi, a.bytecode, w); const c = await f.deploy(...args); await c.waitForDeployment(); return c }
  const ep = await dep('EntryPoint')
  const fac = await dep('SimpleAccountFactory', await ep.getAddress())
  const signer = ethers.Wallet.createRandom()
  const pm = await dep('VerifyingPaymaster', await ep.getAddress(), signer.address)
  await (await ep.depositTo(await pm.getAddress(), { value: ethers.parseEther('10') })).wait()
  const out = { entryPoint: await ep.getAddress(), factory: await fac.getAddress(), paymaster: await pm.getAddress(), paymasterSignerKey: signer.privateKey }
  fs.writeFileSync(__dirname + '/aa-local.json', JSON.stringify(out, null, 2)); console.log(JSON.stringify(out))
})().catch((e) => { console.error(e); process.exit(1) })

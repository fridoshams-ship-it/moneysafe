// Builds index.html from app.html (the single-file app) and bundles testnet deployments for the chain layer.
import fs from 'node:fs'
import path from 'node:path'
const here = path.dirname(new URL(import.meta.url).pathname)
const app = fs.readFileSync(path.join(here, 'app.html'), 'utf8')
const i = app.indexOf('</style>') + 8
const head = '<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<link rel="manifest" href="manifest.webmanifest">\n<link rel="icon" type="image/png" href="icon-192.png">\n'
fs.writeFileSync(path.join(here, 'index.html'), head + app.slice(0, i) + '\n</head>\n<body>\n' + app.slice(i) + '\n<script type="module" src="./src/chain.js"></script>\n</body>\n</html>\n')
const nets = (process.env.MS_NETWORKS || 'arbitrum,base,arbitrumSepolia,baseSepolia,polygonAmoy').split(',')
const deps = {}
for (const n of nets) {
  const f = path.join(here, '..', 'contracts', 'deployments', n + '.json')
  if (fs.existsSync(f)) deps[n] = JSON.parse(fs.readFileSync(f, 'utf8'))
}
fs.writeFileSync(path.join(here, 'src', 'deployments.json'), JSON.stringify(deps, null, 1))
console.log('index.html built; networks:', Object.keys(deps).join(', ') || 'none (demo only)')

# MetaMask warning "Этот веб-сайт может быть вредоносным" — false positive report

Our domain is NOT on MetaMask's public blocklist (checked 22.10.2026 against
github.com/MetaMask/eth-phishing-detect src/config.json: 108 014 blocked hosts, no match).
The warning comes from MetaMask's automatic detection, which often flags new *.github.io
sites that connect a wallet. Two fixes:

1. Report it — on the warning screen tap **«Сообщить о проблеме обнаружения»** and paste the text below.
2. Long-term — move the app to our own domain (e.g. moneysafe.uz) before public launch; new
   github.io subdomains are flagged far more often than established own domains.

## Text to paste (English)

Domain: fridoshams-ship-it.github.io (path /moneysafe/)

This is a false positive. MoneySafe is an open-source savings app: users lock their own
stablecoins in personal time-lock vault contracts until a chosen date (yield via Aave V3 /
Compound III). The site does not impersonate any brand, never asks for a seed phrase or
private key, and only requests standard wallet connections and transactions the user confirms.
It currently runs on Base Sepolia testnet only.

- Source code: https://github.com/fridoshams-ship-it/moneysafe
- Contracts (Base Sepolia, factory): 0xCA0bDE1117FA6eF9267604a901A780622Ba6d25B
- Privacy policy: https://fridoshams-ship-it.github.io/moneysafe/privacy.html

Please remove the warning for this domain. Thank you.

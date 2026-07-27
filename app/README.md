# Grood — frontend

Next.js app for Grood, the drand-powered 5×5 grid game on **Robinhood Chain** (4663).

- `/` — landing page
- `/play` — the game (`src/components/TheGrid.js`): viem reads against Robinhood Chain, Privy wallets, SSE live feed from the keeper, Supabase round history
- `/how-to-play` — rules

Setup: copy `.env.example` → `.env.local` and fill in the Privy app id and the deployed contract addresses from `contracts/deployments/grood-robinhood.json`. Entry token is USDG (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals). Randomness links in the history table point at the drand evmnet API.

```bash
npm install
npm run dev
```

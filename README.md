# PLAY X Raven

A companion program for a Ravencoin full node, aimed at small shops.
It turns a node you already run into a till: customers scan a QR with their
phone, pay in RVN, and the shop confirms the payment from its own chain data.

**Not affiliated with the Ravencoin project, its developers, or any foundation.**
This is an independent program built by one person. Nothing here is endorsed by
anyone but its author.

한국어 안내: <https://rvn.ex.erci.se>

---

## 🔴 Read this before you download anything

**This program does not bundle `ravend`, `raven-cli`, or `ipfs`.**
It looks for binaries you have already installed and starts them. If they are
not there, it says so and does nothing else. There is no hidden download.

Verified: the macOS bundle contains exactly one executable (`playx-raven`).
You can check the same thing on any build:

```sh
ls "PLAY X Raven.app/Contents/MacOS/"
```

So you need, separately:

| | why |
|---|---|
| **Ravencoin Core** (`ravend`) | everything. Without it the app has no chain. <https://ravencoin.org/wallet/> |
| **Kubo** (`ipfs`) — optional | menu photos and asset artwork only. Selling works without it. |

`-addressindex` must be on for the browser wallet to read balances.
`-assetindex` must be on for asset features.

## What it actually does

**Till.** Orders, menu, refunds (with a per-staff ceiling), stock, bookings,
membership passes, door check-in. Trade-specific menu templates. Customer
screens are Korean / English / Japanese / Chinese — *the UI strings are; text
the shop typed in is not translated.*

**Assets.** Issue, reissue, unique, qualifier, restricted, freeze. Artwork and
metadata go to your IPFS node. Rewards (`snapshot` → `distribute`) pay every
holder in one transaction.

**Your node.** A browser wallet that never sends a key anywhere, automatic
backups (locked with AES-256-GCM + Argon2id before anything reaches a cloud
folder), a sweep that moves takings above a threshold to a cold address, and an
append-only sales ledger with the KRW value at the time of sale.

**It does not mine.** It can compute whether mining would pay, hold your pool
settings, and start a miner *you* installed — but there is no miner in this
binary. See the comment at the top of `src-tauri/src/mining.rs`.

**It does not do your taxes.** The ledger records what was sold, for how much,
in both RVN and fiat, with the exchange rate and its source. It does not decide
what is taxable and it files nothing.

## The 1% development fee

1% of what a customer pays goes to the author. It comes **out of** the amount,
not on top of it — the customer pays the price on the screen and the shop
receives 99%.

It applies to: shop payments, the vending machine, and buying a second-hand
listing through the wallet.
It does not apply to: mining, plain sends, or issuing assets.

**You can turn it off** in settings, and you can change the address it goes to.
A fee you cannot turn off is not a fee, it is a tax — and in open source, a tax
disappears with one fork. The address is
[`RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB`](https://rvn.cryptoscope.io/address/?address=RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB);
check it on chain.

## Keys

The desktop app never holds your seed — Ravencoin Core does, in its own
`wallet.dat`. The browser wallet (`web/wallet.src.ts`) generates and stores a
seed in the browser's `localStorage`, and its page is served with
`connect-src 'self'` so that page has no way to reach the outside world. That
is also why publishing to Nostr relays and reading IPFS both go through the
node rather than the browser.

Cloud backups are encrypted before they leave the machine (`src-tauri/src/lockbox.rs`).
The key is random, stored `0600`, and shown on screen so it can be written on
paper — without that paper the cloud copy cannot be opened.

## Build

```sh
npm install
npm run tauri build          # or: npm run tauri dev
cargo test --manifest-path src-tauri/Cargo.toml
```

Rust stable + Node 20. macOS, Windows and Linux builds are produced by
`.github/workflows/release.yml`; the installers land in
[playx-raven-releases](https://github.com/PLAYX1/playx-raven-releases).

## Where things are

```
src-tauri/src/     Rust — node RPC, POS, assets, backup, AI, ledger
  shop.rs          orders, menu, opening hours, the 1% split
  server.rs        the phone-facing HTTP server (port 8790)
  lockbox.rs       cloud backup encryption
  ledger.rs        append-only sales record + CSV
web/               phone screens, no build step, no dependencies
  wallet.src.ts    browser wallet (bundled to wallet.bundle.js)
src/main.ts        desktop UI (vanilla TS)
```

Comments are in Korean, because the person maintaining this reads Korean. They
explain *why* rather than *what*, and several of them record bugs that already
happened — those are the useful ones.

## What this has not had

No security audit. No formal release process beyond signed builds. It has been
run by its author and by nobody else yet. Treat it accordingly: **start with an
amount you would not mind losing.**

Bug reports and patches are welcome. Please open an issue rather than a private
message, so the answer is visible to whoever hits the same thing next.

## License

MIT. See [LICENSE](LICENSE).

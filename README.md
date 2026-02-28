# neurai-lock

Gate access to your web app using the Neurai blockchain. Users authenticate by proving ownership of a Neurai address via a digital signature, and your backend verifies they meet on-chain requirements (XNA balance, specific assets, coin age).

Verification runs on the **Node.js backend**, so it cannot be tampered with from the browser.

## How it works

1. The user clicks a "Connect" button on your web page
2. The browser snippet asks the [Neurai Sign Chrome extension](https://github.com/neuraiproject/neurai-addon-sign) for the wallet address
3. The extension signs a one-time challenge nonce (user sees an approval popup)
4. Your backend verifies the signature and checks the address meets your requirements via RPC
5. Your backend returns OK or KO — you decide what to show next

## Install

```
npm install @neuraiproject/neurai-lock
```

## Quick start (Express.js)

### Backend

```js
const express = require('express');
const { NeuraiLock } = require('@neuraiproject/neurai-lock');

const app = express();
app.use(express.json());

const lock = new NeuraiLock({
  minXna: { amount: 1000, minAge: '1h' },  // must hold 1000 XNA for at least 1 hour
  assets: [{ name: 'MYTOKEN', minAmount: 1 }]
});

// Step 1: generate a one-time challenge for the address
app.post('/api/challenge', async (req, res) => {
  const challenge = await lock.createChallenge(req.body.address);
  res.json(challenge); // { nonce: '...' }
});

// Step 2: verify signature + on-chain requirements
app.post('/api/verify', async (req, res) => {
  const result = await lock.verifyChallenge(req.body);
  res.json(result);
  // { ok: true, address, balances } or { ok: false, reason, errorCode }
});

app.listen(3000);
```

### Frontend HTML

Serve `neurai-lock-client.js` from the package and include it in your page:

```html
<!-- Serve from your Express app or copy to your public folder -->
<script src="/neurai-lock-client.js"></script>
<script>
  document.getElementById('connectBtn').addEventListener('click', async () => {
    const result = await NeuraiLockClient.connect({
      challengeUrl: '/api/challenge',
      verifyUrl:    '/api/verify',
    });

    if (result.ok) {
      console.log('Address:', result.address);
      console.log('XNA balance:', result.balances.xna.total);
      console.log('Assets:', result.balances.assets);
      showProtectedContent();
    } else {
      console.log('Error:', result.reason);
    }
  });
</script>
```

To serve the browser snippet from Express:

```js
const path = require('path');
app.get('/neurai-lock-client.js', (_req, res) => {
  res.sendFile(require.resolve('@neuraiproject/neurai-lock/client/neurai-lock-client.js'));
});
```

## Configuration

```js
const lock = new NeuraiLock({
  // RPC endpoint. Defaults to Neurai mainnet.
  rpcUrl: NeuraiLock.URL_MAINNET,

  // Minimum XNA balance requirement
  minXna: {
    amount: 1000,   // XNA (human units, not satoshis)
    minAge: '1h'    // optional: only UTXOs older than this count. Formats: '30m', '1h', '2d'
  },

  // Required assets — ALL must be satisfied
  assets: [
    { name: 'MYTOKEN',  minAmount: 1 },
    { name: 'OTHERNFT', minAmount: 1 },
  ],

  // How long a nonce stays valid before expiring (default: 300000 = 5 minutes)
  nonceTtl: 300_000,

  // Advanced: provide your own nonce store (e.g. Redis) for multi-process deployments
  // nonceStore: myRedisStore,
});
```

### Built-in RPC URLs

```js
NeuraiLock.URL_MAINNET  // 'https://rpc-main.neurai.org/rpc'
NeuraiLock.URL_TESTNET  // 'https://rpc-testnet.neurai.org/rpc'
```

## API

### `new NeuraiLock(config)`

Creates a new NeuraiLock instance with the given configuration.

### `lock.createChallenge(address: string): Promise<{ nonce: string }>`

Generates a cryptographically random one-time nonce tied to the given address and stores it internally (with TTL). Call this from your challenge endpoint and return the nonce to the browser.

### `lock.verifyChallenge({ address, nonce, signature }): Promise<LockResult>`

Verifies that:
1. The nonce is valid and hasn't expired (consumed on first use — no replay)
2. The signature proves the user controls the address
3. The address meets all configured on-chain requirements

Returns a `LockResult`:

```ts
// Success
{
  ok: true,
  address: string,
  balances: {
    xna: {
      total: number,  // full confirmed XNA balance
      aged:  number   // XNA in UTXOs that meet minAge (equals total if no age req)
    },
    assets: Array<{ name: string, amount: number }>
  }
}

// Failure
{
  ok: false,
  address: string | null,
  reason:    string,     // human-readable explanation
  errorCode: string,     // see error codes below
  balances?: { ... }     // present if RPC succeeded before the check failed
}
```

### Error codes

| Code | Meaning |
|------|---------|
| `NONCE_INVALID` | Nonce does not exist or has expired — request a new challenge |
| `VERIFY_FAILED` | Signature does not match the address |
| `RPC_ERROR` | Could not reach the Neurai node |
| `INSUFFICIENT_XNA` | Address holds less XNA than required |
| `INSUFFICIENT_XNA_AGE` | Not enough XNA in UTXOs older than `minAge` |
| `INSUFFICIENT_ASSET` | A required asset is missing or below the minimum |
| `INVALID_CONFIG` | Configuration error (thrown at construction time) |

## Browser client API (`NeuraiLockClient`)

The `client/neurai-lock-client.js` file is a zero-dependency vanilla JS snippet for the browser.

### `NeuraiLockClient.connect(options): Promise<LockResult>`

Runs the full connect flow. Options:

| Option | Type | Description |
|--------|------|-------------|
| `challengeUrl` | `string` | Your `/api/challenge` endpoint |
| `verifyUrl` | `string` | Your `/api/verify` endpoint |
| `fetchOptions` | `object` | Extra options merged into every `fetch()` call (e.g. `credentials`, custom `headers`) |
| `walletTimeout` | `number` | Max ms to wait for the extension to inject (default: `3000`) |

Additional browser-side error codes: `NOT_INSTALLED`, `NO_WALLET`, `USER_REJECTED`, `CHALLENGE_ERROR`, `VERIFY_REQUEST_ERROR`.

### `NeuraiLockClient.isWalletInstalled(): boolean`

Synchronous check. Only reliable after `waitForWallet()` has resolved.

### `NeuraiLockClient.waitForWallet(timeoutMs?): Promise<boolean>`

Waits for the Neurai Sign extension to inject `window.neuraiWallet` into the page. Resolves `true` if the extension is found within the timeout, `false` otherwise. Useful for updating UI on page load without triggering the full connect flow.

## License

This project is licensed under the [Apache License 2.0](LICENSE).

```js
NeuraiLockClient.waitForWallet(3000).then(found => {
  if (!found) showInstallBanner();
});
```

## Custom nonce store

The default nonce store is in-memory. For multi-process or multi-server deployments (e.g. behind a load balancer), provide a Redis-backed store:

```js
const { NeuraiLock, createNonceStore } = require('@neuraiproject/neurai-lock');

// Example: Redis adapter
const myRedisStore = {
  save(nonce, address) {
    return redis.set(`nonce:${nonce}`, address, 'PX', 300_000);
  },
  async consume(nonce) {
    const address = await redis.get(`nonce:${nonce}`);
    if (address) await redis.del(`nonce:${nonce}`);
    return address;
  },
};

const lock = new NeuraiLock({ nonceStore: myRedisStore });
```

## Running the example

A working Express + HTML example is included:

```
cd node_modules/@neuraiproject/neurai-lock/example
npm install
npm start
# Open http://localhost:4000 in Chrome with the Neurai Sign extension installed
```

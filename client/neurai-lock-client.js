/**
 * NeuraiLockClient — Browser-side snippet for neurai-lock
 *
 * This file runs in the browser. It communicates with:
 *   1. The Neurai wallet Chrome extension (window.neuraiWallet)
 *   2. Your own backend endpoints that use the @neuraiproject/neurai-lock npm package
 *
 * Usage:
 *   <script src="/path/to/neurai-lock-client.js"></script>
 *   <script>
 *     const result = await NeuraiLockClient.connect({
 *       challengeUrl: '/api/neurai/challenge',
 *       verifyUrl:    '/api/neurai/verify'
 *     });
 *     if (result.ok) { ... } else { console.log(result.reason); }
 *   </script>
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.NeuraiLockClient = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : self, function () {
  'use strict';

  /**
   * Waits until window.neuraiWallet is injected by the content script.
   * The content script fires the 'neuraiWalletReady' DOM event when done.
   * Falls back to a polling loop in case the event was missed.
   *
   * @param {number} timeoutMs - Max wait time in ms (default 3000)
   * @returns {Promise<boolean>} true if wallet is available, false if timed out
   */
  function waitForWallet(timeoutMs) {
    timeoutMs = timeoutMs || 3000;
    return new Promise(function (resolve) {
      // Already injected — resolve immediately
      if (window.neuraiWallet && window.neuraiWallet.isInstalled) {
        resolve(true);
        return;
      }

      var settled = false;
      function done(found) {
        if (!settled) {
          settled = true;
          resolve(found);
        }
      }

      // Primary signal: 'neuraiWalletReady' event dispatched by inject.js
      document.addEventListener('neuraiWalletReady', function handler() {
        document.removeEventListener('neuraiWalletReady', handler);
        done(true);
      });

      // Fallback: poll every 50ms in case the event was already fired
      var pollInterval = setInterval(function () {
        if (window.neuraiWallet && window.neuraiWallet.isInstalled) {
          clearInterval(pollInterval);
          done(true);
        }
      }, 50);

      // Timeout
      setTimeout(function () {
        clearInterval(pollInterval);
        done(false);
      }, timeoutMs);
    });
  }

  /**
   * Synchronous check — only reliable AFTER waitForWallet() has resolved.
   * Use this to update UI after the page is fully ready.
   * @returns {boolean}
   */
  function isWalletInstalled() {
    return !!(window.neuraiWallet && window.neuraiWallet.isInstalled);
  }

  /**
   * Runs the full connect flow:
   *   1. Waits for the extension content script to inject window.neuraiWallet
   *   2. Gets wallet address from extension
   *   3. Requests a challenge nonce from your backend (POST to challengeUrl)
   *   4. Asks the extension to sign the nonce (user sees approval popup)
   *   5. Sends address + nonce + signature to your backend (POST to verifyUrl)
   *   6. Returns your backend's LockResult
   *
   * @param {object} options
   * @param {string} options.challengeUrl   - Your backend endpoint that calls lock.createChallenge()
   * @param {string} options.verifyUrl      - Your backend endpoint that calls lock.verifyChallenge()
   * @param {object} [options.fetchOptions] - Extra options merged into every fetch() call
   * @param {number} [options.walletTimeout=3000] - Max ms to wait for the extension to load
   * @returns {Promise<object>} LockResult: { ok, address, balances? } or { ok: false, errorCode, reason }
   */
  async function connect({ challengeUrl, verifyUrl, fetchOptions = {}, walletTimeout = 3000 }) {
    // Step 1: Wait for the content script to inject window.neuraiWallet
    var walletReady = await waitForWallet(walletTimeout);
    if (!walletReady) {
      return {
        ok: false,
        errorCode: 'NOT_INSTALLED',
        reason: 'Neurai wallet extension is not installed or not responding. Please install it from the Chrome Web Store.',
        address: null,
      };
    }

    // Step 2: Get wallet address
    let address;
    try {
      address = await window.neuraiWallet.getAddress();
    } catch (err) {
      return {
        ok: false,
        errorCode: 'NO_WALLET',
        reason: 'Could not get address from the wallet extension: ' + (err && err.message || String(err)),
        address: null,
      };
    }

    if (!address) {
      return {
        ok: false,
        errorCode: 'NO_WALLET',
        reason: 'The wallet extension has no wallet configured. Please import or create a wallet first.',
        address: null,
      };
    }

    // Step 3: Request challenge nonce from developer's backend
    let nonce;
    try {
      const resp = await fetch(challengeUrl, Object.assign({}, fetchOptions, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, fetchOptions.headers || {}),
        body: JSON.stringify({ address }),
      }));
      if (!resp.ok) {
        throw new Error('HTTP ' + resp.status + ' ' + resp.statusText);
      }
      const data = await resp.json();
      nonce = data.nonce;
      if (!nonce) throw new Error('Server did not return a nonce.');
    } catch (err) {
      return {
        ok: false,
        errorCode: 'CHALLENGE_ERROR',
        reason: 'Failed to obtain challenge from server: ' + (err && err.message || String(err)),
        address,
      };
    }

    // Step 4: Sign the nonce with the extension (user sees approval popup)
    let signature;
    try {
      const signResult = await window.neuraiWallet.signMessage(nonce);
      signature = signResult.signature;
    } catch (err) {
      const msg = (err && err.message) || String(err);
      return {
        ok: false,
        errorCode: 'USER_REJECTED',
        reason: msg.includes('timed out') || msg.includes('timeout')
          ? 'Signing request timed out. Please try again and approve the request in the extension popup.'
          : 'Signature was rejected: ' + msg,
        address,
      };
    }

    // Step 5: Send to developer's backend for verification
    let result;
    try {
      const resp = await fetch(verifyUrl, Object.assign({}, fetchOptions, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, fetchOptions.headers || {}),
        body: JSON.stringify({ address, nonce, signature }),
      }));
      if (!resp.ok) {
        throw new Error('HTTP ' + resp.status + ' ' + resp.statusText);
      }
      result = await resp.json();
    } catch (err) {
      return {
        ok: false,
        errorCode: 'VERIFY_REQUEST_ERROR',
        reason: 'Failed to send verification to server: ' + (err && err.message || String(err)),
        address,
      };
    }

    return result;
  }

  return { connect, isWalletInstalled, waitForWallet };
}));

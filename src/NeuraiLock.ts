import { randomBytes } from 'crypto';
import * as neuraiMessage from '@neuraiproject/neurai-message';
import * as neuraiRpc from '@neuraiproject/neurai-rpc';
import { createNonceStore } from './nonceStore';
import {
  NeuraiLockConfig,
  VerifyChallengeInput,
  LockResult,
  LockBalances,
  AssetBalance,
  INonceStore,
} from './types';

const verifyMessage = neuraiMessage.verifyMessage;
const getRPC = neuraiRpc.getRPC;

const URL_MAINNET = 'https://rpc-main.neurai.org/rpc';
const ONE_COIN = 1e8;
const DEFAULT_NONCE_TTL = 5 * 60 * 1000; // 5 minutes
const BLOCK_SECONDS = 60; // Neurai ~60s block time

function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

function parseMinAgeToBlocks(minAge: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(minAge.trim().toLowerCase());
  if (!match) {
    throw new Error(
      `Invalid minAge format: "${minAge}". Use a number followed by m (minutes), h (hours) or d (days). Example: '1h', '30m', '2d'.`
    );
  }
  const value = parseInt(match[1], 10);
  const multipliers: Record<string, number> = { m: 60, h: 3600, d: 86400 };
  const seconds = value * multipliers[match[2]];
  return Math.ceil(seconds / BLOCK_SECONDS);
}

function normalizeBalanceResponse(raw: unknown): Array<{ assetName?: string; balance: number; divisible?: boolean }> {
  if (Array.isArray(raw)) {
    return raw as Array<{ assetName?: string; balance: number; divisible?: boolean }>;
  }
  // Object form: { balance, unconfirmed_balance } — XNA only, no assets
  const obj = raw as { balance?: number };
  return [{ assetName: '', balance: obj.balance ?? 0 }];
}

function validateConfig(config: NeuraiLockConfig): void {
  if (config.rpcUrl !== undefined && !config.rpcUrl.startsWith('http')) {
    throw new Error('INVALID_CONFIG: rpcUrl must start with http or https.');
  }
  if (config.minXna !== undefined) {
    if (typeof config.minXna.amount !== 'number' || config.minXna.amount < 0) {
      throw new Error('INVALID_CONFIG: minXna.amount must be a non-negative number.');
    }
    if (config.minXna.minAge !== undefined) {
      parseMinAgeToBlocks(config.minXna.minAge); // throws if invalid
    }
  }
  if (config.assets !== undefined) {
    for (const asset of config.assets) {
      if (!asset.name || typeof asset.name !== 'string') {
        throw new Error('INVALID_CONFIG: each asset entry must have a non-empty name.');
      }
      if (typeof asset.minAmount !== 'number' || asset.minAmount < 0) {
        throw new Error(`INVALID_CONFIG: assets[${asset.name}].minAmount must be a non-negative number.`);
      }
    }
  }
}

export class NeuraiLock {
  private readonly rpcUrl: string;
  private readonly rpcUsername: string;
  private readonly rpcPassword: string;
  private readonly config: NeuraiLockConfig;
  private readonly nonceStore: INonceStore;
  private readonly rpc: (method: string, params: unknown[]) => Promise<unknown>;

  static readonly URL_MAINNET = URL_MAINNET;
  static readonly URL_TESTNET = 'https://rpc-testnet.neurai.org/rpc';

  constructor(config: NeuraiLockConfig = {}) {
    validateConfig(config);
    this.config = config;
    this.rpcUrl = config.rpcUrl ?? URL_MAINNET;
    this.rpcUsername = config.rpcUsername ?? 'anonymous';
    this.rpcPassword = config.rpcPassword ?? 'anonymous';
    this.nonceStore = config.nonceStore ?? createNonceStore(config.nonceTtl ?? DEFAULT_NONCE_TTL);
    this.rpc = getRPC(this.rpcUsername, this.rpcPassword, this.rpcUrl) as (method: string, params: unknown[]) => Promise<unknown>;
  }

  /**
   * Generates a one-time challenge nonce for the given address.
   * The developer should call this from an HTTP endpoint and return the nonce to the browser.
   */
  async createChallenge(address: string): Promise<{ nonce: string }> {
    if (typeof address !== 'string' || address.length === 0 || address.length > 128) {
      throw new Error('INVALID_INPUT: address must be a non-empty string (max 128 chars).');
    }
    const nonce = generateNonce();
    this.nonceStore.save(nonce, address);
    return { nonce };
  }

  /**
   * Verifies that the user controls the address (via signature) and meets all
   * configured on-chain requirements (XNA balance, coin age, assets).
   *
   * The nonce is consumed on first use — it cannot be reused.
   */
  async verifyChallenge(input: VerifyChallengeInput): Promise<LockResult> {
    const { address, nonce, signature } = input;

    // Step 0: Validate input types to prevent injection
    if (
      typeof address !== 'string' || address.length === 0 ||
      typeof nonce !== 'string' || nonce.length === 0 ||
      typeof signature !== 'string' || signature.length === 0
    ) {
      return {
        ok: false,
        address: typeof address === 'string' ? address : null,
        errorCode: 'NONCE_INVALID',
        reason: 'Invalid input: address, nonce and signature must be non-empty strings.',
      };
    }

    // Step 1: Validate the nonce and enforce address binding
    const storedAddress = this.nonceStore.consume(nonce);
    if (storedAddress === null) {
      return {
        ok: false,
        address,
        errorCode: 'NONCE_INVALID',
        reason: 'The challenge nonce is invalid or has expired. Request a new one.',
      };
    }

    if (storedAddress !== address) {
      return {
        ok: false,
        address,
        errorCode: 'NONCE_INVALID',
        reason: 'The challenge nonce was issued for a different address.',
      };
    }

    // Step 2: Verify ownership — signature must match the nonce and address
    let signatureValid: boolean;
    try {
      signatureValid = verifyMessage(nonce, address, signature);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      return {
        ok: false,
        address,
        errorCode: 'VERIFY_FAILED',
        reason: 'Signature verification failed. The signature does not match the address.',
      };
    }

    // Step 3: Fetch on-chain data (always, so balances are always real)
    const needsXna = !!this.config.minXna;
    const needsAge = needsXna && !!this.config.minXna!.minAge;

    let balanceRaw: unknown;
    let utxoRaw: unknown[] = [];
    let blockCount = 0;

    try {
      if (needsAge) {
        [balanceRaw, utxoRaw, blockCount] = await Promise.all([
          this.rpc('getaddressbalance', [{ addresses: [address] }, true]),
          this.rpc('getaddressutxos', [{ addresses: [address] }]) as Promise<unknown[]>,
          this.rpc('getblockcount', []) as Promise<number>,
        ]);
      } else {
        balanceRaw = await this.rpc('getaddressbalance', [{ addresses: [address] }, true]);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        address,
        errorCode: 'RPC_ERROR',
        reason: `Failed to fetch balance from the Neurai node: ${message}`,
      };
    }

    // Step 5: Parse balances
    const entries = normalizeBalanceResponse(balanceRaw);

    const xnaEntry = entries.find((e) => !e.assetName || e.assetName === '');
    const totalXna = (xnaEntry?.balance ?? 0) / ONE_COIN;

    const assetEntries: AssetBalance[] = entries
      .filter((e) => e.assetName && e.assetName !== '')
      .map((e) => {
        const decimals = typeof e.divisible === 'boolean' ? (e.divisible ? 8 : 0) : 8;
        return {
          name: e.assetName as string,
          amount: e.balance / Math.pow(10, decimals),
        };
      });

    // Step 6: Calculate aged XNA (UTXOs old enough)
    let agedXna = totalXna;
    if (needsAge) {
      const minAgeBlocks = parseMinAgeToBlocks(this.config.minXna!.minAge!);
      let agedSatoshis = 0;
      for (const utxo of utxoRaw as Array<{ assetName?: string; satoshis: number; height: number }>) {
        const isXna = !utxo.assetName || utxo.assetName === '';
        if (isXna && utxo.height > 0) {
          const ageInBlocks = (blockCount as unknown as number) - utxo.height;
          if (ageInBlocks >= minAgeBlocks) {
            agedSatoshis += utxo.satoshis;
          }
        }
      }
      agedXna = agedSatoshis / ONE_COIN;
    }

    const balances: LockBalances = {
      xna: { total: totalXna, aged: agedXna },
      assets: assetEntries,
    };

    // Step 7: Check XNA requirement
    if (this.config.minXna) {
      const required = this.config.minXna.amount;
      if (this.config.minXna.minAge) {
        if (agedXna < required) {
          return {
            ok: false,
            address,
            errorCode: 'INSUFFICIENT_XNA_AGE',
            reason: `Requires ${required} XNA aged at least ${this.config.minXna.minAge}. Address has ${agedXna.toFixed(8)} XNA of sufficient age (total: ${totalXna.toFixed(8)} XNA).`,
            balances,
          };
        }
      } else {
        if (totalXna < required) {
          return {
            ok: false,
            address,
            errorCode: 'INSUFFICIENT_XNA',
            reason: `Requires ${required} XNA. Address has ${totalXna.toFixed(8)} XNA.`,
            balances,
          };
        }
      }
    }

    // Step 8: Check asset requirements
    if (this.config.assets) {
      for (const req of this.config.assets) {
        const held = assetEntries.find((a) => a.name === req.name);
        const heldAmount = held?.amount ?? 0;
        if (heldAmount < req.minAmount) {
          return {
            ok: false,
            address,
            errorCode: 'INSUFFICIENT_ASSET',
            reason: `Requires ${req.minAmount} of asset '${req.name}'. Address has ${heldAmount}.`,
            balances,
          };
        }
      }
    }

    // All checks passed
    return { ok: true, address, balances };
  }
}

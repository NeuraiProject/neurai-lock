export type ErrorCode =
  | 'NONCE_INVALID'
  | 'VERIFY_FAILED'
  | 'RPC_ERROR'
  | 'INSUFFICIENT_XNA'
  | 'INSUFFICIENT_XNA_AGE'
  | 'INSUFFICIENT_ASSET'
  | 'INVALID_CONFIG';

export interface AssetRequirement {
  /** Asset name exactly as it appears on-chain (case-sensitive, e.g. 'MYTOKEN') */
  name: string;
  /** Minimum amount required (human units, not satoshis) */
  minAmount: number;
}

export interface XnaRequirement {
  /** Minimum XNA balance required (human units, e.g. 1000 for 1000 XNA) */
  amount: number;
  /**
   * Minimum coin age. Only XNA in UTXOs older than this counts toward the minimum.
   * Format: number + unit, e.g. '30m', '1h', '2d'.
   * If omitted, total confirmed balance is used without age filtering.
   */
  minAge?: string;
}

export interface INonceStore {
  save(nonce: string, address: string): void;
  consume(nonce: string): string | null;
}

export interface NeuraiLockConfig {
  /** RPC endpoint URL. Defaults to Neurai mainnet. */
  rpcUrl?: string;
  /** RPC username. Defaults to 'anonymous'. */
  rpcUsername?: string;
  /** RPC password. Defaults to 'anonymous'. */
  rpcPassword?: string;
  /** Minimum native XNA balance requirement. */
  minXna?: XnaRequirement;
  /** List of asset requirements. All must be satisfied. */
  assets?: AssetRequirement[];
  /** Nonce TTL in milliseconds. Defaults to 300000 (5 minutes). */
  nonceTtl?: number;
  /**
   * Custom nonce store implementation (e.g. Redis-backed).
   * Defaults to an in-memory store.
   */
  nonceStore?: INonceStore;
}

export interface VerifyChallengeInput {
  address: string;
  nonce: string;
  signature: string;
}

export interface XnaBalance {
  /** Total confirmed XNA balance */
  total: number;
  /** XNA balance in UTXOs that meet the minAge requirement (equals total if no age req) */
  aged: number;
}

export interface AssetBalance {
  name: string;
  amount: number;
}

export interface LockBalances {
  xna: XnaBalance;
  assets: AssetBalance[];
}

export type LockResult =
  | { ok: true; address: string; balances: LockBalances }
  | { ok: false; address: string | null; reason: string; errorCode: ErrorCode; balances?: LockBalances };

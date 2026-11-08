import 'fast-text-encoding';
import * as ExpoCrypto from 'expo-crypto';

export interface AuthCryptoHost {
  crypto?: {
    getRandomValues?: typeof ExpoCrypto.getRandomValues;
    subtle?: { digest?: (algorithm: string | { name: string }, data: BufferSource) => Promise<ArrayBuffer> };
  };
}

// Supabase needs secure randomness and SHA-256. Do not allow its plain PKCE fallback.
export function installAuthCrypto(target: AuthCryptoHost = globalThis as unknown as AuthCryptoHost) {
  const crypto = target.crypto ?? {};
  crypto.getRandomValues ??= ExpoCrypto.getRandomValues;
  crypto.subtle ??= {};
  crypto.subtle.digest ??= async (algorithm, data) => {
    const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
    if (name !== 'SHA-256') throw new Error('Unsupported authentication digest.');
    return ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, data);
  };
  if (!target.crypto) Object.defineProperty(target, 'crypto', { value: crypto, configurable: true });
}

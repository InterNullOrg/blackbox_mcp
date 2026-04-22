import { ethers } from 'ethers';
import * as ed from '@noble/ed25519';
import { sha512, sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

// Configure SHA-512 for @noble/ed25519 v3
ed.hashes.sha512 = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

function modInverse(a: bigint, m: bigint): bigint {
  a = ((a % m) + m) % m;
  let [old_r, r] = [a, m];
  let [old_s, s] = [1n, 0n];

  while (r !== 0n) {
    const quotient = old_r / r;
    [old_r, r] = [r, old_r - quotient * r];
    [old_s, s] = [s, old_s - quotient * s];
  }

  if (old_r > 1n) throw new Error('Modular inverse does not exist');
  return ((old_s % m) + m) % m;
}

function computeLagrangeCoefficient(
  shares: Array<{ shareId: string }>,
  i: number,
): bigint {
  const xi = BigInt(shares[i].shareId);
  let numerator = 1n;
  let denominator = 1n;

  for (let j = 0; j < shares.length; j++) {
    if (i === j) continue;
    const xj = BigInt(shares[j].shareId);

    let negXj = (-xj) % SECP256K1_N;
    if (negXj < 0n) negXj += SECP256K1_N;
    numerator = (numerator * negXj) % SECP256K1_N;

    let diff = (xi - xj) % SECP256K1_N;
    if (diff < 0n) diff += SECP256K1_N;
    denominator = (denominator * diff) % SECP256K1_N;
  }

  const denomInv = modInverse(denominator, SECP256K1_N);
  return (numerator * denomInv) % SECP256K1_N;
}

export function reconstructPrivateKey(
  keyshares: Array<{ shareId: string; shareValue: string; nodeId?: number }>,
  threshold = 3,
): { privateKey: bigint; privateKeyHex: string } {
  if (keyshares.length < threshold) {
    throw new Error(`Need at least ${threshold} shares, got ${keyshares.length}`);
  }

  const sharesToUse = keyshares.slice(0, threshold);
  let result = 0n;

  for (let i = 0; i < sharesToUse.length; i++) {
    let hex = sharesToUse[i].shareValue;
    if (hex.startsWith('0x')) hex = hex.slice(2);
    const y_i = BigInt('0x' + hex);

    const lambda = computeLagrangeCoefficient(sharesToUse, i);
    result = (result + (y_i * lambda) % SECP256K1_N) % SECP256K1_N;
  }

  result = (result + SECP256K1_N) % SECP256K1_N;
  const privateKeyHex = '0x' + result.toString(16).padStart(64, '0');

  return { privateKey: result, privateKeyHex };
}

export function isSolanaAddress(address: string): boolean {
  if (address.startsWith('0x')) return false;
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  return base58Regex.test(address) && address.length >= 32 && address.length <= 44;
}

export async function secp256k1ToEd25519Seed(secp256k1PrivKeyHex: string): Promise<Uint8Array> {
  const signingKey = new ethers.utils.SigningKey(secp256k1PrivKeyHex);
  let pubKeyHex = signingKey.compressedPublicKey;
  if (pubKeyHex.startsWith('0x')) pubKeyHex = pubKeyHex.slice(2);
  const pubKeyBytes = Buffer.from(pubKeyHex, 'hex');

  const domainSeparator = new TextEncoder().encode('ed25519');
  const combined = new Uint8Array(pubKeyBytes.length + domainSeparator.length);
  combined.set(pubKeyBytes);
  combined.set(domainSeparator, pubKeyBytes.length);

  return sha256(combined);
}

export async function verifySolanaKeyMatchesAddress(privateKeyHex: string, expectedAddress: string): Promise<boolean> {
  const seed = await secp256k1ToEd25519Seed(privateKeyHex);
  const pubKey = await ed.getPublicKey(seed);
  const solanaAddress = bs58.encode(pubKey);
  return solanaAddress === expectedAddress;
}

export function verifyKeyMatchesAddress(privateKeyHex: string, expectedAddress: string): boolean {
  const wallet = new ethers.Wallet(privateKeyHex);
  return wallet.address.toLowerCase() === expectedAddress.toLowerCase();
}

export function getSolanaPrivateKeyFromSecp256k1(ed25519Seed: Uint8Array): string {
  return '0x' + Buffer.from(ed25519Seed).toString('hex');
}

export function sortKeysRecursive(obj: any): any {
  if (Array.isArray(obj)) return obj.map(sortKeysRecursive);
  if (obj !== null && typeof obj === 'object') {
    const sorted: any = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysRecursive(obj[key]);
    }
    return sorted;
  }
  return obj;
}

export function createProofMessage(
  depositTxHash: string,
  sourceChain: string,
  withdrawalRequests: Array<{ target_chain: string; token_symbol: string; denomination: string }>,
  userAddress: string,
  timestamp: number,
): string {
  const message = {
    action: 'request_withdrawal',
    deposit_tx: depositTxHash,
    source_chain: sourceChain,
    timestamp,
    user_address: userAddress,
    withdrawal_requests: withdrawalRequests.map(wr => ({
      denomination: wr.denomination,
      target_chain: wr.target_chain,
      token_symbol: wr.token_symbol,
    })),
  };

  const sorted = sortKeysRecursive(message);
  // Match Python json.dumps() default separators: (', ', ': ')
  const compact = JSON.stringify(sorted);
  return compact.replace(/,/g, ', ').replace(/:/g, ': ');
}

export function createWithdrawalSignature(
  privateKeyHex: string,
  recipient: string,
  tokenAddress: string,
  amountWei: ethers.BigNumber,
  merkleRootId: number,
  keyIndex: number,
  chainId: number,
): Promise<string> {
  const encoded = ethers.utils.defaultAbiCoder.encode(
    ['address', 'address', 'uint256', 'uint256', 'uint256', 'uint256'],
    [recipient, tokenAddress, amountWei, merkleRootId, keyIndex, chainId],
  );
  const messageHash = ethers.utils.keccak256(encoded);
  const wallet = new ethers.Wallet(privateKeyHex);
  return wallet.signMessage(ethers.utils.arrayify(messageHash));
}

export function createRelayWithdrawalSignature(
  privateKeyHex: string,
  recipient: string,
  tokenAddress: string,
  amountWei: ethers.BigNumber,
  merkleRootId: number,
  keyIndex: number,
  chainId: number,
  relayerAddress: string,
  maxRelayerFee: ethers.BigNumber,
): Promise<string> {
  const encoded = ethers.utils.defaultAbiCoder.encode(
    ['address', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'address', 'uint256'],
    [recipient, tokenAddress, amountWei, merkleRootId, keyIndex, chainId, relayerAddress, maxRelayerFee],
  );
  const messageHash = ethers.utils.keccak256(encoded);
  const wallet = new ethers.Wallet(privateKeyHex);
  return wallet.signMessage(ethers.utils.arrayify(messageHash));
}

// ── Solana Ed25519 signing ──

const CHAIN_ID_SOLANA = 900n;

function u64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function pubkeyBytes(base58Addr: string): Buffer {
  if (!base58Addr || base58Addr === '' || base58Addr === '0x0000000000000000000000000000000000000000') {
    return Buffer.alloc(32); // all zeros = native SOL
  }
  return Buffer.from(bs58.decode(base58Addr));
}

function solanaKeccak256(data: Buffer): Buffer {
  return Buffer.from(
    ethers.utils.arrayify(ethers.utils.keccak256(data))
  );
}

// Direct withdrawal: keccak256(recipient[32] + token[32] + amount_le[8] + chainId_le[8])
export async function createSolanaWithdrawalSignature(
  ed25519Seed: Uint8Array,
  recipient: string,
  tokenAddress: string,
  amount: bigint,
): Promise<{ signature: string; publicKey: string }> {
  const messageData = Buffer.concat([
    pubkeyBytes(recipient),
    pubkeyBytes(tokenAddress),
    u64LE(amount),
    u64LE(CHAIN_ID_SOLANA),
  ]);
  const messageHash = solanaKeccak256(messageData);

  const signature = await ed.sign(messageHash, ed25519Seed);
  const pubKey = await ed.getPublicKey(ed25519Seed);

  return {
    signature: Buffer.from(signature).toString('hex'),
    publicKey: bs58.encode(pubKey),
  };
}

// Relay withdrawal: keccak256(recipient[32] + token[32] + amount_le[8] + chainId_le[8] + relayer[32] + maxRelayerFee_le[8])
export async function createSolanaRelaySignature(
  ed25519Seed: Uint8Array,
  recipient: string,
  tokenAddress: string,
  amount: bigint,
  relayerAddress: string,
  maxRelayerFee: bigint,
): Promise<{ signature: string; publicKey: string }> {
  const messageData = Buffer.concat([
    pubkeyBytes(recipient),
    pubkeyBytes(tokenAddress),
    u64LE(amount),
    u64LE(CHAIN_ID_SOLANA),
    pubkeyBytes(relayerAddress),
    u64LE(maxRelayerFee),
  ]);
  const messageHash = solanaKeccak256(messageData);

  const signature = await ed.sign(messageHash, ed25519Seed);
  const pubKey = await ed.getPublicKey(ed25519Seed);

  return {
    signature: Buffer.from(signature).toString('hex'),
    publicKey: bs58.encode(pubKey),
  };
}

import { ethers } from 'ethers';

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

export function verifyKeyMatchesAddress(privateKeyHex: string, expectedAddress: string): boolean {
  const wallet = new ethers.Wallet(privateKeyHex);
  return wallet.address.toLowerCase() === expectedAddress.toLowerCase();
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

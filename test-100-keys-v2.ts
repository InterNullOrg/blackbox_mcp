/**
 * Test: Deposit 0.1 ETH on Sepolia
 * Claim 50 keys for Sepolia + 50 keys for Base Sepolia (all 0.001 ETH)
 * Verify: all keys reconstruct, all key_indexes distinct, all share combos work
 * Measure: timing of key retrieval
 */
import { ethers } from 'ethers';
import * as fs from 'fs';
import { BlackBoxAPI } from './src/api.js';
import { loadConfig } from './src/config.js';
import { WalletManager } from './src/wallet.js';
import { reconstructPrivateKey, createProofMessage, verifyKeyMatchesAddress } from './src/crypto.js';

if (!process.env.DKG_NODE_1 && !process.env.DKG_NODE_URLS) {
  for (let i = 1; i <= 5; i++) {
    process.env[`DKG_NODE_${i}`] = `https://theblackbox.network/node${i}`;
  }
}

const TREASURY_ABI = [
  'function deposit(address token, uint256 amount) payable',
];

const WALLET_NAME = 'test-agent';
const WALLET_PASSWORD = 'test-password-123';

const config = loadConfig();
const api = new BlackBoxAPI(config);
const walletManager = new WalletManager(config.walletStorePath);

function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  return [...combinations(rest, k - 1).map(c => [first, ...c]), ...combinations(rest, k)];
}

async function waitForConfirmations(provider: ethers.providers.Provider, txHash: string, required = 2) {
  console.log(`  Waiting for ${required} confirmations...`);
  for (let i = 0; i < 120; i++) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) {
      const current = await provider.getBlockNumber();
      const confs = current - receipt.blockNumber;
      if (confs >= required) { console.log(`  Got ${confs} confirmations`); return; }
      if (i % 6 === 0) console.log(`  ${confs}/${required} confirmations...`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Timed out waiting for confirmations');
}

async function main() {
  console.log('=== TEST: 50 Sepolia + 50 Base Sepolia keys from 0.1 ETH ===\n');

  const wallet = walletManager.getWallet(WALLET_NAME);
  if (!wallet) { console.error('No test wallet found'); process.exit(1); }
  console.log(`Wallet: ${wallet.address}`);

  const chains = await api.getChains();
  const sepolia = chains.find(c => c.chain_name === 'sepolia')!;
  const provider = new ethers.providers.JsonRpcProvider(sepolia.rpc_url);
  const signer = walletManager.getSigner(WALLET_NAME, WALLET_PASSWORD, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`Sepolia ETH balance: ${ethers.utils.formatEther(balance)}`);
  if (balance.lt(ethers.utils.parseEther('0.101'))) {
    console.error('Need at least 0.101 ETH (0.1 deposit + gas)'); process.exit(1);
  }

  // Step 1: Deposit 0.1 ETH
  console.log('\n--- Step 1: Deposit 0.1 ETH on Sepolia ---');
  const treasury = new ethers.Contract(sepolia.treasury_address, TREASURY_ABI, signer);
  const depositAmount = ethers.utils.parseEther('0.1');
  const tx = await treasury.deposit(ethers.constants.AddressZero, depositAmount, {
    value: depositAmount, gasLimit: 200000,
  });
  console.log(`  TX: ${tx.hash}`);
  await tx.wait();
  console.log('  Deposit confirmed');
  await waitForConfirmations(provider, tx.hash);

  // Step 2: Build 100 withdrawal requests — 50 sepolia + 50 base_sepolia
  console.log('\n--- Step 2: Claim 50 Sepolia + 50 Base Sepolia keys ---');
  const withdrawalRequests: Array<{ target_chain: string; token_symbol: string; denomination: string }> = [];
  for (let i = 0; i < 50; i++) {
    withdrawalRequests.push({ target_chain: 'sepolia', token_symbol: 'ETH', denomination: '0.001' });
  }
  for (let i = 0; i < 50; i++) {
    withdrawalRequests.push({ target_chain: 'base_sepolia', token_symbol: 'ETH', denomination: '0.001' });
  }
  console.log(`  ${withdrawalRequests.length} withdrawal requests (50 sepolia, 50 base_sepolia)`);

  const timestamp = Math.floor(Date.now() / 1000);
  const proofMessage = createProofMessage(tx.hash, 'sepolia', withdrawalRequests, signer.address, timestamp);
  const signature = await signer.signMessage(proofMessage);
  const spendRequestId = ethers.utils.id(`${tx.hash}:sepolia:0:${timestamp}`);

  // TIME the keyshare request
  console.log('  Requesting keyshares from all 5 nodes...');
  const t0 = performance.now();

  const results = await api.requestKeyshares({
    depositTxHash: tx.hash,
    sourceChain: 'sepolia',
    withdrawalRequests,
    userAddress: signer.address,
    signature,
    timestamp,
    occurrenceOffset: 0,
    spendRequestId,
  });

  const t1 = performance.now();
  const keyRetrievalMs = t1 - t0;

  const successful = results.filter(r => r.success && r.keyshares?.length);
  const failed = results.filter(r => !r.success);
  console.log(`  Nodes responded: ${successful.length} success, ${failed.length} failed`);
  if (failed.length > 0) console.log(`  Failures: ${failed.map(f => f.error).join('; ').slice(0, 300)}`);
  console.log(`  KEY RETRIEVAL TIME: ${(keyRetrievalMs / 1000).toFixed(2)}s`);

  if (successful.length < 3) {
    console.error('  Not enough nodes'); process.exit(1);
  }

  const threshold = successful[0]?.threshold || 3;
  const numNodes = successful.length;
  console.log(`  Threshold: ${threshold}, Nodes: ${numNodes}`);
  console.log(`  Keyshares per node: ${successful[0]?.keyshares?.length}`);
  console.log(`  depositAmount: ${successful[0]?.depositAmount}, remaining: ${successful[0]?.remainingDeposit}`);

  // TIME the reconstruction
  console.log(`\n--- Step 3: Reconstruct & verify all 100 keys ---`);
  const t2 = performance.now();

  const allCombos = combinations(Array.from({ length: numNodes }, (_, i) => i), threshold);
  console.log(`  Share combinations per key: ${allCombos.length}`);

  const allKeyIndexes: number[] = [];
  const allAddresses: string[] = [];
  let totalKeysVerified = 0;
  let totalCombosFailed = 0;
  let failedKeys: number[] = [];

  // Per-chain stats
  const sepoliaKeys: Array<{ idx: number; keyIndex: number; address: string }> = [];
  const baseKeys: Array<{ idx: number; keyIndex: number; address: string }> = [];

  for (let keyIdx = 0; keyIdx < 100; keyIdx++) {
    const sharesForKey = successful.map((nodeResult, ni) => {
      const ks = nodeResult.keyshares![keyIdx];
      return {
        nodeIdx: ni,
        nodeId: nodeResult.nodeId!,
        shareId: ks.share_id,
        shareValue: ks.share_value,
        address: ks.address,
        keyIndex: ks.key_index,
        merkleRootId: ks.merkle_root_id,
        chainName: ks.chain_name,
      };
    });

    const expectedAddress = sharesForKey[0].address;
    const expectedKeyIndex = sharesForKey[0].keyIndex;
    const expectedChain = sharesForKey[0].chainName;

    // Check nodes agree
    const mismatch = sharesForKey.some(s => s.address !== expectedAddress || s.keyIndex !== expectedKeyIndex);
    if (mismatch) {
      console.log(`  Key ${keyIdx}: NODE MISMATCH!`);
      failedKeys.push(keyIdx);
      continue;
    }

    allKeyIndexes.push(expectedKeyIndex);
    allAddresses.push(expectedAddress);

    if (keyIdx < 50) sepoliaKeys.push({ idx: keyIdx, keyIndex: expectedKeyIndex, address: expectedAddress });
    else baseKeys.push({ idx: keyIdx, keyIndex: expectedKeyIndex, address: expectedAddress });

    // Test ALL share combinations
    let anyFailed = false;
    for (const combo of allCombos) {
      const shares = combo.map(ni => ({
        shareId: sharesForKey[ni].shareId,
        shareValue: sharesForKey[ni].shareValue,
      }));
      try {
        const { privateKeyHex } = reconstructPrivateKey(shares, threshold);
        if (!verifyKeyMatchesAddress(privateKeyHex, expectedAddress)) {
          anyFailed = true;
          totalCombosFailed++;
          const nodeIds = combo.map(ni => successful[ni].nodeId);
          console.log(`  Key ${keyIdx} FAIL: combo nodeIds=${JSON.stringify(nodeIds)} address mismatch`);
        }
      } catch (err: any) {
        anyFailed = true;
        totalCombosFailed++;
        const nodeIds = combo.map(ni => successful[ni].nodeId);
        console.log(`  Key ${keyIdx} FAIL: combo nodeIds=${JSON.stringify(nodeIds)} error=${err.message}`);
      }
    }

    if (!anyFailed) totalKeysVerified++;
    else failedKeys.push(keyIdx);

    // Progress every 10
    if (keyIdx % 10 === 0) {
      console.log(`  Key ${keyIdx}: chain=${expectedChain} keyIndex=${expectedKeyIndex} addr=${expectedAddress.slice(0, 12)}... ALL ${allCombos.length} combos OK`);
    }
  }

  const t3 = performance.now();
  const reconstructionMs = t3 - t2;

  // Save all reconstructed keys and raw keyshares for later withdrawal
  const savedKeys: any[] = [];
  for (let keyIdx = 0; keyIdx < 100; keyIdx++) {
    const ks0 = successful[0].keyshares![keyIdx];
    // Reconstruct with first 3 nodes (already verified above)
    const shares = successful.slice(0, threshold).map((nodeResult, ni) => ({
      shareId: nodeResult.keyshares![keyIdx].share_id,
      shareValue: nodeResult.keyshares![keyIdx].share_value,
    }));
    const { privateKeyHex } = reconstructPrivateKey(shares, threshold);

    savedKeys.push({
      index: keyIdx,
      private_key: privateKeyHex,
      address: ks0.address,
      key_index: ks0.key_index,
      merkle_root_id: ks0.merkle_root_id,
      merkle_proof: ks0.merkle_proof,
      chain_name: ks0.chain_name,
      chain_id: ks0.chain_id,
      treasury_address: ks0.treasury_address,
      token_symbol: ks0.token_symbol,
      token_address: ks0.token_address,
      token_decimals: ks0.token_decimals,
      denomination: ks0.denomination,
    });
  }

  const outputFile = `test-100-keys-output-${Date.now()}.json`;
  fs.writeFileSync(outputFile, JSON.stringify({
    deposit_tx_hash: tx.hash,
    source_chain: 'sepolia',
    deposit_amount: '0.1',
    keys_count: savedKeys.length,
    keys: savedKeys,
    raw_node_responses: successful.map(r => ({
      nodeId: r.nodeId,
      keyshares: r.keyshares,
    })),
  }, null, 2));
  console.log(`\n  Saved ${savedKeys.length} keys + raw keyshares to ${outputFile}`);

  // Step 4: Uniqueness analysis
  console.log('\n--- Step 4: Key index uniqueness analysis ---');

  const uniqueIndexes = new Set(allKeyIndexes);
  const uniqueAddresses = new Set(allAddresses);

  console.log(`  Total keys: ${allKeyIndexes.length}`);
  console.log(`  Unique key_indexes: ${uniqueIndexes.size}`);
  console.log(`  Unique addresses: ${uniqueAddresses.size}`);
  console.log(`  All key_indexes distinct? ${uniqueIndexes.size === allKeyIndexes.length ? 'YES' : 'NO'}`);
  console.log(`  All addresses distinct? ${uniqueAddresses.size === allAddresses.length ? 'YES' : 'NO'}`);

  if (uniqueIndexes.size !== allKeyIndexes.length) {
    // Find duplicates
    const seen = new Map<number, number[]>();
    allKeyIndexes.forEach((ki, idx) => {
      if (!seen.has(ki)) seen.set(ki, []);
      seen.get(ki)!.push(idx);
    });
    const dupes = [...seen.entries()].filter(([_, idxs]) => idxs.length > 1);
    console.log(`  DUPLICATE key_indexes (${dupes.length}):`);
    for (const [ki, idxs] of dupes.slice(0, 10)) {
      console.log(`    keyIndex=${ki} appears in keys: ${idxs.join(', ')}`);
    }
  }

  // Sepolia vs Base Sepolia breakdown
  const sepoliaIndexes = new Set(sepoliaKeys.map(k => k.keyIndex));
  const baseIndexes = new Set(baseKeys.map(k => k.keyIndex));
  const overlap = [...sepoliaIndexes].filter(ki => baseIndexes.has(ki));

  console.log(`\n  Sepolia keys: ${sepoliaKeys.length}, unique indexes: ${sepoliaIndexes.size}`);
  console.log(`  Base Sepolia keys: ${baseKeys.length}, unique indexes: ${baseIndexes.size}`);
  console.log(`  Cross-chain index overlap: ${overlap.length}`);
  if (overlap.length > 0) {
    console.log(`  Overlapping indexes: ${overlap.slice(0, 10).join(', ')}`);
    console.log(`  (This is expected — key_index is pool-specific, different chains have separate pools)`);
  }

  // Key index range analysis
  const sorted = [...allKeyIndexes].sort((a, b) => a - b);
  console.log(`\n  Key index range: ${sorted[0]} — ${sorted[sorted.length - 1]}`);
  console.log(`  Median key index: ${sorted[Math.floor(sorted.length / 2)]}`);

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`  Deposit: 0.1 ETH on Sepolia`);
  console.log(`  Keys claimed: 100 (50 sepolia + 50 base_sepolia)`);
  console.log(`  Keys verified: ${totalKeysVerified}/100`);
  console.log(`  Failed keys: ${failedKeys.length}`);
  console.log(`  Total combo tests: ${100 * allCombos.length}`);
  console.log(`  Failed combos: ${totalCombosFailed}`);
  console.log(`  All key_indexes distinct: ${uniqueIndexes.size === allKeyIndexes.length ? 'YES' : 'NO'}`);
  console.log(`  All addresses distinct: ${uniqueAddresses.size === allAddresses.length ? 'YES' : 'NO'}`);
  console.log(`\n  TIMING:`);
  console.log(`    Key retrieval (5 nodes, 100 keys): ${(keyRetrievalMs / 1000).toFixed(2)}s`);
  console.log(`    Reconstruction + verification (100 keys x ${allCombos.length} combos): ${(reconstructionMs / 1000).toFixed(2)}s`);
  console.log(`    Per-key retrieval avg: ${(keyRetrievalMs / 100).toFixed(1)}ms`);
  console.log(`    Per-key reconstruction avg: ${(reconstructionMs / 100).toFixed(1)}ms`);

  if (totalKeysVerified === 100 && totalCombosFailed === 0 && uniqueIndexes.size === 100 && uniqueAddresses.size === 100) {
    console.log('\n  PERFECT: 100/100 keys verified, all distinct, all combos pass');
  } else {
    if (failedKeys.length > 0) console.log(`\n  ISSUES: Failed keys: ${failedKeys.join(', ')}`);
  }
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

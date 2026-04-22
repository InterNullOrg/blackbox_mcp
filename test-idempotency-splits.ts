/**
 * Test: Re-claim same deposit with different splits
 * 1. Re-claim 50 sepolia + 50 base_sepolia (same as original) — verify identical key_indexes
 * 2. Claim 60 sepolia + 40 base_sepolia — see how backend handles different split
 */
import { ethers } from 'ethers';
import * as fs from 'fs';
import { InterNullAPI } from './src/api.js';
import { loadConfig } from './src/config.js';
import { WalletManager } from './src/wallet.js';
import { reconstructPrivateKey, createProofMessage, verifyKeyMatchesAddress } from './src/crypto.js';

if (!process.env.DKG_NODE_1 && !process.env.DKG_NODE_URLS) {
  for (let i = 1; i <= 5; i++) {
    process.env[`DKG_NODE_${i}`] = `https://theblackbox.network/node${i}`;
  }
}

const WALLET_NAME = 'test-agent';
const WALLET_PASSWORD = 'test-password-123';
const DEPOSIT_TX_HASH = '0xa635cdfbd24596396694a5d9d70a63a49efac987400e6163c352b9c5e5bd6568';
const SOURCE_CHAIN = 'sepolia';

const config = loadConfig();
const api = new InterNullAPI(config);
const walletManager = new WalletManager(config.walletStorePath);

// Load original keys for comparison
const originalData = JSON.parse(fs.readFileSync('test-100-keys-output-1772737580433.json', 'utf-8'));
const originalKeys = originalData.keys as Array<{
  index: number; key_index: number; address: string; private_key: string; chain_name: string;
}>;

async function claimKeysWithTx(
  label: string,
  depositTxHash: string,
  sepoliaCount: number,
  baseCount: number,
): Promise<Array<{ index: number; keyIndex: number; address: string; privateKey: string; chainName: string }>> {
  const signer = walletManager.getSigner(WALLET_NAME, WALLET_PASSWORD,
    new ethers.providers.JsonRpcProvider('https://rpc.sepolia.org'));

  const withdrawalRequests: Array<{ target_chain: string; token_symbol: string; denomination: string }> = [];
  for (let i = 0; i < sepoliaCount; i++) {
    withdrawalRequests.push({ target_chain: 'sepolia', token_symbol: 'ETH', denomination: '0.001' });
  }
  for (let i = 0; i < baseCount; i++) {
    withdrawalRequests.push({ target_chain: 'base_sepolia', token_symbol: 'ETH', denomination: '0.001' });
  }

  console.log(`\n--- ${label}: ${sepoliaCount} sepolia + ${baseCount} base_sepolia ---`);
  console.log(`  Deposit TX: ${depositTxHash.slice(0, 20)}...`);

  const timestamp = Math.floor(Date.now() / 1000);
  const proofMessage = createProofMessage(depositTxHash, SOURCE_CHAIN, withdrawalRequests, signer.address, timestamp);
  const signature = await signer.signMessage(proofMessage);
  const spendRequestId = ethers.utils.id(`${depositTxHash}:${SOURCE_CHAIN}:0:${timestamp}`);

  console.log('  Requesting keyshares from all 5 nodes...');
  const t0 = performance.now();

  const results = await api.requestKeyshares({
    depositTxHash: depositTxHash,
    sourceChain: SOURCE_CHAIN,
    withdrawalRequests,
    userAddress: signer.address,
    signature,
    timestamp,
    occurrenceOffset: 0,
    spendRequestId,
  });

  const t1 = performance.now();
  const successful = results.filter(r => r.success && r.keyshares?.length);
  const failed = results.filter(r => !r.success);
  console.log(`  Nodes: ${successful.length} success, ${failed.length} failed (${((t1 - t0) / 1000).toFixed(2)}s)`);
  if (failed.length > 0) console.log(`  Failures: ${failed.map(f => f.error).join('; ').slice(0, 300)}`);

  if (successful.length < 3) {
    console.error('  Not enough nodes'); process.exit(1);
  }

  const threshold = successful[0]?.threshold || 3;
  const total = successful[0]?.keyshares?.length || 0;
  console.log(`  Keys returned: ${total}, threshold: ${threshold}`);
  console.log(`  depositAmount: ${successful[0]?.depositAmount}, remaining: ${successful[0]?.remainingDeposit}`);

  // Reconstruct all keys
  const keys: Array<{ index: number; keyIndex: number; address: string; privateKey: string; chainName: string }> = [];
  for (let keyIdx = 0; keyIdx < total; keyIdx++) {
    const ks0 = successful[0].keyshares![keyIdx];
    const shares = successful.slice(0, threshold).map((nodeResult) => ({
      shareId: nodeResult.keyshares![keyIdx].share_id,
      shareValue: nodeResult.keyshares![keyIdx].share_value,
    }));
    const { privateKeyHex } = reconstructPrivateKey(shares, threshold);
    const matches = verifyKeyMatchesAddress(privateKeyHex, ks0.address);
    if (!matches) {
      console.log(`  Key ${keyIdx}: RECONSTRUCTION FAILED`);
    }
    keys.push({
      index: keyIdx,
      keyIndex: ks0.key_index,
      address: ks0.address,
      privateKey: privateKeyHex,
      chainName: ks0.chain_name,
    });
  }

  console.log(`  All ${keys.length} keys reconstructed`);
  return keys;
}

function compareKeys(
  label: string,
  newKeys: Array<{ index: number; keyIndex: number; address: string; privateKey: string; chainName: string }>,
  refKeys: Array<{ index: number; key_index: number; address: string; private_key: string; chain_name: string }>,
) {
  console.log(`\n--- Compare: ${label} ---`);
  const minLen = Math.min(newKeys.length, refKeys.length);

  let identical = 0;
  let different = 0;
  const diffs: string[] = [];

  for (let i = 0; i < minLen; i++) {
    const n = newKeys[i];
    const r = refKeys[i];
    if (n.keyIndex === r.key_index && n.address === r.address && n.privateKey === r.private_key) {
      identical++;
    } else {
      different++;
      if (diffs.length < 10) {
        diffs.push(`  idx ${i}: new(ki=${n.keyIndex}, chain=${n.chainName}, addr=${n.address.slice(0, 12)}) vs orig(ki=${r.key_index}, chain=${r.chain_name}, addr=${r.address.slice(0, 12)})`);
      }
    }
  }

  console.log(`  Compared: ${minLen} keys`);
  console.log(`  Identical: ${identical}`);
  console.log(`  Different: ${different}`);
  if (newKeys.length !== refKeys.length) {
    console.log(`  Length mismatch: new=${newKeys.length}, original=${refKeys.length}`);
  }
  if (diffs.length > 0) {
    console.log(`  First differences:`);
    diffs.forEach(d => console.log(d));
  }
}

async function main() {
  console.log('=== TEST: Idempotency & Split Variations ===');
  console.log(`Original test had ${originalKeys.length} keys`);

  const sepoliaOrig = originalKeys.filter(k => k.chain_name === 'sepolia');
  const baseOrig = originalKeys.filter(k => k.chain_name === 'base_sepolia');
  console.log(`Original split: ${sepoliaOrig.length} sepolia, ${baseOrig.length} base_sepolia`);
  console.log(`Original key_indexes (first 5): ${originalKeys.slice(0, 5).map(k => k.key_index).join(', ')}`);

  // Test 1: Same 50+50 split — should return identical keys
  console.log('\n========================================');
  console.log('TEST 1: Re-claim same 50+50 split');
  console.log('========================================');
  const keys5050 = await claimKeysWithTx('50+50 re-claim', DEPOSIT_TX_HASH, 50, 50);

  // Print first few for visual comparison
  console.log('\n  First 5 keys comparison:');
  for (let i = 0; i < 5; i++) {
    const n = keys5050[i];
    const o = originalKeys[i];
    console.log(`    [${i}] new: ki=${n.keyIndex} chain=${n.chainName} addr=${n.address.slice(0, 14)} | orig: ki=${o.key_index} chain=${o.chain_name} addr=${o.address.slice(0, 14)}`);
  }

  compareKeys('50+50 vs original 50+50', keys5050, originalKeys);

  // Save results
  const output1 = `test-idempotency-5050-${Date.now()}.json`;
  fs.writeFileSync(output1, JSON.stringify({
    test: '50+50 re-claim',
    deposit_tx_hash: DEPOSIT_TX_HASH,
    keys: keys5050,
  }, null, 2));
  console.log(`  Saved to ${output1}`);

  // Test 2: Different split 60+40 — needs a FRESH deposit since backend locks the split
  console.log('\n========================================');
  console.log('TEST 2: Fresh deposit + 60 sepolia + 40 base_sepolia');
  console.log('========================================');

  const chains = await api.getChains();
  const sepolia = chains.find(c => c.chain_name === 'sepolia')!;
  const provider = new ethers.providers.JsonRpcProvider(sepolia.rpc_url);
  const signer2 = walletManager.getSigner(WALLET_NAME, WALLET_PASSWORD, provider);

  const balance = await provider.getBalance(signer2.address);
  console.log(`  Balance: ${ethers.utils.formatEther(balance)} ETH`);
  if (balance.lt(ethers.utils.parseEther('0.101'))) {
    console.error('  Need at least 0.101 ETH for fresh deposit'); process.exit(1);
  }

  const TREASURY_ABI = ['function deposit(address token, uint256 amount) payable'];
  const treasury = new ethers.Contract(sepolia.treasury_address, TREASURY_ABI, signer2);
  const depositAmount = ethers.utils.parseEther('0.1');
  console.log('  Depositing 0.1 ETH...');
  const tx2 = await treasury.deposit(ethers.constants.AddressZero, depositAmount, {
    value: depositAmount, gasLimit: 200000,
  });
  console.log(`  TX: ${tx2.hash}`);
  await tx2.wait();
  console.log('  Deposit confirmed');

  // Wait for confirmations
  console.log('  Waiting for 2 confirmations...');
  for (let i = 0; i < 120; i++) {
    const receipt = await provider.getTransactionReceipt(tx2.hash);
    if (receipt) {
      const current = await provider.getBlockNumber();
      const confs = current - receipt.blockNumber;
      if (confs >= 2) { console.log(`  Got ${confs} confirmations`); break; }
      if (i % 6 === 0) console.log(`  ${confs}/2 confirmations...`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }

  // Now claim 60+40 from fresh deposit
  const freshDepositTxHash = tx2.hash;
  const keys6040 = await claimKeysWithTx('60+40 split (fresh deposit)', freshDepositTxHash, 60, 40);

  // Print first few
  console.log('\n  First 5 keys:');
  for (let i = 0; i < 5; i++) {
    const k = keys6040[i];
    console.log(`    [${i}] ki=${k.keyIndex} chain=${k.chainName} addr=${k.address.slice(0, 14)}`);
  }

  // Compare with original
  compareKeys('60+40 vs original 50+50', keys6040, originalKeys);

  // Detailed analysis of the 60+40 result
  console.log('\n--- 60+40 Detailed Analysis ---');
  const sep6040 = keys6040.filter(k => k.chainName === 'sepolia');
  const base6040 = keys6040.filter(k => k.chainName === 'base_sepolia');
  console.log(`  Sepolia keys: ${sep6040.length}`);
  console.log(`  Base Sepolia keys: ${base6040.length}`);

  // Check which keys from 50+50 appear in 60+40
  const origKeyIndexSet = new Set(originalKeys.map(k => `${k.chain_name}:${k.key_index}`));
  const newKeyIndexSet = new Set(keys6040.map(k => `${k.chainName}:${k.keyIndex}`));

  const overlap = [...origKeyIndexSet].filter(ki => newKeyIndexSet.has(ki));
  const onlyInOrig = [...origKeyIndexSet].filter(ki => !newKeyIndexSet.has(ki));
  const onlyInNew = [...newKeyIndexSet].filter(ki => !origKeyIndexSet.has(ki));

  console.log(`\n  Key overlap (chain:keyIndex):`);
  console.log(`    In both: ${overlap.length}`);
  console.log(`    Only in original (50+50): ${onlyInOrig.length}`);
  console.log(`    Only in new (60+40): ${onlyInNew.length}`);

  if (onlyInOrig.length > 0) {
    console.log(`    Original-only (first 10): ${onlyInOrig.slice(0, 10).join(', ')}`);
  }
  if (onlyInNew.length > 0) {
    console.log(`    New-only (first 10): ${onlyInNew.slice(0, 10).join(', ')}`);
  }

  // Position-by-position comparison for the first 50 (all sepolia in both)
  console.log('\n  Position comparison (first 50 are sepolia in both):');
  let posMatch = 0;
  for (let i = 0; i < 50; i++) {
    if (keys6040[i].keyIndex === originalKeys[i].key_index &&
        keys6040[i].address === originalKeys[i].address) {
      posMatch++;
    } else if (i < 5) {
      console.log(`    pos ${i}: 60/40 ki=${keys6040[i].keyIndex} vs orig ki=${originalKeys[i].key_index}`);
    }
  }
  console.log(`  First 50 positions match: ${posMatch}/50`);

  // Save results
  const output2 = `test-idempotency-6040-${Date.now()}.json`;
  fs.writeFileSync(output2, JSON.stringify({
    test: '60+40 split (fresh deposit)',
    deposit_tx_hash: freshDepositTxHash,
    keys: keys6040,
  }, null, 2));
  console.log(`  Saved to ${output2}`);

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`  Test 1 (50+50 re-claim): ${keys5050.length === originalKeys.length &&
    keys5050.every((k, i) => k.keyIndex === originalKeys[i].key_index) ? 'IDENTICAL' : 'DIFFERENT'}`);
  console.log(`  Test 2 (60+40 split): ${keys6040.length} keys returned`);
  console.log(`    Sepolia: ${sep6040.length}, Base: ${base6040.length}`);
  console.log(`    Overlap with original: ${overlap.length}/${Math.max(origKeyIndexSet.size, newKeyIndexSet.size)}`);
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

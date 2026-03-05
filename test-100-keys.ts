/**
 * Test: Deposit 0.1 ETH, claim 100 keys of 0.001 ETH each
 * Verifies all 100 keys reconstruct correctly from shares.
 * Tests all C(5,3)=10 share combinations per key.
 */
import { ethers } from 'ethers';
import { BlackBoxAPI } from './src/api.js';
import { loadConfig } from './src/config.js';
import { WalletManager } from './src/wallet.js';
import { reconstructPrivateKey, createProofMessage, createWithdrawalSignature, verifyKeyMatchesAddress } from './src/crypto.js';

// Set production node URLs
if (!process.env.DKG_NODE_1 && !process.env.DKG_NODE_URLS) {
  for (let i = 1; i <= 5; i++) {
    process.env[`DKG_NODE_${i}`] = `https://theblackbox.network/node${i}`;
  }
}

const TREASURY_ABI = [
  'function deposit(address token, uint256 amount) payable',
  'function withdraw(address token, address recipient, uint256 amount, uint256 merkleRootId, bytes signature, bytes32[] merkleProof, uint256 keyIndex)',
];

const WALLET_NAME = 'test-agent';
const WALLET_PASSWORD = 'test-password-123';

const config = loadConfig();
const api = new BlackBoxAPI(config);
const walletManager = new WalletManager(config.walletStorePath);

// Generate all C(n,k) combinations
function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, k - 1).map(c => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
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
  console.log('=== TEST: 100 keys from 0.1 ETH deposit ===\n');

  const wallet = walletManager.getWallet(WALLET_NAME);
  if (!wallet) { console.error('No test wallet found'); process.exit(1); }
  console.log(`Wallet: ${wallet.address}`);

  const chains = await api.getChains();
  const sepolia = chains.find(c => c.chain_name === 'sepolia');
  if (!sepolia) { console.error('Sepolia not found'); process.exit(1); }

  const provider = new ethers.providers.JsonRpcProvider(sepolia.rpc_url);
  const signer = walletManager.getSigner(WALLET_NAME, WALLET_PASSWORD, provider);

  // Check balance
  const balance = await provider.getBalance(wallet.address);
  console.log(`Sepolia ETH balance: ${ethers.utils.formatEther(balance)}`);
  if (balance.lt(ethers.utils.parseEther('0.11'))) {
    console.error('Need at least 0.11 ETH (0.1 deposit + gas). Please fund the wallet.');
    process.exit(1);
  }

  // Step 1: Deposit 0.1 ETH
  console.log('\n--- Step 1: Deposit 0.1 ETH on Sepolia ---');
  const treasury = new ethers.Contract(sepolia.treasury_address, TREASURY_ABI, signer);
  const depositAmount = ethers.utils.parseEther('0.1');
  const tx = await treasury.deposit(ethers.constants.AddressZero, depositAmount, {
    value: depositAmount,
    gasLimit: 200000,
  });
  console.log(`  TX: ${tx.hash}`);
  await tx.wait();
  console.log('  Deposit confirmed on-chain');

  // Wait for DKG confirmations
  await waitForConfirmations(provider, tx.hash);

  // Step 2: Build 100 withdrawal requests (all 0.001 ETH on different chains to mix it up)
  console.log('\n--- Step 2: Claim 100 keys of 0.001 ETH ---');
  const targetChains = ['sepolia', 'base_sepolia'];
  const withdrawalRequests: Array<{ target_chain: string; token_symbol: string; denomination: string }> = [];
  for (let i = 0; i < 100; i++) {
    withdrawalRequests.push({
      target_chain: targetChains[i % targetChains.length],
      token_symbol: 'ETH',
      denomination: '0.001',
    });
  }
  console.log(`  Requesting ${withdrawalRequests.length} keys (alternating sepolia/base_sepolia)`);

  const timestamp = Math.floor(Date.now() / 1000);
  const proofMessage = createProofMessage(tx.hash, 'sepolia', withdrawalRequests, signer.address, timestamp);
  const signature = await signer.signMessage(proofMessage);
  const spendRequestId = ethers.utils.id(`${tx.hash}:sepolia:0:${timestamp}`);

  console.log('  Sending keyshare request to all 5 nodes...');
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

  const successful = results.filter(r => r.success && r.keyshares?.length);
  const failed = results.filter(r => !r.success);
  console.log(`  Nodes responded: ${successful.length} success, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log(`  Failures: ${failed.map(f => f.error).join('; ').slice(0, 300)}`);
  }

  if (successful.length < 3) {
    console.error('  Not enough nodes responded (need at least 3)');
    process.exit(1);
  }

  const threshold = successful[0]?.threshold || 3;
  const numNodes = successful.length;
  console.log(`  Threshold: ${threshold}, Nodes with shares: ${numNodes}`);
  console.log(`  Keyshares per node: ${successful[0]?.keyshares?.length}`);
  console.log(`  depositAmount: ${successful[0]?.depositAmount}, remaining: ${successful[0]?.remainingDeposit}`);

  // Step 3: Reconstruct all 100 keys and test all C(numNodes, threshold) combinations
  console.log(`\n--- Step 3: Reconstruct 100 keys, test all C(${numNodes},${threshold}) = ${combinations(Array.from({length: numNodes}, (_,i) => i), threshold).length} share combos ---`);

  const nodeIndices = Array.from({ length: numNodes }, (_, i) => i);
  const allCombos = combinations(nodeIndices, threshold);
  console.log(`  Share combinations to test per key: ${allCombos.length}`);

  let totalKeysVerified = 0;
  let totalCombosTested = 0;
  let failedKeys: number[] = [];
  let failedCombos: Array<{ keyIdx: number; combo: number[]; error: string }> = [];

  for (let keyIdx = 0; keyIdx < 100; keyIdx++) {
    // Collect all shares for this key across nodes
    const sharesForKey: Array<{ nodeIdx: number; nodeId: number; shareId: string; shareValue: string; address: string; keyIndex: number; merkleProof: string[]; merkleRootId: number }> = [];

    for (let ni = 0; ni < numNodes; ni++) {
      const nodeResult = successful[ni];
      const ks = nodeResult.keyshares?.[keyIdx];
      if (ks) {
        sharesForKey.push({
          nodeIdx: ni,
          nodeId: nodeResult.nodeId!,
          shareId: ks.share_id,
          shareValue: ks.share_value,
          address: ks.address,
          keyIndex: ks.key_index,
          merkleProof: ks.merkle_proof,
          merkleRootId: ks.merkle_root_id,
        });
      }
    }

    const expectedAddress = sharesForKey[0]?.address;
    const expectedKeyIndex = sharesForKey[0]?.keyIndex;

    // Check all nodes agree on address and key_index
    const addressMismatch = sharesForKey.some(s => s.address !== expectedAddress);
    const keyIndexMismatch = sharesForKey.some(s => s.keyIndex !== expectedKeyIndex);
    if (addressMismatch || keyIndexMismatch) {
      console.log(`  Key ${keyIdx}: ADDRESS/KEYINDEX MISMATCH across nodes!`);
      failedKeys.push(keyIdx);
      continue;
    }

    // Test default combo first (first 3 nodes)
    let defaultComboWorked = false;
    let anyComboWorked = false;
    let comboResults: Array<{ combo: number[]; success: boolean; error?: string }> = [];

    for (const combo of allCombos) {
      const shares = combo.map(ni => ({
        shareId: sharesForKey[ni].shareId,
        shareValue: sharesForKey[ni].shareValue,
      }));

      try {
        const { privateKeyHex } = reconstructPrivateKey(shares, threshold);
        const matches = verifyKeyMatchesAddress(privateKeyHex, expectedAddress);

        if (matches) {
          anyComboWorked = true;
          if (combo[0] === 0 && combo[1] === 1 && combo[2] === 2) {
            defaultComboWorked = true;
          }
          comboResults.push({ combo, success: true });
        } else {
          comboResults.push({ combo, success: false, error: 'address mismatch' });
          failedCombos.push({ keyIdx, combo, error: 'address mismatch' });
        }
      } catch (err: any) {
        comboResults.push({ combo, success: false, error: err.message });
        failedCombos.push({ keyIdx, combo, error: err.message });
      }

      totalCombosTested++;
    }

    const successCount = comboResults.filter(r => r.success).length;
    const failCount = comboResults.filter(r => !r.success).length;

    if (anyComboWorked) {
      totalKeysVerified++;
    } else {
      failedKeys.push(keyIdx);
    }

    // Log progress every 10 keys, or if there's an issue
    if (keyIdx % 10 === 0 || failCount > 0 || !defaultComboWorked) {
      const defaultStatus = defaultComboWorked ? 'OK' : 'FAIL';
      console.log(`  Key ${keyIdx}: addr=${expectedAddress?.slice(0, 10)}... keyIndex=${expectedKeyIndex} combos=${successCount}/${allCombos.length} default=[0,1,2]=${defaultStatus}`);
      if (failCount > 0) {
        const failedOnes = comboResults.filter(r => !r.success);
        for (const f of failedOnes) {
          const nodeIds = f.combo.map(ni => successful[ni].nodeId);
          console.log(`    FAILED combo nodeIdx=${JSON.stringify(f.combo)} nodeIds=${JSON.stringify(nodeIds)}: ${f.error}`);
        }
      }
    }
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`  Total keys: 100`);
  console.log(`  Keys verified (at least 1 combo works): ${totalKeysVerified}/100`);
  console.log(`  Keys failed (no combo works): ${failedKeys.length}`);
  if (failedKeys.length > 0) {
    console.log(`  Failed key indices: ${failedKeys.join(', ')}`);
  }
  console.log(`  Total share combinations tested: ${totalCombosTested}`);
  console.log(`  Combinations that worked: ${totalCombosTested - failedCombos.length}`);
  console.log(`  Combinations that failed: ${failedCombos.length}`);
  if (failedCombos.length > 0) {
    console.log(`  Failed combos (first 10):`);
    for (const fc of failedCombos.slice(0, 10)) {
      const nodeIds = fc.combo.map(ni => successful[ni].nodeId);
      console.log(`    Key ${fc.keyIdx}, nodeIdx=${JSON.stringify(fc.combo)} nodeIds=${JSON.stringify(nodeIds)}: ${fc.error}`);
    }
  }

  if (totalKeysVerified === 100 && failedCombos.length === 0) {
    console.log('\n  ALL 100 KEYS VERIFIED WITH ALL SHARE COMBINATIONS');
  } else if (totalKeysVerified === 100) {
    console.log('\n  ALL 100 KEYS VERIFIED (some combos failed but at least 1 works per key)');
  } else {
    console.log('\n  SOME KEYS FAILED VERIFICATION');
  }
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

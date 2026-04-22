/**
 * Edge case tests for InterNull MCP — exploring protocol boundaries
 * Tests: double-spend, invalid denomination, wrong chain, native relay,
 *        swap quotes, denomination discovery, partial claims, occurrence_offset
 */
import { ethers } from 'ethers';
import { InterNullAPI } from './src/api.js';
import { InterNullConfig, loadConfig } from './src/config.js';
import { WalletManager } from './src/wallet.js';
import { reconstructPrivateKey, createProofMessage, createWithdrawalSignature, createRelayWithdrawalSignature, verifyKeyMatchesAddress } from './src/crypto.js';

const TREASURY_ABI = [
  'function deposit(address token, uint256 amount) payable',
  'function withdraw(address token, address recipient, uint256 amount, uint256 merkleRootId, bytes signature, bytes32[] merkleProof, uint256 keyIndex)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const WALLET_NAME = 'test-agent';
const WALLET_PASSWORD = 'test-password-123';

// Set production node URLs if not already configured
if (!process.env.DKG_NODE_1 && !process.env.DKG_NODE_URLS) {
  for (let i = 1; i <= 5; i++) {
    process.env[`DKG_NODE_${i}`] = `https://theblackbox.network/node${i}`;
  }
}

const config = loadConfig();
const api = new InterNullAPI(config);
const walletManager = new WalletManager(config.walletStorePath);

interface ChainInfo {
  chain_name: string;
  chain_id: number;
  chain_type: string;
  rpc_url: string;
  treasury_address: string;
  native_currency: string;
  supported_tokens: string[];
}

let chains: ChainInfo[] = [];

function findChain(name: string): ChainInfo {
  const c = chains.find(c => c.chain_name === name);
  if (!c) throw new Error(`Chain "${name}" not found`);
  return c;
}

async function waitForConfirmations(provider: ethers.providers.Provider, txHash: string, required = 2) {
  console.log(`  Waiting for ${required} confirmations...`);
  for (let i = 0; i < 60; i++) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) {
      const current = await provider.getBlockNumber();
      const confs = current - receipt.blockNumber;
      if (confs >= required) { console.log(`  Got ${confs} confirmations`); return; }
      console.log(`  ${confs}/${required} confirmations...`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Timed out waiting for confirmations');
}

async function depositNative(chainName: string, denomination: string): Promise<string> {
  const chain = findChain(chainName);
  const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
  const signer = walletManager.getSigner(WALLET_NAME, WALLET_PASSWORD, provider);
  const treasury = new ethers.Contract(chain.treasury_address, TREASURY_ABI, signer);
  const amount = ethers.utils.parseEther(denomination);
  console.log(`  Depositing ${denomination} ${chain.native_currency} (native) on ${chainName}`);
  const tx = await treasury.deposit(ethers.constants.AddressZero, amount, { value: amount, gasLimit: 200000 });
  console.log(`  TX: ${tx.hash}`);
  await tx.wait();
  return tx.hash;
}

async function depositERC20(chainName: string, denomination: string, tokenSymbol: string): Promise<string> {
  const chain = findChain(chainName);
  const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
  const signer = walletManager.getSigner(WALLET_NAME, WALLET_PASSWORD, provider);
  const treasury = new ethers.Contract(chain.treasury_address, TREASURY_ABI, signer);

  const tokens = await api.getTokens(chainName);
  const token = tokens.find((t: any) => (t.Symbol || t.symbol) === tokenSymbol);
  if (!token) throw new Error(`Token ${tokenSymbol} not found on ${chainName}`);
  const tokenAddr = token.Address || token.address;
  const decimals = token.Decimals || token.decimals || 6;
  const amount = ethers.utils.parseUnits(denomination, decimals);

  const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  const allowance = await erc20.allowance(signer.address, chain.treasury_address);
  if (allowance.lt(amount)) {
    console.log(`  Approving ${tokenSymbol}...`);
    const approveTx = await erc20.approve(chain.treasury_address, ethers.constants.MaxUint256);
    await approveTx.wait();
  }

  console.log(`  Depositing ${denomination} ${tokenSymbol} (ERC20) on ${chainName}`);
  const tx = await treasury.deposit(tokenAddr, amount, { gasLimit: 300000 });
  console.log(`  TX: ${tx.hash}`);
  await tx.wait();
  return tx.hash;
}

async function claimKeys(
  depositTxHash: string,
  sourceChain: string,
  withdrawalRequests: Array<{ target_chain: string; token_symbol: string; denomination: string }>,
  occurrenceOffset = 0,
): Promise<any> {
  const chain = findChain(sourceChain);
  const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
  const signer = walletManager.getSigner(WALLET_NAME, WALLET_PASSWORD, provider);
  await waitForConfirmations(provider, depositTxHash);

  const timestamp = Math.floor(Date.now() / 1000);
  const proofMessage = createProofMessage(depositTxHash, sourceChain, withdrawalRequests, signer.address, timestamp);
  const signature = await signer.signMessage(proofMessage);
  const spendRequestId = ethers.utils.id(`${depositTxHash}:${sourceChain}:${occurrenceOffset}:${timestamp}`);

  const results = await api.requestKeyshares({
    depositTxHash,
    sourceChain,
    withdrawalRequests,
    userAddress: signer.address,
    signature,
    timestamp,
    occurrenceOffset,
    spendRequestId,
  });

  const successful = results.filter(r => r.success && r.keyshares?.length);
  const failed = results.filter(r => !r.success);

  return {
    successful,
    failed,
    threshold: successful[0]?.threshold || 3,
    depositAmount: successful[0]?.depositAmount,
    remainingDeposit: successful[0]?.remainingDeposit,
    errors: failed.map(f => f.error).join('; '),
  };
}

function reconstructFromShares(successful: any[], keyIdx: number, threshold: number) {
  const sharesForKey = successful.map(r => {
    const ks = r.keyshares![keyIdx];
    return {
      nodeId: r.nodeId!,
      shareId: ks.share_id,
      shareValue: ks.share_value,
      keyIndex: ks.key_index,
      address: ks.address,
      merkleProof: ks.merkle_proof,
      merkleRootId: ks.merkle_root_id,
      tokenAddress: ks.token_address,
      tokenDecimals: ks.token_decimals,
    };
  });

  const sharesToUse = sharesForKey.slice(0, threshold);
  const { privateKeyHex } = reconstructPrivateKey(sharesToUse, threshold);
  const matches = verifyKeyMatchesAddress(privateKeyHex, sharesForKey[0].address);
  return {
    privateKey: privateKeyHex,
    address: sharesForKey[0].address,
    keyIndex: sharesForKey[0].keyIndex,
    merkleProof: sharesForKey[0].merkleProof,
    merkleRootId: sharesForKey[0].merkleRootId,
    tokenAddress: sharesForKey[0].tokenAddress,
    tokenDecimals: sharesForKey[0].tokenDecimals,
    verified: matches,
  };
}

// ==================== EDGE CASE TESTS ====================

async function test_discovery_apis() {
  console.log('\n=== EDGE: Discovery API exploration ===');

  // 1. Chains
  const chainsData = await api.getChains();
  console.log(`  Chains (${chainsData.length}):`);
  for (const c of chainsData) {
    console.log(`    ${c.chain_name} (id=${c.chain_id}, type=${c.chain_type}, native=${c.native_currency})`);
    console.log(`      treasury=${c.treasury_address}`);
    console.log(`      tokens=${(c.supported_tokens || []).join(', ')}`);
  }

  // 2. Token details per chain
  for (const c of chainsData) {
    const tokens = await api.getTokens(c.chain_name);
    console.log(`  Tokens on ${c.chain_name}:`);
    for (const t of tokens) {
      console.log(`    ${t.Symbol || t.symbol}: addr=${t.Address || t.address}, decimals=${t.Decimals || t.decimals}`);
    }
  }

  // 3. Denominations
  const roots = await api.getMerkleRoots();
  console.log(`  Merkle roots (${roots.length}):`);
  const denomByChain: Record<string, string[]> = {};
  for (const r of roots) {
    const key = r.chain_name;
    if (!denomByChain[key]) denomByChain[key] = [];
    denomByChain[key].push(`${r.denomination} ${r.token_symbol} (id=${r.merkle_root_id_on_chain})`);
  }
  for (const [chain, denoms] of Object.entries(denomByChain)) {
    console.log(`    ${chain}: ${denoms.join(', ')}`);
  }

  // 4. Token mappings
  const mappingsRaw = await api.getTokenMappings();
  const mappings = Array.isArray(mappingsRaw) ? mappingsRaw : [];
  console.log(`  Token mappings (${mappings.length}): ${JSON.stringify(mappingsRaw).slice(0, 300)}`);
  for (const m of mappings) {
    console.log(`    ${JSON.stringify(m).slice(0, 150)}`);
  }

  // 5. Relay info
  const relayInfo = await api.getRelayInfo();
  console.log(`  Relay info: ${JSON.stringify(relayInfo).slice(0, 300)}`);

  // 6. Swap quotes (try USDC on sepolia -> base_sepolia)
  console.log('\n  Swap quote test:');
  try {
    const quote = await api.getSwapQuote('USDC_sepolia', 'USDC_base_sepolia', '1000000');
    console.log(`    Quote: ${JSON.stringify(quote).slice(0, 300)}`);
  } catch (err: any) {
    console.log(`    Swap quote error: ${err.message.slice(0, 200)}`);
  }

  // 7. Health
  const health = await api.getHealth();
  console.log(`  Health: ${JSON.stringify(health).slice(0, 200)}`);

  // 8. Leaderboard
  const lb = await api.getLeaderboard(5);
  console.log(`  Leaderboard (top 5): ${JSON.stringify(lb).slice(0, 300)}`);

  console.log('  DISCOVERY DONE');
}

async function test_invalid_denomination() {
  console.log('\n=== EDGE: Invalid denomination claim ===');
  console.log('  Deposit 1 USDC on base_sepolia, try to claim with denomination "0.5" (probably not registered)');

  try {
    const txHash = await depositERC20('base_sepolia', '1', 'USDC');
    const result = await claimKeys(txHash, 'base_sepolia', [
      { target_chain: 'base_sepolia', token_symbol: 'USDC', denomination: '0.5' },
    ]);

    if (result.failed.length > 0) {
      console.log(`  Expected failure: ${result.errors.slice(0, 300)}`);
      console.log('  PASSED (invalid denomination rejected)');
    } else {
      console.log(`  Surprisingly succeeded! ${result.successful.length} nodes responded`);
      console.log(`  depositAmount=${result.depositAmount}, remaining=${result.remainingDeposit}`);
      console.log('  UNEXPECTED - denomination "0.5" was accepted');
    }
  } catch (err: any) {
    console.log(`  Error: ${err.message.slice(0, 300)}`);
    console.log('  PASSED (error thrown for invalid denomination)');
  }
}

async function test_overclaim() {
  console.log('\n=== EDGE: Overclaim — deposit 1 USDC, try to claim 2 USDC ===');

  try {
    const txHash = await depositERC20('base_sepolia', '1', 'USDC');
    const result = await claimKeys(txHash, 'base_sepolia', [
      { target_chain: 'base_sepolia', token_symbol: 'USDC', denomination: '2' },
    ]);

    if (result.failed.length > 0) {
      console.log(`  Expected failure: ${result.errors.slice(0, 300)}`);
      console.log('  PASSED (overclaim rejected)');
    } else {
      console.log(`  Surprisingly succeeded! depositAmount=${result.depositAmount}, remaining=${result.remainingDeposit}`);
      console.log('  CHECK: remaining should be negative or error');
    }
  } catch (err: any) {
    console.log(`  Error: ${err.message.slice(0, 300)}`);
    console.log('  PASSED (overclaim throws error)');
  }
}

async function test_double_spend() {
  console.log('\n=== EDGE: Double-spend — claim same deposit twice ===');

  const txHash = await depositERC20('base_sepolia', '1', 'USDC');
  console.log(`  Deposit: ${txHash}`);

  // First claim
  console.log('  First claim...');
  const result1 = await claimKeys(txHash, 'base_sepolia', [
    { target_chain: 'base_sepolia', token_symbol: 'USDC', denomination: '1' },
  ]);

  if (result1.successful.length >= result1.threshold) {
    console.log(`  First claim OK: ${result1.successful.length} nodes`);
    const key1 = reconstructFromShares(result1.successful, 0, result1.threshold);
    console.log(`  Key1: address=${key1.address}, verified=${key1.verified}`);

    // Second claim — same deposit, same denomination
    console.log('  Second claim (same deposit, same denomination)...');
    try {
      const result2 = await claimKeys(txHash, 'base_sepolia', [
        { target_chain: 'base_sepolia', token_symbol: 'USDC', denomination: '1' },
      ]);

      if (result2.failed.length > 0 && result2.successful.length < result2.threshold) {
        console.log(`  Second claim rejected: ${result2.errors.slice(0, 300)}`);
        console.log('  RESULT: Backend prevented re-claim');
      } else {
        const key2 = reconstructFromShares(result2.successful, 0, result2.threshold);
        console.log(`  Second claim SUCCEEDED`);
        console.log(`  Key1: address=${key1.address}, keyIndex=${key1.keyIndex}, merkleRootId=${key1.merkleRootId}`);
        console.log(`  Key2: address=${key2.address}, keyIndex=${key2.keyIndex}, merkleRootId=${key2.merkleRootId}`);
        console.log(`  Same key_index? ${key1.keyIndex === key2.keyIndex}`);
        console.log(`  Same address? ${key1.address === key2.address}`);
        console.log(`  Same private key? ${key1.privateKey === key2.privateKey}`);
        if (key1.keyIndex === key2.keyIndex) {
          console.log('  RESULT: Backend returned SAME key index (idempotent) — on-chain nullifier is the guard');
        } else {
          console.log('  RESULT: Backend returned DIFFERENT key index — potential double-spend vulnerability!');
        }
      }
    } catch (err: any) {
      console.log(`  Second claim error: ${err.message.slice(0, 300)}`);
    }

    // Now try to withdraw the first key to confirm it works
    console.log('  Withdrawing first key...');
    try {
      const chain = findChain('base_sepolia');
      const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
      const wallet = walletManager.getWallet(WALLET_NAME)!;
      const tokens = await api.getTokens('base_sepolia');
      const usdcToken = tokens.find((t: any) => (t.Symbol || t.symbol) === 'USDC');
      const tokenAddr = key1.tokenAddress || usdcToken?.Address || usdcToken?.address;
      const decimals = key1.tokenDecimals || 6;
      const amount = ethers.utils.parseUnits('1', decimals);
      const network = await provider.getNetwork();

      const sig = await createWithdrawalSignature(key1.privateKey, wallet.address, tokenAddr, amount, key1.merkleRootId, key1.keyIndex, network.chainId);
      const fundedSigner = walletManager.getSigner(WALLET_NAME, WALLET_PASSWORD, provider);
      const treasury = new ethers.Contract(chain.treasury_address, TREASURY_ABI, fundedSigner);
      const proof = key1.merkleProof.map((p: string) => p.startsWith('0x') ? p : '0x' + p);

      const tx = await treasury.withdraw(tokenAddr, wallet.address, amount, key1.merkleRootId, sig, proof, key1.keyIndex, { gasLimit: 500000 });
      console.log(`  Withdraw TX: ${tx.hash}`);
      await tx.wait();
      console.log('  First withdrawal SUCCEEDED');

      // Try to withdraw same key again (on-chain nullifier check)
      console.log('  Attempting second withdrawal with same key (should revert)...');
      try {
        const sig2 = await createWithdrawalSignature(key1.privateKey, wallet.address, tokenAddr, amount, key1.merkleRootId, key1.keyIndex, network.chainId);
        const tx2 = await treasury.withdraw(tokenAddr, wallet.address, amount, key1.merkleRootId, sig2, proof, key1.keyIndex, { gasLimit: 500000 });
        await tx2.wait();
        console.log('  FAIL: Second withdrawal succeeded (no nullifier!)');
      } catch (err: any) {
        console.log(`  Second withdrawal reverted: ${err.message.slice(0, 200)}`);
        console.log('  PASSED (on-chain nullifier prevents double withdrawal)');
      }
    } catch (err: any) {
      console.log(`  Withdrawal error: ${err.message.slice(0, 200)}`);
    }
  } else {
    console.log(`  First claim failed: ${result1.errors.slice(0, 300)}`);
  }
}

async function test_wrong_chain_withdrawal() {
  console.log('\n=== EDGE: Claim for chain A, attempt withdrawal on chain B ===');

  // Deposit on base_sepolia, claim for base_sepolia, try to withdraw on sepolia
  const txHash = await depositERC20('base_sepolia', '1', 'USDC');
  console.log(`  Deposit: ${txHash}`);

  const result = await claimKeys(txHash, 'base_sepolia', [
    { target_chain: 'base_sepolia', token_symbol: 'USDC', denomination: '1' },
  ]);

  if (result.successful.length < result.threshold) {
    console.log(`  Claim failed: ${result.errors}`);
    return;
  }

  const key = reconstructFromShares(result.successful, 0, result.threshold);
  console.log(`  Key: address=${key.address}, verified=${key.verified}`);
  console.log(`  Key was claimed for base_sepolia. Attempting withdrawal on sepolia...`);

  try {
    const wrongChain = findChain('sepolia');
    const provider = new ethers.providers.JsonRpcProvider(wrongChain.rpc_url);
    const wallet = walletManager.getWallet(WALLET_NAME)!;
    const network = await provider.getNetwork();

    const tokens = await api.getTokens('sepolia');
    const usdcToken = tokens.find((t: any) => (t.Symbol || t.symbol) === 'USDC');
    const tokenAddr = usdcToken?.Address || usdcToken?.address;
    const amount = ethers.utils.parseUnits('1', 6);

    const sig = await createWithdrawalSignature(key.privateKey, wallet.address, tokenAddr, amount, key.merkleRootId, key.keyIndex, network.chainId);
    const fundedSigner = walletManager.getSigner(WALLET_NAME, WALLET_PASSWORD, provider);
    const treasury = new ethers.Contract(wrongChain.treasury_address, TREASURY_ABI, fundedSigner);
    const proof = key.merkleProof.map((p: string) => p.startsWith('0x') ? p : '0x' + p);

    const tx = await treasury.withdraw(tokenAddr, wallet.address, amount, key.merkleRootId, sig, proof, key.keyIndex, { gasLimit: 500000 });
    await tx.wait();
    console.log('  FAIL: Wrong-chain withdrawal succeeded!');
  } catch (err: any) {
    console.log(`  Wrong-chain withdrawal reverted: ${err.message.slice(0, 200)}`);
    console.log('  PASSED (merkle proof invalid on wrong chain OR signature has wrong chainId)');
  }
}

async function test_native_eth_relay() {
  console.log('\n=== EDGE: Native ETH relay withdrawal ===');
  console.log('  Deposit 0.01 ETH on sepolia, claim for base_sepolia, relay withdraw');

  try {
    const txHash = await depositNative('sepolia', '0.01');
    console.log(`  Deposit: ${txHash}`);

    const result = await claimKeys(txHash, 'sepolia', [
      { target_chain: 'base_sepolia', token_symbol: 'ETH', denomination: '0.01' },
    ]);

    if (result.successful.length < result.threshold) {
      console.log(`  Claim failed: ${result.errors}`);
      return;
    }

    const key = reconstructFromShares(result.successful, 0, result.threshold);
    console.log(`  Key: address=${key.address}, verified=${key.verified}`);

    // Relay withdraw (native ETH — fee deducted from amount)
    const chain = findChain('base_sepolia');
    const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
    const network = await provider.getNetwork();
    const wallet = walletManager.getWallet(WALLET_NAME)!;
    const amount = ethers.utils.parseEther('0.01');

    // maxRelayerFee — for native ETH, must cover protocol fee + gas
    // 50bps of 0.01 ETH = 0.00005 ETH, plus gas. Set to 0.001 ETH (10%)
    const maxRelayerFee = ethers.utils.parseEther('0.001');

    const relayInfoResp = await api.getRelayInfo();
    const relayInfo = relayInfoResp.info || relayInfoResp;
    const relayerAddress = relayInfo.evm_relayer_address || ethers.constants.AddressZero;
    console.log(`  Relayer address: ${relayerAddress}`);

    const sig = await createRelayWithdrawalSignature(
      key.privateKey, wallet.address, ethers.constants.AddressZero, amount,
      key.merkleRootId, key.keyIndex, network.chainId, relayerAddress, maxRelayerFee,
    );

    const proof = key.merkleProof.map((p: string) => p.startsWith('0x') ? p : '0x' + p);

    const relayResult = await api.relayWithdraw({
      chain: 'base_sepolia',
      chainType: 'evm',
      recipient: wallet.address,
      amount: amount.toString(),
      signature: sig,
      merkleProof: proof,
      merkleRootId: key.merkleRootId,
      keyIndex: key.keyIndex,
      maxRelayerFee: maxRelayerFee.toString(),
    });

    console.log(`  Relay result: ${JSON.stringify(relayResult).slice(0, 300)}`);

    if (relayResult.job_id) {
      console.log(`  Polling relay job ${relayResult.job_id}...`);
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 10000));
        const status = await api.getRelayStatus(relayResult.job_id);
        console.log(`  Status: ${JSON.stringify(status).slice(0, 150)}`);
        if (status.status === 'completed' || status.status === 'confirmed') {
          console.log('  PASSED (native ETH relay withdrawal)');
          return;
        }
        if (status.status === 'failed') {
          console.log(`  Relay FAILED: ${JSON.stringify(status)}`);
          return;
        }
      }
      console.log('  Relay still pending');
    }
  } catch (err: any) {
    console.log(`  Error: ${err.message.slice(0, 300)}`);
  }
}

async function test_partial_claims_with_offset() {
  console.log('\n=== EDGE: Partial claims with occurrence_offset ===');
  console.log('  Deposit 2 USDC, claim 1 USDC first, then claim another 1 USDC with offset');

  try {
    const txHash = await depositERC20('base_sepolia', '2', 'USDC');
    console.log(`  Deposit: ${txHash}`);

    // First claim: 1 USDC
    console.log('  First claim: 1 USDC...');
    const result1 = await claimKeys(txHash, 'base_sepolia', [
      { target_chain: 'base_sepolia', token_symbol: 'USDC', denomination: '1' },
    ], 0);

    console.log(`  First claim: ${result1.successful.length} success, ${result1.failed.length} failed`);
    console.log(`  depositAmount=${result1.depositAmount}, remaining=${result1.remainingDeposit}`);
    console.log(`  Errors: ${result1.errors.slice(0, 300)}`);

    if (result1.successful.length >= result1.threshold) {
      const key1 = reconstructFromShares(result1.successful, 0, result1.threshold);
      console.log(`  Key1: verified=${key1.verified}`);

      // Second claim: 1 USDC with offset=1
      console.log('  Second claim: 1 USDC with occurrence_offset=1...');
      const result2 = await claimKeys(txHash, 'base_sepolia', [
        { target_chain: 'sepolia', token_symbol: 'USDC', denomination: '1' },
      ], 1);

      console.log(`  Second claim: ${result2.successful.length} success, ${result2.failed.length} failed`);
      console.log(`  depositAmount=${result2.depositAmount}, remaining=${result2.remainingDeposit}`);
      console.log(`  Errors: ${result2.errors.slice(0, 300)}`);

      if (result2.successful.length >= result2.threshold) {
        const key2 = reconstructFromShares(result2.successful, 0, result2.threshold);
        console.log(`  Key2: verified=${key2.verified}`);
        console.log(`  Key1.address=${key1.address}`);
        console.log(`  Key2.address=${key2.address}`);
        console.log(`  Keys are different: ${key1.address !== key2.address}`);
        console.log('  PASSED (partial claims with offset work)');
      } else {
        console.log('  Second claim failed — offset may not work this way');
      }
    } else {
      console.log('  First claim failed');
    }
  } catch (err: any) {
    console.log(`  Error: ${err.message.slice(0, 300)}`);
  }
}

async function test_wrong_signer() {
  console.log('\n=== EDGE: Claim with wrong signer (not the depositor) ===');

  const txHash = await depositERC20('base_sepolia', '1', 'USDC');
  console.log(`  Deposit: ${txHash}`);

  // Generate a random wallet (not the depositor)
  const randomWallet = ethers.Wallet.createRandom();
  console.log(`  Random (non-depositor) address: ${randomWallet.address}`);

  const chain = findChain('base_sepolia');
  const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
  await waitForConfirmations(provider, txHash);

  const timestamp = Math.floor(Date.now() / 1000);
  const withdrawalRequests = [{ target_chain: 'base_sepolia', token_symbol: 'USDC', denomination: '1' }];
  const proofMessage = createProofMessage(txHash, 'base_sepolia', withdrawalRequests, randomWallet.address, timestamp);
  const signature = await randomWallet.signMessage(proofMessage);
  const spendRequestId = ethers.utils.id(`${txHash}:base_sepolia:0:${timestamp}`);

  const results = await api.requestKeyshares({
    depositTxHash: txHash,
    sourceChain: 'base_sepolia',
    withdrawalRequests,
    userAddress: randomWallet.address,
    signature,
    timestamp,
    occurrenceOffset: 0,
    spendRequestId,
  });

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  console.log(`  Results: ${successful.length} success, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log(`  Errors: ${failed.map(f => f.error).join('; ').slice(0, 300)}`);
    console.log('  PASSED (wrong signer rejected)');
  } else {
    console.log('  WARNING: Wrong signer was accepted! This may be a security issue.');
  }
}

async function test_expired_timestamp() {
  console.log('\n=== EDGE: Claim with very old timestamp ===');

  const txHash = await depositERC20('base_sepolia', '1', 'USDC');
  console.log(`  Deposit: ${txHash}`);

  const chain = findChain('base_sepolia');
  const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
  const signer = walletManager.getSigner(WALLET_NAME, WALLET_PASSWORD, provider);
  await waitForConfirmations(provider, txHash);

  // Use a timestamp from 1 hour ago
  const oldTimestamp = Math.floor(Date.now() / 1000) - 3600;
  const withdrawalRequests = [{ target_chain: 'base_sepolia', token_symbol: 'USDC', denomination: '1' }];
  const proofMessage = createProofMessage(txHash, 'base_sepolia', withdrawalRequests, signer.address, oldTimestamp);
  const signature = await signer.signMessage(proofMessage);
  const spendRequestId = ethers.utils.id(`${txHash}:base_sepolia:0:${oldTimestamp}`);

  const results = await api.requestKeyshares({
    depositTxHash: txHash,
    sourceChain: 'base_sepolia',
    withdrawalRequests,
    userAddress: signer.address,
    signature,
    timestamp: oldTimestamp,
    occurrenceOffset: 0,
    spendRequestId,
  });

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  console.log(`  Results: ${successful.length} success, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log(`  Errors: ${failed.map(f => f.error).join('; ').slice(0, 200)}`);
    console.log('  Result: Old timestamp was rejected (has expiry)');
  } else {
    console.log('  Result: Old timestamp accepted (no expiry check on backend)');
  }
}

async function test_mismatched_token_claim() {
  console.log('\n=== EDGE: Deposit USDC, claim as ETH ===');

  const txHash = await depositERC20('base_sepolia', '1', 'USDC');
  console.log(`  Deposit: ${txHash}`);

  try {
    const result = await claimKeys(txHash, 'base_sepolia', [
      { target_chain: 'base_sepolia', token_symbol: 'ETH', denomination: '1' },
    ]);

    if (result.failed.length > 0) {
      console.log(`  Errors: ${result.errors.slice(0, 300)}`);
      console.log('  PASSED (mismatched token claim rejected)');
    } else {
      console.log(`  Succeeded! depositAmount=${result.depositAmount}`);
      console.log('  INTERESTING: Backend allows cross-token claiming');
    }
  } catch (err: any) {
    console.log(`  Error: ${err.message.slice(0, 300)}`);
  }
}

// ==================== MAIN ====================
async function main() {
  console.log('=== EDGE CASE TESTS ===');

  const wallet = walletManager.getWallet(WALLET_NAME);
  if (!wallet) {
    console.error('No test wallet found. Run test-e2e.ts first.');
    process.exit(1);
  }
  console.log(`Using wallet: ${wallet.address}`);

  chains = await api.getChains();
  console.log(`Loaded ${chains.length} chains`);

  // Parse CLI args for which tests to run
  const args = process.argv.slice(2);
  const runAll = args.length === 0 || args.includes('all');

  // Non-spending tests first
  if (runAll || args.includes('discovery'))     await test_discovery_apis();

  // Tests that spend real tokens (1-2 USDC each)
  if (runAll || args.includes('invalid-denom')) await test_invalid_denomination();
  if (runAll || args.includes('overclaim'))     await test_overclaim();
  if (runAll || args.includes('double-spend'))  await test_double_spend();
  if (runAll || args.includes('wrong-chain'))   await test_wrong_chain_withdrawal();
  if (runAll || args.includes('wrong-signer'))  await test_wrong_signer();
  if (runAll || args.includes('old-timestamp')) await test_expired_timestamp();
  if (runAll || args.includes('wrong-token'))   await test_mismatched_token_claim();
  if (runAll || args.includes('offset'))        await test_partial_claims_with_offset();
  if (runAll || args.includes('native-relay'))  await test_native_eth_relay();

  console.log('\n=== ALL EDGE CASE TESTS DONE ===');
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

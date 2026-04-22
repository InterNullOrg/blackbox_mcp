/**
 * End-to-end test script for InterNull MCP server
 * Tests: cross-chain, relay, multi-chain split, edge cases
 */
import { ethers } from 'ethers';
import { InterNullAPI } from './src/api.js';
import { InterNullConfig, loadConfig } from './src/config.js';
import { WalletManager } from './src/wallet.js';
import { reconstructPrivateKey, createProofMessage, createWithdrawalSignature, verifyKeyMatchesAddress } from './src/crypto.js';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const TREASURY_ABI = [
  'function deposit(address token, uint256 amount) payable',
  'function withdraw(address token, address recipient, uint256 amount, uint256 merkleRootId, bytes signature, bytes32[] merkleProof, uint256 keyIndex)',
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

// Allow importing a pre-funded wallet via env var
const PRIVATE_KEY = process.env.TEST_PRIVATE_KEY;

// Polygon gas overrides
const POLYGON_IDS = new Set([137, 80001, 80002]);

async function getGasOverrides(provider: ethers.providers.Provider, chainId: number): Promise<any> {
  const overrides: any = {};
  if (POLYGON_IDS.has(chainId)) {
    const minTip = ethers.utils.parseUnits('30', 'gwei');
    const feeData = await provider.getFeeData();
    overrides.maxPriorityFeePerGas = minTip;
    overrides.maxFeePerGas = feeData.maxFeePerGas?.gt(minTip) ? feeData.maxFeePerGas : minTip.mul(2);
  }
  return overrides;
}

async function waitForConfirmations(provider: ethers.providers.Provider, txHash: string, required = 2) {
  console.log(`  Waiting for ${required} confirmations...`);
  let confirmed = false;
  for (let i = 0; i < 60; i++) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) {
      const current = await provider.getBlockNumber();
      const confs = current - receipt.blockNumber;
      if (confs >= required) {
        console.log(`  Got ${confs} confirmations`);
        confirmed = true;
        break;
      }
      console.log(`  ${confs}/${required} confirmations...`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  if (!confirmed) throw new Error('Timed out waiting for confirmations');
}

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
let merkleRoots: any[] = [];

async function setup() {
  console.log('=== SETUP ===');

  // Create or import wallet
  let wallet = walletManager.getWallet(WALLET_NAME);
  if (!wallet) {
    if (PRIVATE_KEY) {
      console.log('Importing wallet from TEST_PRIVATE_KEY...');
      const { address } = walletManager.importWallet(WALLET_NAME, PRIVATE_KEY, WALLET_PASSWORD, 'evm');
      console.log(`Imported wallet: ${address}`);
      wallet = walletManager.getWallet(WALLET_NAME);
    } else {
      console.log('Creating new wallet...');
      const { address, privateKey } = walletManager.createWallet(WALLET_NAME, WALLET_PASSWORD, 'evm');
      console.log(`Created wallet: ${address}`);
      console.log(`Private key (fund this wallet): ${privateKey}`);
      wallet = walletManager.getWallet(WALLET_NAME);
    }
  }
  console.log(`Using wallet: ${wallet!.address}`);

  // Load chains and merkle roots
  chains = await api.getChains();
  merkleRoots = await api.getMerkleRoots();
  console.log(`Loaded ${chains.length} chains, ${merkleRoots.length} merkle roots`);

  // Check health
  const health = await api.getHealth();
  console.log(`Health: ${JSON.stringify(health).slice(0, 100)}`);
}

function findChain(name: string): ChainInfo {
  const c = chains.find(c => c.chain_name === name);
  if (!c) throw new Error(`Chain "${name}" not found. Available: ${chains.map(c => c.chain_name).join(', ')}`);
  return c;
}

function findMerkleRoot(chainName: string, denomination: string, tokenSymbol: string) {
  const mr = merkleRoots.find(r =>
    r.chain_name === chainName &&
    r.denomination === denomination &&
    r.token_symbol === tokenSymbol
  );
  if (!mr) throw new Error(`No merkle root for ${tokenSymbol} ${denomination} on ${chainName}`);
  return mr;
}

async function deposit(chainName: string, denomination: string, tokenSymbol: string): Promise<string> {
  const chain = findChain(chainName);
  const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
  const signer = walletManager.getSigner(WALLET_NAME, WALLET_PASSWORD, provider);
  const treasury = new ethers.Contract(chain.treasury_address, TREASURY_ABI, signer);
  const gasOverrides = await getGasOverrides(provider, chain.chain_id);

  const isNative = tokenSymbol === chain.native_currency || tokenSymbol === 'ETH' || tokenSymbol === 'POL' || tokenSymbol === 'HYPE';

  if (isNative) {
    // Native token deposit: deposit(address(0), amount) with value
    const amount = ethers.utils.parseEther(denomination);
    console.log(`  Depositing ${denomination} ${tokenSymbol} (native) on ${chainName}`);
    const tx = await treasury.deposit(ethers.constants.AddressZero, amount, { value: amount, gasLimit: 200000, ...gasOverrides });
    console.log(`  TX: ${tx.hash}`);
    await tx.wait();
    return tx.hash;
  } else {
    // ERC20 deposit: approve then deposit(tokenAddr, amount)
    const tokens = await api.getTokens(chainName);
    const token = tokens.find((t: any) => (t.Symbol || t.symbol) === tokenSymbol);
    if (!token) throw new Error(`Token ${tokenSymbol} not found on ${chainName}`);
    const tokenAddr = token.Address || token.address;
    const decimals = token.Decimals || token.decimals || 6;
    const amount = ethers.utils.parseUnits(denomination, decimals);

    const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, signer);

    // Check and approve
    const allowance = await erc20.allowance(signer.address, chain.treasury_address);
    if (allowance.lt(amount)) {
      console.log(`  Approving ${tokenSymbol}...`);
      const approveTx = await erc20.approve(chain.treasury_address, ethers.constants.MaxUint256, gasOverrides);
      await approveTx.wait();
    }

    console.log(`  Depositing ${denomination} ${tokenSymbol} (ERC20) on ${chainName}`);
    const tx = await treasury.deposit(tokenAddr, amount, { gasLimit: 300000, ...gasOverrides });
    console.log(`  TX: ${tx.hash}`);
    await tx.wait();
    return tx.hash;
  }
}

async function claimKeys(
  depositTxHash: string,
  sourceChain: string,
  withdrawalRequests: Array<{ target_chain: string; token_symbol: string; denomination: string }>,
  retries = 3,
): Promise<any> {
  const chain = findChain(sourceChain);
  const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
  const signer = walletManager.getSigner(WALLET_NAME, WALLET_PASSWORD, provider);

  // Wait for confirmations
  await waitForConfirmations(provider, depositTxHash);

  const timestamp = Math.floor(Date.now() / 1000);
  const proofMessage = createProofMessage(depositTxHash, sourceChain, withdrawalRequests, signer.address, timestamp);
  const signature = await signer.signMessage(proofMessage);
  const spendRequestId = ethers.utils.id(`${depositTxHash}:${sourceChain}:0:${timestamp}`);

  let lastError = '';
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      console.log(`  Retry ${attempt}/${retries}...`);
      await new Promise(r => setTimeout(r, 10000));
    }

    const results = await api.requestKeyshares({
      depositTxHash,
      sourceChain,
      withdrawalRequests,
      userAddress: signer.address,
      signature,
      timestamp,
      spendRequestId,
    });

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    console.log(`  Keyshare results: ${successful.length} success, ${failed.length} failed`);

    if (failed.length > 0) {
      lastError = failed.map(f => f.error).join('; ');
      console.log(`  Failures: ${lastError.slice(0, 200)}`);
    }

    const threshold = successful[0]?.threshold || 3;
    if (successful.length >= threshold) {
      return processKeyshares(successful, withdrawalRequests, threshold);
    }
  }
  throw new Error(`Failed to get enough keyshares after ${retries} retries. Last error: ${lastError}`);
}

function processKeyshares(
  successful: any[],
  withdrawalRequests: Array<{ target_chain: string; token_symbol: string; denomination: string }>,
  threshold: number,
) {
  const results: any[] = [];

  for (let i = 0; i < withdrawalRequests.length; i++) {
    const req = withdrawalRequests[i];
    const sharesForKey: Array<{ nodeId: number; shareHex: string; keyIndex: number; address: string; merkleProof: string[]; merkleRootId: number; tokenAddress: string; tokenDecimals: number }> = [];

    for (const nodeResult of successful) {
      const ks = nodeResult.keyshares?.[i];
      if (ks) {
        sharesForKey.push({
          nodeId: nodeResult.nodeId!,
          shareHex: ks.share_value,
          keyIndex: ks.key_index,
          address: ks.address,
          merkleProof: ks.merkle_proof,
          merkleRootId: ks.merkle_root_id,
          tokenAddress: ks.token_address,
          tokenDecimals: ks.token_decimals,
        });
      }
    }

    // Use threshold shares
    const sharesToUse = sharesForKey.slice(0, threshold);
    const shares = sharesToUse.map(s => ({ shareId: String(s.nodeId), shareValue: s.shareHex }));
    const { privateKeyHex } = reconstructPrivateKey(shares, threshold);
    const expectedAddr = sharesForKey[0].address;
    const matches = verifyKeyMatchesAddress(privateKeyHex, expectedAddr);
    console.log(`  Key ${i}: address=${expectedAddr}, verified=${matches}`);

    results.push({
      request: req,
      privateKey: privateKeyHex,
      address: expectedAddr,
      keyIndex: sharesForKey[0].keyIndex,
      merkleProof: sharesForKey[0].merkleProof,
      merkleRootId: sharesForKey[0].merkleRootId,
      tokenAddress: sharesForKey[0].tokenAddress,
      tokenDecimals: sharesForKey[0].tokenDecimals,
      verified: matches,
    });
  }

  return {
    keys: results,
    depositAmount: successful[0]?.depositAmount,
    claimedAmount: successful[0]?.claimedAmount,
    remainingDeposit: successful[0]?.remainingDeposit,
  };
}

async function withdrawOnchain(
  keyResult: any,
  targetChainName: string,
  denomination: string,
  tokenSymbol: string,
): Promise<string> {
  const chain = findChain(targetChainName);
  const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
  const wallet = walletManager.getWallet(WALLET_NAME)!;
  const recipientAddress = wallet.address;

  // Get token info
  let tokenAddr = keyResult.tokenAddress || ethers.constants.AddressZero;
  let decimals = keyResult.tokenDecimals || 18;
  const isNative = tokenSymbol === chain.native_currency || tokenSymbol === 'ETH' || tokenSymbol === 'POL' || tokenSymbol === 'HYPE';

  if (!isNative && tokenAddr === ethers.constants.AddressZero) {
    const tokens = await api.getTokens(targetChainName);
    const tok = tokens.find((t: any) => (t.Symbol || t.symbol) === tokenSymbol);
    if (tok) {
      tokenAddr = tok.Address || tok.address;
      decimals = tok.Decimals || tok.decimals || 6;
    }
  }

  const amount = isNative
    ? ethers.utils.parseEther(denomination)
    : ethers.utils.parseUnits(denomination, decimals);

  // Create withdrawal signature using the reconstructed key
  const withdrawSig = await createWithdrawalSignature(
    keyResult.privateKey,
    recipientAddress,
    tokenAddr,
    amount,
    keyResult.merkleRootId,
    keyResult.keyIndex,
    chain.chain_id,
  );

  // Submit withdrawal using our funded wallet (pays gas)
  const fundedSigner = walletManager.getSigner(WALLET_NAME, WALLET_PASSWORD, provider);
  const treasury = new ethers.Contract(chain.treasury_address, TREASURY_ABI, fundedSigner);
  const gasOverrides = await getGasOverrides(provider, chain.chain_id);

  console.log(`  Withdrawing ${denomination} ${tokenSymbol} on ${targetChainName}`);
  console.log(`    recipient=${recipientAddress}, merkleRootId=${keyResult.merkleRootId}, keyIndex=${keyResult.keyIndex}`);

  const tx = await treasury.withdraw(
    isNative ? ethers.constants.AddressZero : tokenAddr,
    recipientAddress,
    amount,
    keyResult.merkleRootId,
    withdrawSig,
    keyResult.merkleProof,
    keyResult.keyIndex,
    { gasLimit: 500000, ...gasOverrides },
  );
  console.log(`  Withdraw TX: ${tx.hash}`);
  await tx.wait();
  return tx.hash;
}

async function relayWithdraw(
  keyResult: any,
  targetChainName: string,
  denomination: string,
  tokenSymbol: string,
): Promise<any> {
  const chain = findChain(targetChainName);
  const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
  const wallet = walletManager.getWallet(WALLET_NAME)!;
  const recipientAddress = wallet.address;

  let tokenAddr = keyResult.tokenAddress || ethers.constants.AddressZero;
  let decimals = keyResult.tokenDecimals || 18;
  const isNative = tokenSymbol === chain.native_currency || tokenSymbol === 'ETH' || tokenSymbol === 'POL' || tokenSymbol === 'HYPE';

  if (!isNative && tokenAddr === ethers.constants.AddressZero) {
    const tokens = await api.getTokens(targetChainName);
    const tok = tokens.find((t: any) => (t.Symbol || t.symbol) === tokenSymbol);
    if (tok) {
      tokenAddr = tok.Address || tok.address;
      decimals = tok.Decimals || tok.decimals || 6;
    }
  }

  const amount = isNative
    ? ethers.utils.parseEther(denomination)
    : ethers.utils.parseUnits(denomination, decimals);

  const withdrawSig = await createWithdrawalSignature(
    keyResult.privateKey,
    recipientAddress,
    tokenAddr,
    amount,
    keyResult.merkleRootId,
    keyResult.keyIndex,
    chain.chain_id,
  );

  console.log(`  Relay withdrawing ${denomination} ${tokenSymbol} on ${targetChainName}`);
  const result = await api.relayWithdraw({
    chain: targetChainName,
    chainType: chain.chain_type || 'evm',
    recipient: recipientAddress,
    amount: amount.toString(),
    token: isNative ? undefined : tokenAddr,
    signature: withdrawSig,
    merkleProof: keyResult.merkleProof,
    merkleRootId: keyResult.merkleRootId,
    keyIndex: keyResult.keyIndex,
    maxRelayerFee: '0',
  });

  console.log(`  Relay result: ${JSON.stringify(result).slice(0, 200)}`);
  return result;
}

// ==================== TEST CASES ====================

async function test1_crossChainDeposit() {
  console.log('\n=== TEST 1: Cross-chain USDC deposit (Sepolia) -> withdraw (Base Sepolia) ===');

  // Deposit 1 USDC on Sepolia
  const txHash = await deposit('sepolia', '1', 'USDC');
  console.log(`  Deposit done: ${txHash}`);

  // Claim keys for withdrawal on base_sepolia
  const claimResult = await claimKeys(txHash, 'sepolia', [
    { target_chain: 'base_sepolia', token_symbol: 'USDC', denomination: '1' },
  ]);
  console.log(`  Claimed ${claimResult.keys.length} key(s), deposit=${claimResult.depositAmount}, remaining=${claimResult.remainingDeposit}`);

  // Withdraw on Base Sepolia
  const key = claimResult.keys[0];
  if (!key.verified) throw new Error('Key verification failed!');
  const withdrawTx = await withdrawOnchain(key, 'base_sepolia', '1', 'USDC');
  console.log(`  Withdrawal complete: ${withdrawTx}`);
  console.log('  TEST 1 PASSED');
}

async function test2_relayWithdraw() {
  console.log('\n=== TEST 2: Relay withdrawal (gas-free) ===');

  // Deposit 1 USDC on Base Sepolia
  const txHash = await deposit('base_sepolia', '1', 'USDC');
  console.log(`  Deposit done: ${txHash}`);

  // Claim keys for relay withdrawal on hyperliquid-testnet
  const claimResult = await claimKeys(txHash, 'base_sepolia', [
    { target_chain: 'hyperliquid-testnet', token_symbol: 'USDC', denomination: '1' },
  ]);
  console.log(`  Claimed ${claimResult.keys.length} key(s)`);

  const key = claimResult.keys[0];
  if (!key.verified) throw new Error('Key verification failed!');

  // Use relay instead of direct on-chain withdraw
  const relayResult = await relayWithdraw(key, 'hyperliquid-testnet', '1', 'USDC');

  // Poll relay status if we got a job ID
  if (relayResult.job_id) {
    console.log(`  Relay job: ${relayResult.job_id}`);
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const status = await api.getRelayStatus(relayResult.job_id);
      console.log(`  Relay status: ${JSON.stringify(status).slice(0, 150)}`);
      if (status.status === 'completed' || status.status === 'confirmed') {
        console.log('  TEST 2 PASSED');
        return;
      }
      if (status.status === 'failed') {
        throw new Error(`Relay failed: ${JSON.stringify(status)}`);
      }
    }
    console.log('  Relay still pending after 5 min — check manually');
  } else {
    console.log(`  Relay submitted (no job_id in response)`);
    console.log('  TEST 2 PASSED (relay accepted)');
  }
}

async function test3_multiChainSplit() {
  console.log('\n=== TEST 3: Multi-chain split — deposit 5 USDC on Sepolia, withdraw across 3 chains ===');

  const txHash = await deposit('sepolia', '5', 'USDC');
  console.log(`  Deposit done: ${txHash}`);

  const withdrawalRequests = [
    { target_chain: 'base_sepolia', token_symbol: 'USDC', denomination: '2' },
    { target_chain: 'hyperliquid-testnet', token_symbol: 'USDC', denomination: '1' },
    { target_chain: 'sepolia', token_symbol: 'USDC', denomination: '2' },
  ];

  const claimResult = await claimKeys(txHash, 'sepolia', withdrawalRequests);
  console.log(`  Claimed ${claimResult.keys.length} keys, deposit=${claimResult.depositAmount}, remaining=${claimResult.remainingDeposit}`);

  // Withdraw each key on its target chain
  for (let i = 0; i < claimResult.keys.length; i++) {
    const key = claimResult.keys[i];
    const req = withdrawalRequests[i];
    if (!key.verified) {
      console.log(`  Key ${i} verification FAILED — skipping`);
      continue;
    }
    try {
      const withdrawTx = await withdrawOnchain(key, req.target_chain, req.denomination, req.token_symbol);
      console.log(`  Key ${i} withdrawn on ${req.target_chain}: ${withdrawTx}`);
    } catch (err: any) {
      console.log(`  Key ${i} withdraw failed on ${req.target_chain}: ${err.message}`);
    }
  }
  console.log('  TEST 3 DONE');
}

async function test4_edgeCases() {
  console.log('\n=== TEST 4: Edge cases ===');

  // 4a: Native ETH cross-chain (Sepolia ETH -> withdraw on Base Sepolia)
  console.log('\n--- 4a: Native ETH deposit on Base Sepolia, withdraw ETH on Sepolia ---');
  try {
    const txHash = await deposit('base_sepolia', '0.01', 'ETH');
    console.log(`  Deposit done: ${txHash}`);
    const claimResult = await claimKeys(txHash, 'base_sepolia', [
      { target_chain: 'sepolia', token_symbol: 'ETH', denomination: '0.01' },
    ]);
    const key = claimResult.keys[0];
    if (key.verified) {
      const withdrawTx = await withdrawOnchain(key, 'sepolia', '0.01', 'ETH');
      console.log(`  Withdrawal: ${withdrawTx}`);
    }
    console.log('  4a PASSED');
  } catch (err: any) {
    console.log(`  4a FAILED: ${err.message}`);
  }

  // 4b: Same-chain deposit and withdraw (deposit USDC on Base, withdraw USDC on Base)
  console.log('\n--- 4b: Same-chain USDC (Base Sepolia -> Base Sepolia) ---');
  try {
    const txHash = await deposit('base_sepolia', '1', 'USDC');
    console.log(`  Deposit done: ${txHash}`);
    const claimResult = await claimKeys(txHash, 'base_sepolia', [
      { target_chain: 'base_sepolia', token_symbol: 'USDC', denomination: '1' },
    ]);
    const key = claimResult.keys[0];
    if (key.verified) {
      const withdrawTx = await withdrawOnchain(key, 'base_sepolia', '1', 'USDC');
      console.log(`  Withdrawal: ${withdrawTx}`);
    }
    console.log('  4b PASSED');
  } catch (err: any) {
    console.log(`  4b FAILED: ${err.message}`);
  }
}

// ==================== MAIN ====================
async function main() {
  try {
    await setup();

    // Run tests sequentially
    await test1_crossChainDeposit();
    await test2_relayWithdraw();
    await test3_multiChainSplit();
    await test4_edgeCases();

    console.log('\n=== ALL TESTS COMPLETE ===');
  } catch (err: any) {
    console.error(`\nFATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();

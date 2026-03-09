#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ethers } from 'ethers';
import { loadConfig } from './config.js';
import { WalletManager } from './wallet.js';
import { BlackBoxAPI } from './api.js';
import {
  reconstructPrivateKey,
  verifyKeyMatchesAddress,
  createProofMessage,
  createWithdrawalSignature,
  createRelayWithdrawalSignature,
} from './crypto.js';

const config = loadConfig();
const walletManager = new WalletManager(config.walletStorePath);
const api = new BlackBoxAPI(config);

const TREASURY_ABI = [
  'function deposit(address token, uint256 amount) payable',
  'function withdraw(address token, address payable recipient, uint256 amount, uint256 merkleRootId, bytes signature, bytes32[] merkleProof, uint256 keyIndex)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// Helper: process keyshares into reconstructed keys
async function processKeyshares(
  successful: Array<{ nodeId?: number; keyshares?: any[]; depositAmount?: number; claimedAmount?: number; remainingDeposit?: number }>,
  _failed: any[],
  withdrawal_requests: Array<{ target_chain: string; token_symbol: string; denomination: string }>,
  threshold: number,
) {
  const keys: any[] = [];
  for (let wrIdx = 0; wrIdx < withdrawal_requests.length; wrIdx++) {
    const keyshareData = successful.map(r => {
      const ks = r.keyshares![wrIdx];
      return {
        nodeId: r.nodeId!,
        shareId: ks.share_id,
        shareValue: ks.share_value,
        keyIndex: ks.key_index,
        address: ks.address,
        merkleRootId: ks.merkle_root_id,
        merkleProof: ks.merkle_proof || [],
        denomination: ks.denomination,
        chainName: ks.chain_name,
        chainId: ks.chain_id,
        treasuryAddress: ks.treasury_address,
        tokenSymbol: ks.token_symbol,
        tokenAddress: ks.token_address || ethers.constants.AddressZero,
        tokenDecimals: ks.token_decimals || 18,
      };
    }).filter(ks => ks.shareId);

    const expectedAddress = keyshareData[0].address;
    const expectedKeyIndex = keyshareData[0].keyIndex;
    for (const ks of keyshareData) {
      if (ks.address !== expectedAddress) throw new Error(`Nodes returned different addresses for key ${wrIdx}`);
      if (ks.keyIndex !== expectedKeyIndex) throw new Error(`Nodes returned different key indices for key ${wrIdx}`);
    }

    const { privateKeyHex } = reconstructPrivateKey(keyshareData, threshold);
    if (!verifyKeyMatchesAddress(privateKeyHex, expectedAddress)) {
      throw new Error(`Key reconstruction failed for withdrawal ${wrIdx}: address mismatch`);
    }

    keys.push({
      index: wrIdx,
      private_key: privateKeyHex,
      address: expectedAddress,
      key_index: expectedKeyIndex,
      merkle_root_id: keyshareData[0].merkleRootId,
      merkle_proof: keyshareData[0].merkleProof,
      denomination: keyshareData[0].denomination,
      chain_name: keyshareData[0].chainName,
      chain_id: keyshareData[0].chainId,
      treasury_address: keyshareData[0].treasuryAddress,
      token_symbol: keyshareData[0].tokenSymbol,
      token_address: keyshareData[0].tokenAddress,
      token_decimals: keyshareData[0].tokenDecimals,
    });
  }

  const firstResult = successful[0];
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        success: true,
        keys_count: keys.length,
        keys,
        deposit_amount: firstResult.depositAmount,
        claimed_amount: firstResult.claimedAmount,
        remaining_deposit: firstResult.remainingDeposit,
        nodes_responded: successful.length,
        warning: 'These private keys are one-time-use withdrawal keys. Each can only be used once on-chain.',
      }, null, 2),
    }],
  };
}

function createServer() {
const server = new McpServer({
  name: 'blackbox-protocol',
  version: '0.1.0',
});

// ─── Agent Guide Resource ───────────────────────────────────────────────────

const AGENT_GUIDE = `# BlackBox Protocol — Agent Workflow Guide

## What is BlackBox?
A privacy protocol using Distributed Key Generation (DKG). You deposit tokens on one chain,
receive threshold-reconstructed private keys, and withdraw on any supported chain — breaking
the on-chain link between deposit and withdrawal.

## Supported Chains & Denominations
Call \`get_supported_chains\` and \`get_available_denominations\` for current data. Typical setup:
- **Sepolia**: 0.001 ETH, 1 USDC
- **Base Sepolia**: 0.001 ETH, 1 USDC
- **Hyperliquid Testnet**: 0.01 HYPE, 1 USDC
- **BNB Testnet**: 0.01 TBNB, 1 USDC (IMPORTANT: BNB USDC has 18 decimals, not 6!)
- **Polygon Amoy**: 1 POL, 1 USDC
- **Solana Devnet**: 0.1 SOL, 1 USDC

## Step-by-Step Workflow

### 1. Setup (one-time)
- Call \`create_wallet\` with type "evm" (and optionally "solana" for Solana chains).
- Fund the wallet with native gas tokens (ETH, POL, HYPE, etc.) and any ERC20 tokens (USDC).
- The wallet is encrypted and persisted locally.

### 2. Discover available options
- \`get_supported_chains\` — lists all chains with RPC URLs, treasury addresses, native currencies.
- \`get_chain_tokens\` — lists tokens on a specific chain (with addresses and decimals). ALWAYS check decimals — BNB USDC uses 18 decimals.
- \`get_available_denominations\` — lists EXACT valid deposit amounts. You MUST use these exact values.
- \`get_token_mappings\` — shows which tokens can be moved cross-chain (returns object keyed by token symbol).

### 3. Deposit
- Call \`deposit\` with: wallet_name, password, chain_name, token (symbol like "USDC" or "ETH"), amount.
- You can pass a token symbol (e.g., "USDC") — it auto-resolves to the correct address and decimals.
- The tool handles ERC20 approval automatically.
- You MUST deposit an amount equal to the sum of denominations you plan to claim.
- You get back a transaction hash. Wait for it to confirm (2 blocks).

### 4. Claim Keys
- Call \`claim_keys\` with: deposit_tx_hash, source_chain, and an array of withdrawal_requests.
- Each withdrawal_request specifies: { target_chain, token_symbol, denomination }.
- The total of all denominations must not exceed the deposit amount.
- Denominations MUST match registered values (e.g., "1" for USDC, "0.001" for ETH). Invalid denominations are rejected.
- You can split across multiple chains (e.g., deposit 2 USDC, claim 1 on Base + 1 on Sepolia).
- Token symbol in withdrawal_request must match what was deposited (e.g., deposit USDC, claim USDC — not ETH).
- For partial claims: use \`occurrence_offset\` to claim remaining balance in a second call.
- Re-claiming the same deposit returns the same key (idempotent).
- Returns reconstructed private keys, merkle proofs, and key indices for each withdrawal.

### 5. Withdraw
**Option A: Direct on-chain withdrawal** (you pay gas) — RECOMMENDED
- Call \`withdraw_onchain\` with the key data from claim_keys.
- You need native gas on the target chain.
- The key can only be withdrawn on the chain it was claimed for (wrong chain will revert).

**Option B: Relay withdrawal** (gas-free)
- Call \`relay_withdraw\` with the key data.
- The tool checks if relay is enabled first.
- IMPORTANT: max_relayer_fee must be > 0 (default: 10% of amount). Setting it to 0 will fail.
- Use \`check_relay_status\` to poll the job until confirmed.

**Option C: Combined deposit + claim**
- Call \`deposit_and_claim\` to do both steps in one call (waits for confirmations internally).

## Security Rules
- Only the depositor address can claim keys for their deposit.
- Claim requests must have a fresh timestamp (within minutes, not hours).
- Each key can only be used once (on-chain nullifier). Double-withdrawal reverts.
- Keys are chain-specific: claimed for base_sepolia cannot be used on sepolia.
- Token types are enforced: deposit USDC, must claim USDC (not ETH).
- Polygon chains require higher gas (handled automatically).
- Backend needs 2 block confirmations before issuing keyshares (handled automatically with retries).

## Example: Cross-chain USDC transfer
1. \`deposit\` 2 USDC on Sepolia (denomination must be whole numbers matching registered amounts)
2. \`claim_keys\` with withdrawal_requests: [
     { target_chain: "base_sepolia", token_symbol: "USDC", denomination: "1" },
     { target_chain: "sepolia", token_symbol: "USDC", denomination: "1" }
   ]
3. \`withdraw_onchain\` for each key on its target chain

## Error Handling
- "No merkle root found" — invalid denomination. Check \`get_available_denominations\`.
- "Total requested value exceeds deposit amount" — claim too much.
- "Deposit transaction was not sent by the requesting user" — wrong wallet.
- "Request timestamp is too old" — stale request, try again.
- "No token mapping found" — deposited token X but tried to claim token Y.
- If claim_keys fails with "needs more confirmations", it retries automatically (up to 3 times).
- If a withdrawal reverts, check that the key hasn't been used already (nullifier).
- If relay returns MaxRelayerFeeExceeded, increase max_relayer_fee.
- If relay returns "relay service is disabled", use withdraw_onchain instead.
`;

server.resource(
  'agent_guide',
  'blackbox://agent-guide',
  { mimeType: 'text/plain' },
  async () => ({
    contents: [{ uri: 'blackbox://agent-guide', text: AGENT_GUIDE, mimeType: 'text/plain' }],
  }),
);

// ─── Wallet Tools ───────────────────────────────────────────────────────────

server.tool(
  'create_wallet',
  'Create a new wallet with secure random key. Supports EVM (Ethereum/Polygon/etc) and Solana. Returns address and private key (shown once). The key is stored encrypted.',
  {
    name: z.string().describe('Name for the wallet (e.g., "trading-agent")'),
    password: z.string().describe('Password to encrypt the stored private key'),
    wallet_type: z.enum(['evm', 'solana']).optional().describe('Wallet type: "evm" (default) or "solana"'),
  },
  async ({ name, password, wallet_type }) => {
    try {
      const type = wallet_type || 'evm';
      const { address, privateKey } = walletManager.createWallet(name, password, type);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            name,
            wallet_type: type,
            address,
            private_key: privateKey,
            warning: 'Save this private key securely. It will not be shown again. The encrypted copy is stored locally.',
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'import_wallet',
  'Import an existing EVM wallet from a private key.',
  {
    name: z.string().describe('Name for the wallet'),
    private_key: z.string().describe('Private key (hex, with or without 0x prefix)'),
    password: z.string().describe('Password to encrypt the stored key'),
  },
  async ({ name, private_key, password }) => {
    try {
      const { address } = walletManager.importWallet(name, private_key, password);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, name, address }, null, 2) }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'list_wallets',
  'List all stored wallets (names and addresses).',
  {},
  async () => {
    const wallets = walletManager.listWallets();
    return {
      content: [{ type: 'text', text: JSON.stringify({ wallets }, null, 2) }],
    };
  },
);

server.tool(
  'get_balance',
  'Get native and/or token balance for a wallet on a specific chain.',
  {
    wallet_name: z.string().describe('Wallet name'),
    password: z.string().describe('Wallet password'),
    chain_name: z.string().describe('Chain name (e.g., "sepolia", "polygon-amoy")'),
    token_address: z.string().optional().describe('ERC20 token contract address (omit for native balance only)'),
  },
  async ({ wallet_name, password, chain_name, token_address }) => {
    try {
      const wallet = walletManager.getWallet(wallet_name);
      if (!wallet) return { content: [{ type: 'text', text: `Wallet "${wallet_name}" not found` }], isError: true };

      const chains = await api.getChains();
      const chain = chains.find(c => c.chain_name === chain_name);
      if (!chain) return { content: [{ type: 'text', text: `Chain "${chain_name}" not found` }], isError: true };
      if (!chain.rpc_url) return { content: [{ type: 'text', text: `No RPC URL configured for ${chain_name}` }], isError: true };

      // Solana balance check
      if (chain.chain_type === 'solana' || wallet.walletType === 'solana') {
        const { Connection, PublicKey, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
        const connection = new Connection(chain.rpc_url, 'confirmed');
        const pubkey = new PublicKey(wallet.address);
        const lamports = await connection.getBalance(pubkey);

        const result: any = {
          address: wallet.address,
          chain: chain_name,
          native_balance: (lamports / LAMPORTS_PER_SOL).toString(),
          native_currency: chain.native_currency || 'SOL',
        };

        // SPL token balance
        if (token_address) {
          try {
            const tokenPubkey = new PublicKey(token_address);
            const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: tokenPubkey });
            if (tokenAccounts.value.length > 0) {
              const parsed = tokenAccounts.value[0].account.data.parsed.info;
              result.token_balance = parsed.tokenAmount.uiAmountString;
              result.token_symbol = token_address;
              result.token_address = token_address;
            } else {
              result.token_balance = '0';
              result.token_address = token_address;
            }
          } catch (tokenErr: any) {
            result.token_error = `Failed to fetch SPL token: ${tokenErr.message}`;
          }
        }

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      // EVM balance check
      const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
      const signer = walletManager.getSigner(wallet_name, password, provider);
      const address = await signer.getAddress();

      const nativeBalance = await provider.getBalance(address);
      const result: any = {
        address,
        chain: chain_name,
        native_balance: ethers.utils.formatEther(nativeBalance),
        native_currency: chain.native_currency || 'ETH',
      };

      if (token_address) {
        const token = new ethers.Contract(token_address, ERC20_ABI, provider);
        const [balance, decimals, symbol] = await Promise.all([
          token.balanceOf(address),
          token.decimals(),
          token.symbol(),
        ]);
        result.token_balance = ethers.utils.formatUnits(balance, decimals);
        result.token_symbol = symbol;
        result.token_address = token_address;
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ─── Protocol Discovery Tools ───────────────────────────────────────────────

server.tool(
  'get_supported_chains',
  'Get all chains supported by the BlackBox protocol, including RPC URLs, treasury addresses, and supported tokens.',
  {},
  async () => {
    try {
      const chains = await api.getChains();

      // Enrich each chain with its token details from the tokens endpoint
      const enriched = await Promise.all(chains.map(async (chain) => {
        try {
          const tokens = await api.getTokens(chain.chain_name);
          const tokenList = (tokens || []).map((t: any) => ({
            symbol: t.Symbol || t.symbol,
            address: t.Address || t.address,
            decimals: t.Decimals || t.decimals,
          }));
          return { ...chain, supported_tokens: tokenList };
        } catch {
          return chain; // If token fetch fails, return chain as-is
        }
      }));

      return { content: [{ type: 'text', text: JSON.stringify({ chains: enriched }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_chain_tokens',
  'Get tokens configured for a specific chain, including contract addresses and supported denominations.',
  {
    chain: z.string().describe('Chain name (e.g., "sepolia", "polygon-amoy")'),
  },
  async ({ chain }) => {
    try {
      const tokens = await api.getTokens(chain);
      return { content: [{ type: 'text', text: JSON.stringify({ chain, tokens }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_available_denominations',
  'Get available denominations (amounts) that can be deposited/withdrawn for a chain. Each denomination has a merkle root registered on-chain.',
  {
    chain: z.string().optional().describe('Chain name to filter (omit for all chains)'),
  },
  async ({ chain }) => {
    try {
      const roots = await api.getMerkleRoots(chain);
      // Deduplicate by denomination+tokenSymbol
      const seen = new Set<string>();
      const unique = roots.filter(r => {
        const key = `${r.denomination}-${r.token_symbol}-${r.chain_name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { content: [{ type: 'text', text: JSON.stringify({ denominations: unique }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_token_mappings',
  'Get cross-chain token mappings showing which tokens can be used across different chains. Returns an object keyed by token symbol (e.g., ETH, USDC) with chain-pair mappings.',
  {},
  async () => {
    try {
      const data = await api.getTokenMappings();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ─── Deposit Tool ───────────────────────────────────────────────────────────

server.tool(
  'deposit',
  'Deposit funds into the BlackBox treasury contract. For ERC20 tokens, handles approval automatically. Returns the deposit transaction hash. You can pass either a token symbol (e.g., "USDC") or a token address.',
  {
    wallet_name: z.string().describe('Wallet name to deposit from'),
    password: z.string().describe('Wallet password'),
    chain_name: z.string().describe('Chain to deposit on (e.g., "sepolia", "base_sepolia")'),
    amount: z.string().describe('Amount to deposit (human-readable, e.g., "1"). Must match a registered denomination — use get_available_denominations to see valid amounts.'),
    token: z.string().optional().describe('Token symbol (e.g., "USDC", "ETH") or ERC20 contract address. Omit for native token.'),
  },
  async ({ wallet_name, password, chain_name, amount, token }) => {
    try {
      const chains = await api.getChains();
      const chain = chains.find(c => c.chain_name === chain_name);
      if (!chain) return { content: [{ type: 'text', text: `Chain "${chain_name}" not found. Available: ${chains.map(c => c.chain_name).join(', ')}` }], isError: true };
      if (!chain.treasury_address) return { content: [{ type: 'text', text: `No treasury address for ${chain_name}` }], isError: true };

      // Resolve token symbol to address if needed
      let tokenAddress = ethers.constants.AddressZero;
      let tokenDecimals = 18;
      let tokenSymbol = chain.native_currency || 'ETH';

      const isNativeSymbol = !token || token === ethers.constants.AddressZero ||
        token.toUpperCase() === (chain.native_currency || 'ETH').toUpperCase();

      if (!isNativeSymbol) {
        // Could be a symbol or address
        const tokens = await api.getTokens(chain_name);
        if (token.startsWith('0x') && token.length === 42) {
          // It's an address
          tokenAddress = token;
          const found = tokens.find((t: any) => (t.Address || t.address)?.toLowerCase() === token.toLowerCase());
          if (found) {
            tokenDecimals = found.Decimals || found.decimals || 18;
            tokenSymbol = found.Symbol || found.symbol || 'ERC20';
          } else {
            // Read decimals from contract
            const erc20 = new ethers.Contract(token, ERC20_ABI, new ethers.providers.JsonRpcProvider(chain.rpc_url));
            tokenDecimals = await erc20.decimals();
          }
        } else {
          // It's a symbol — resolve to address
          const found = tokens.find((t: any) =>
            (t.Symbol || t.symbol)?.toUpperCase() === token.toUpperCase()
          );
          if (!found) {
            return { content: [{ type: 'text', text: `Token "${token}" not found on ${chain_name}. Available: ${tokens.map((t: any) => t.Symbol || t.symbol).join(', ')}` }], isError: true };
          }
          tokenAddress = found.Address || found.address;
          tokenDecimals = found.Decimals || found.decimals || 18;
          tokenSymbol = found.Symbol || found.symbol;
        }
      }

      const isNative = tokenAddress === ethers.constants.AddressZero;

      const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
      const signer = walletManager.getSigner(wallet_name, password, provider);
      const treasury = new ethers.Contract(chain.treasury_address, TREASURY_ABI, signer);

      // Polygon chains need minimum 30 gwei priority fee
      const gasOverrides: any = { gasLimit: 300000 };
      const polygonIds = new Set([137, 80001, 80002]);
      if (polygonIds.has(chain.chain_id)) {
        const minTip = ethers.utils.parseUnits('30', 'gwei');
        const feeData = await provider.getFeeData();
        gasOverrides.maxPriorityFeePerGas = minTip;
        gasOverrides.maxFeePerGas = feeData.maxFeePerGas?.gt(minTip) ? feeData.maxFeePerGas : minTip.mul(2);
      }

      let tx: ethers.ContractTransaction;

      if (isNative) {
        const amountWei = ethers.utils.parseEther(amount);
        tx = await treasury.deposit(ethers.constants.AddressZero, amountWei, {
          value: amountWei,
          ...gasOverrides,
        });
      } else {
        const amountWei = ethers.utils.parseUnits(amount, tokenDecimals);
        const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

        // Check and approve if needed
        const currentAllowance = await erc20.allowance(await signer.getAddress(), chain.treasury_address);
        if (currentAllowance.lt(amountWei)) {
          const approveTx = await erc20.approve(chain.treasury_address, amountWei, gasOverrides);
          await approveTx.wait();
        }

        tx = await treasury.deposit(tokenAddress, amountWei, gasOverrides);
      }

      const receipt = await tx.wait();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            tx_hash: receipt.transactionHash,
            chain: chain_name,
            amount,
            token_symbol: tokenSymbol,
            token_address: tokenAddress,
            token_decimals: tokenDecimals,
            block_number: receipt.blockNumber,
            explorer_url: chain.block_explorer
              ? `${chain.block_explorer.replace(/\/+$/, '')}/tx/${receipt.transactionHash}`
              : undefined,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Deposit failed: ${e.message}` }], isError: true };
    }
  },
);

// ─── Key Claiming Tool ──────────────────────────────────────────────────────

server.tool(
  'claim_keys',
  'Claim withdrawal keys from DKG nodes for a deposit. Signs a proof message, requests keyshares from all nodes, and reconstructs the private keys via Lagrange interpolation. Returns the reconstructed keys with all data needed for withdrawal.',
  {
    wallet_name: z.string().describe('Wallet name (must match the depositor address)'),
    password: z.string().describe('Wallet password'),
    deposit_tx_hash: z.string().describe('Transaction hash of the deposit'),
    source_chain: z.string().describe('Chain where deposit was made (e.g., "sepolia")'),
    withdrawal_requests: z.array(z.object({
      target_chain: z.string().describe('Chain to withdraw on'),
      token_symbol: z.string().describe('Token symbol (e.g., "ETH", "USDC")'),
      denomination: z.string().describe('Amount denomination (e.g., "1", "0.1")'),
    })).describe('What to withdraw. Total must not exceed deposit amount.'),
    occurrence_offset: z.number().optional().describe('Number of keys already claimed for this deposit (default: 0)'),
  },
  async ({ wallet_name, password, deposit_tx_hash, source_chain, withdrawal_requests, occurrence_offset }) => {
    try {
      const privateKey = walletManager.getPrivateKey(wallet_name, password);
      const wallet = new ethers.Wallet(privateKey);
      const userAddress = wallet.address;
      const offset = occurrence_offset || 0;

      // Wait for confirmations before requesting keyshares
      // Backend requires 2 confirmations for EVM chains
      const chains = await api.getChains();
      const chain = chains.find(c => c.chain_name === source_chain);
      if (chain?.rpc_url) {
        const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
        const receipt = await provider.getTransactionReceipt(deposit_tx_hash);
        if (receipt) {
          const currentBlock = await provider.getBlockNumber();
          const confirmations = currentBlock - receipt.blockNumber;
          if (confirmations < 2) {
            const blocksNeeded = 2 - confirmations;
            // Wait ~5s per block (conservative estimate)
            const waitMs = blocksNeeded * 5000 + 3000;
            await new Promise(resolve => setTimeout(resolve, waitMs));
          }
        }
      }

      // Retry logic: attempt up to 3 times with 10s delays for confirmation issues
      let lastError = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const timestamp = Math.floor(Date.now() / 1000);

        const proofMessage = createProofMessage(
          deposit_tx_hash, source_chain, withdrawal_requests, userAddress, timestamp,
        );
        const signature = await wallet.signMessage(proofMessage);

        const spendRequestId = ethers.utils.id(
          `${deposit_tx_hash}:${source_chain}:${offset}:${timestamp}`,
        );

        const results = await api.requestKeyshares({
          depositTxHash: deposit_tx_hash,
          sourceChain: source_chain,
          withdrawalRequests: withdrawal_requests,
          userAddress,
          signature,
          timestamp,
          occurrenceOffset: offset,
          spendRequestId,
        });

        const successful = results.filter(r => r.success && r.keyshares && r.keyshares.length > 0);
        const failed = results.filter(r => !r.success);

        if (successful.length >= config.threshold) {
          // Success - proceed to key reconstruction (code below)
          return await processKeyshares(successful, failed, withdrawal_requests, config.threshold);
        }

        // Check if it's a confirmation issue - worth retrying
        const errors = failed.map(f => f.error || '').join('; ');
        lastError = errors;
        const isConfirmationIssue = errors.includes('confirmation');
        if (!isConfirmationIssue || attempt === 2) {
          // Provide helpful error context
          let hint = '';
          if (errors.includes('No merkle root found')) hint = '\nHint: The denomination is not registered. Use get_available_denominations to find valid amounts.';
          else if (errors.includes('exceeds deposit amount')) hint = '\nHint: Total withdrawal amount exceeds what was deposited.';
          else if (errors.includes('not sent by the requesting user')) hint = '\nHint: Only the depositor wallet can claim keys for their deposit.';
          else if (errors.includes('timestamp')) hint = '\nHint: Request timestamp expired. Try again immediately.';
          else if (errors.includes('No token mapping')) hint = '\nHint: Token mismatch — you must claim the same token type you deposited.';
          else if (errors.includes('insufficient peer evaluations')) hint = '\nHint: DKG P2P exchange failed — some nodes may be unreachable. Try again.';
          return {
            content: [{ type: 'text', text: `Key claim failed: only ${successful.length}/${config.threshold} nodes responded. Errors: ${errors}${hint}` }],
            isError: true,
          };
        }

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 10000));
      }

      return {
        content: [{ type: 'text', text: `Key claim failed after 3 attempts: ${lastError}` }],
        isError: true,
      };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Key claim failed: ${e.message}` }], isError: true };
    }
  },
);

// ─── Withdrawal Tools ───────────────────────────────────────────────────────

server.tool(
  'withdraw_onchain',
  'Execute an on-chain withdrawal using a claimed key. Signs the withdrawal message with the one-time key and submits the transaction to the treasury contract.',
  {
    wallet_name: z.string().describe('Wallet name to pay gas from'),
    password: z.string().describe('Wallet password'),
    recipient: z.string().describe('Address to receive the withdrawn funds'),
    withdrawal_key: z.string().describe('Private key from claim_keys result'),
    token_address: z.string().describe('Token contract address (zero address for native)'),
    amount: z.string().describe('Amount to withdraw (human-readable)'),
    token_decimals: z.number().describe('Token decimals'),
    merkle_root_id: z.number().describe('Merkle root ID from claim_keys result'),
    merkle_proof: z.array(z.string()).describe('Merkle proof from claim_keys result'),
    key_index: z.number().describe('Key index from claim_keys result'),
    chain_name: z.string().describe('Chain to withdraw on'),
    treasury_address: z.string().describe('Treasury contract address from claim_keys result'),
  },
  async (params) => {
    try {
      const chains = await api.getChains();
      const chain = chains.find(c => c.chain_name === params.chain_name);
      if (!chain) return { content: [{ type: 'text', text: `Chain "${params.chain_name}" not found` }], isError: true };

      const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
      const gasSigner = walletManager.getSigner(params.wallet_name, params.password, provider);
      const network = await provider.getNetwork();

      const amountWei = ethers.utils.parseUnits(params.amount, params.token_decimals);

      // Sign with the one-time withdrawal key
      const withdrawalSig = await createWithdrawalSignature(
        params.withdrawal_key,
        params.recipient,
        params.token_address,
        amountWei,
        params.merkle_root_id,
        params.key_index,
        network.chainId,
      );

      const merkleProof = params.merkle_proof.map(p => p.startsWith('0x') ? p : '0x' + p);

      // Polygon chains need minimum 25 gwei priority fee
      const wGasOverrides: any = { gasLimit: 300000 };
      const polygonChainIds = new Set([137, 80001, 80002]);
      if (polygonChainIds.has(network.chainId)) {
        const minTip = ethers.utils.parseUnits('30', 'gwei');
        const feeData = await provider.getFeeData();
        wGasOverrides.maxPriorityFeePerGas = minTip;
        wGasOverrides.maxFeePerGas = feeData.maxFeePerGas?.gt(minTip) ? feeData.maxFeePerGas : minTip.mul(2);
      }

      const treasury = new ethers.Contract(params.treasury_address, TREASURY_ABI, gasSigner);
      const tx = await treasury.withdraw(
        params.token_address,
        params.recipient,
        amountWei,
        params.merkle_root_id,
        withdrawalSig,
        merkleProof,
        params.key_index,
        wGasOverrides,
      );

      const receipt = await tx.wait();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            tx_hash: receipt.transactionHash,
            block_number: receipt.blockNumber,
            chain: params.chain_name,
            recipient: params.recipient,
            amount: params.amount,
            explorer_url: chain.block_explorer
              ? `${chain.block_explorer.replace(/\/+$/, '')}/tx/${receipt.transactionHash}`
              : undefined,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Withdrawal failed: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'relay_withdraw',
  'Submit a gas-free withdrawal via the relay service. The relayer submits the transaction on your behalf. Use this when the agent wallet has no gas on the target chain.',
  {
    withdrawal_key: z.string().describe('Private key from claim_keys result'),
    recipient: z.string().describe('Address to receive funds'),
    token_address: z.string().describe('Token contract address'),
    amount: z.string().describe('Amount in base units (wei)'),
    token_decimals: z.number().describe('Token decimals'),
    merkle_root_id: z.number().describe('Merkle root ID'),
    merkle_proof: z.array(z.string()).describe('Merkle proof'),
    key_index: z.number().describe('Key index'),
    chain_name: z.string().describe('Chain name'),
    chain_type: z.string().optional().describe('Chain type: "evm" or "solana" (default: "evm")'),
    max_relayer_fee: z.string().optional().describe('Max fee willing to pay the relayer in base units (e.g., "500000" for 0.5 USDC). Must be > 0 to cover gas. Defaults to 10% of amount.'),
  },
  async (params) => {
    try {
      const chains = await api.getChains();
      const chain = chains.find(c => c.chain_name === params.chain_name);
      if (!chain) return { content: [{ type: 'text', text: `Chain not found` }], isError: true };

      const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
      const network = await provider.getNetwork();

      // Check relay status before attempting
      const relayInfoResp = await api.getRelayInfo();
      const relayInfo = relayInfoResp.info || relayInfoResp;
      if (relayInfo.enabled === false) {
        return { content: [{ type: 'text', text: `Relay service is currently disabled. Use withdraw_onchain instead (requires gas on target chain).` }], isError: true };
      }

      const amountWei = ethers.utils.parseUnits(params.amount, params.token_decimals);
      // Default maxRelayerFee to 10% of amount if not specified (must be > 0 to cover gas)
      const defaultFee = amountWei.div(10);
      const maxRelayerFee = params.max_relayer_fee
        ? ethers.BigNumber.from(params.max_relayer_fee)
        : (defaultFee.gt(0) ? defaultFee : ethers.BigNumber.from(1));
      const relayerAddress = relayInfo.evm_relayer_address || ethers.constants.AddressZero;

      const withdrawalSig = await createRelayWithdrawalSignature(
        params.withdrawal_key,
        params.recipient,
        params.token_address,
        amountWei,
        params.merkle_root_id,
        params.key_index,
        network.chainId,
        relayerAddress,
        maxRelayerFee,
      );

      const merkleProof = params.merkle_proof.map(p => p.startsWith('0x') ? p : '0x' + p);

      const result = await api.relayWithdraw({
        chain: params.chain_name,
        chainType: params.chain_type || 'evm',
        recipient: params.recipient,
        amount: amountWei.toString(),
        token: params.token_address,
        signature: withdrawalSig,
        merkleProof,
        merkleRootId: params.merkle_root_id,
        keyIndex: params.key_index,
        maxRelayerFee: maxRelayerFee.toString(),
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            job_id: result.job_id,
            message: 'Relay withdrawal submitted. Use check_relay_status to track progress.',
            ...result,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Relay withdrawal failed: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'check_relay_status',
  'Check the status of a relay withdrawal job.',
  {
    job_id: z.string().describe('Job ID from relay_withdraw result'),
  },
  async ({ job_id }) => {
    try {
      const result = await api.getRelayStatus(job_id);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ─── Utility Tools ──────────────────────────────────────────────────────────

server.tool(
  'check_health',
  'Check health and status of the BlackBox DKG network.',
  {},
  async () => {
    try {
      const health = await api.getHealth();
      return { content: [{ type: 'text', text: JSON.stringify(health, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_leaderboard',
  'Get the depositor leaderboard showing top depositors with their stats.',
  {
    limit: z.number().optional().describe('Max entries to return (default: 100, max: 100)'),
  },
  async ({ limit }) => {
    try {
      const result = await api.getLeaderboard(limit || 100);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_relay_info',
  'Get relay service info including supported chains, fees, and whether the relayer is enabled.',
  {},
  async () => {
    try {
      const info = await api.getRelayInfo();
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_swap_quote',
  'Get a swap quote from the relay service for cross-chain token swaps.',
  {
    asset_in: z.string().describe('Input asset identifier (e.g., "USDC_sepolia")'),
    asset_out: z.string().describe('Output asset identifier (e.g., "USDC_base_sepolia")'),
    amount: z.string().describe('Exact input amount in base units (e.g., "1000000" for 1 USDC)'),
    swap_type: z.string().optional().describe('Swap type: "EXACT_IN" (default) or "EXACT_OUT"'),
  },
  async ({ asset_in, asset_out, amount, swap_type }) => {
    try {
      const quote = await api.getSwapQuote({
        assetIn: asset_in,
        assetOut: asset_out,
        amount,
        swapType: swap_type || 'EXACT_IN',
        dry: true,
      });
      return { content: [{ type: 'text', text: JSON.stringify(quote, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ─── Compound Tools ─────────────────────────────────────────────────────────

server.tool(
  'deposit_and_claim',
  'Full flow: deposit funds into treasury, then immediately claim withdrawal keys. Combines deposit + claim_keys in one step.',
  {
    wallet_name: z.string().describe('Wallet name'),
    password: z.string().describe('Wallet password'),
    chain_name: z.string().describe('Chain to deposit on'),
    amount: z.string().describe('Amount to deposit (must match a registered denomination)'),
    token: z.string().optional().describe('Token symbol (e.g., "USDC", "ETH") or ERC20 address. Omit for native token.'),
    withdrawal_requests: z.array(z.object({
      target_chain: z.string(),
      token_symbol: z.string(),
      denomination: z.string(),
    })).describe('What denominations to claim as keys. Total must equal deposit amount.'),
  },
  async ({ wallet_name, password, chain_name, amount, token, withdrawal_requests }) => {
    try {
      // Step 1: Deposit
      const chains = await api.getChains();
      const chain = chains.find(c => c.chain_name === chain_name);
      if (!chain) return { content: [{ type: 'text', text: `Chain "${chain_name}" not found` }], isError: true };

      // Resolve token
      let tokenAddress = ethers.constants.AddressZero;
      let tokenDecimals = 18;
      const isNativeSymbol = !token || token === ethers.constants.AddressZero ||
        token.toUpperCase() === (chain.native_currency || 'ETH').toUpperCase();

      if (!isNativeSymbol) {
        const tokens = await api.getTokens(chain_name);
        if (token.startsWith('0x') && token.length === 42) {
          tokenAddress = token;
          const found = tokens.find((t: any) => (t.Address || t.address)?.toLowerCase() === token.toLowerCase());
          tokenDecimals = found ? (found.Decimals || found.decimals || 18) : 18;
        } else {
          const found = tokens.find((t: any) => (t.Symbol || t.symbol)?.toUpperCase() === token.toUpperCase());
          if (!found) return { content: [{ type: 'text', text: `Token "${token}" not found on ${chain_name}` }], isError: true };
          tokenAddress = found.Address || found.address;
          tokenDecimals = found.Decimals || found.decimals || 18;
        }
      }
      const isNative = tokenAddress === ethers.constants.AddressZero;

      const provider = new ethers.providers.JsonRpcProvider(chain.rpc_url);
      const signer = walletManager.getSigner(wallet_name, password, provider);
      const treasury = new ethers.Contract(chain.treasury_address, TREASURY_ABI, signer);

      // Polygon gas
      const gasOverrides: any = { gasLimit: 300000 };
      const polygonIds = new Set([137, 80001, 80002]);
      if (polygonIds.has(chain.chain_id)) {
        const minTip = ethers.utils.parseUnits('30', 'gwei');
        const feeData = await provider.getFeeData();
        gasOverrides.maxPriorityFeePerGas = minTip;
        gasOverrides.maxFeePerGas = feeData.maxFeePerGas?.gt(minTip) ? feeData.maxFeePerGas : minTip.mul(2);
      }

      let tx: ethers.ContractTransaction;
      if (isNative) {
        const amountWei = ethers.utils.parseEther(amount);
        tx = await treasury.deposit(ethers.constants.AddressZero, amountWei, { value: amountWei, ...gasOverrides });
      } else {
        const amountWei = ethers.utils.parseUnits(amount, tokenDecimals);
        const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
        const currentAllowance = await erc20.allowance(await signer.getAddress(), chain.treasury_address);
        if (currentAllowance.lt(amountWei)) {
          const approveTx = await erc20.approve(chain.treasury_address, amountWei, gasOverrides);
          await approveTx.wait();
        }
        tx = await treasury.deposit(tokenAddress, amountWei, gasOverrides);
      }

      const depositReceipt = await tx.wait();
      const depositTxHash = depositReceipt.transactionHash;

      // Step 2: Wait for confirmations then claim keys
      // Wait 15s for block confirmations (backend requires 2)
      await new Promise(resolve => setTimeout(resolve, 15000));

      const walletPk = walletManager.getPrivateKey(wallet_name, password);
      const wallet = new ethers.Wallet(walletPk);
      const userAddress = wallet.address;

      // Retry up to 3 times for confirmation issues
      let claimResult: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const timestamp = Math.floor(Date.now() / 1000);
        const proofMessage = createProofMessage(
          depositTxHash, chain_name, withdrawal_requests, userAddress, timestamp,
        );
        const signature = await wallet.signMessage(proofMessage);
        const spendRequestId = ethers.utils.id(`${depositTxHash}:${chain_name}:0:${timestamp}`);

        const results = await api.requestKeyshares({
          depositTxHash,
          sourceChain: chain_name,
          withdrawalRequests: withdrawal_requests,
          userAddress,
          signature,
          timestamp,
          occurrenceOffset: 0,
          spendRequestId,
        });

        const successful = results.filter(r => r.success && r.keyshares && r.keyshares.length > 0);
        if (successful.length >= config.threshold) {
          claimResult = await processKeyshares(successful, [], withdrawal_requests, config.threshold);
          break;
        }

        const errors = results.filter(r => !r.success).map(f => f.error || '').join('; ');
        if (!errors.includes('confirmation') || attempt === 2) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                deposit_success: true,
                deposit_tx_hash: depositTxHash,
                claim_success: false,
                claim_error: `Only ${successful.length}/${config.threshold} nodes responded. ${errors}`,
                note: 'Deposit succeeded but key claim failed. You can retry claim_keys with the deposit_tx_hash.',
              }, null, 2),
            }],
          };
        }

        await new Promise(resolve => setTimeout(resolve, 10000));
      }

      if (!claimResult) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ deposit_success: true, deposit_tx_hash: depositTxHash, claim_success: false, note: 'Claim failed after retries' }) }],
        };
      }

      // Merge deposit info into claim result
      const claimData = JSON.parse(claimResult.content[0].text);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            deposit_tx_hash: depositTxHash,
            keys_count: claimData.keys_count,
            keys: claimData.keys,
            remaining_deposit: claimData.remaining_deposit,
            explorer_url: chain.block_explorer
              ? `${chain.block_explorer.replace(/\/+$/, '')}/tx/${depositTxHash}`
              : undefined,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

return server;
}

// ─── Start Server ───────────────────────────────────────────────────────────

async function main() {
  const mode = process.env.MCP_TRANSPORT || 'stdio';

  if (mode === 'http') {
    const http = await import('node:http');
    const crypto = await import('node:crypto');

    const port = parseInt(process.env.PORT || '3001');
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    const httpServer = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health check
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', transport: 'streamable-http', sessions: sessions.size }));
        return;
      }

      if (req.url !== '/mcp') {
        res.writeHead(404);
        res.end('Not found. Use /mcp for MCP endpoint or /health for health check.');
        return;
      }

      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      if (sessionId && !sessions.has(sessionId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found. Start a new session without mcp-session-id header.' }));
        return;
      }

      // Only POST can initialize a new session
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use POST to initialize a session.' }));
        return;
      }

      // New session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });

      transport.onclose = () => {
        const sid = (transport as any).sessionId;
        if (sid) sessions.delete(sid);
      };

      const sessionServer = createServer();
      await sessionServer.connect(transport);
      await transport.handleRequest(req, res);

      const sid = (transport as any).sessionId;
      if (sid) sessions.set(sid, transport);
    });

    httpServer.listen(port, () => {
      console.error(`BlackBox MCP server running on http://0.0.0.0:${port}/mcp`);
      console.error(`Health check: http://0.0.0.0:${port}/health`);
    });
  } else {
    const transport = new StdioServerTransport();
    await createServer().connect(transport);
  }
}

main().catch(console.error);

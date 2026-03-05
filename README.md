# BlackBox MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that enables AI agents to interact with the [BlackBox Protocol](https://theblackbox.network) — a privacy-preserving, cross-chain payment system built on distributed threshold cryptography.

## What is This?

This MCP server gives any AI agent the ability to:

- **Deposit** funds into the BlackBox treasury on any supported chain
- **Claim** one-time-use private keys via 3-of-5 distributed key generation
- **Withdraw** funds on any supported chain (including cross-chain)
- **Relay** gas-free withdrawals via the built-in relayer
- **Manage** wallets with encrypted local storage

The agent never sees the full private key during key generation — each of the 5 DKG nodes only holds a share. The agent reconstructs the key locally using Lagrange interpolation over secp256k1.

## Architecture

```
AI Agent (Claude, Cursor, Windsurf, custom agents)
    |
    | MCP Protocol (stdio)
    |
BlackBox MCP Server
    |
    |--- DKG Node 1 (theblackbox.network/node1)
    |--- DKG Node 2 (theblackbox.network/node2)
    |--- DKG Node 3 (theblackbox.network/node3)  ← 3-of-5 threshold
    |--- DKG Node 4 (theblackbox.network/node4)
    |--- DKG Node 5 (theblackbox.network/node5)
    |
    |--- EVM Chains (Sepolia, Base Sepolia, BNB Testnet, Polygon Amoy, Hyperliquid)
    |--- Solana (Devnet)
```

## Supported Chains & Denominations

50 registered merkle roots across 7 chains, 4 tokens, and 14 chain+token combinations:

| Chain | Token | Denominations |
|-------|-------|---------------|
| Sepolia | ETH | 0.001, 0.01, 0.05, 0.1, 0.5, 1 |
| Sepolia | USDC | 1, 2, 5, 10 |
| Sepolia | LINK | 0.5, 1, 2 |
| Base Sepolia | ETH | 0.001, 0.01, 0.05, 0.1 |
| Base Sepolia | USDC | 1, 2, 5 |
| BNB Testnet | TBNB | 0.01, 0.05, 0.1, 0.5 |
| BNB Testnet | USDC | 1, 2, 5 |
| BNB Testnet | LINK | 0.5, 1, 2 |
| Polygon Amoy | POL | 1, 2 |
| Polygon Amoy | USDC | 1, 2, 5 |
| Hyperliquid Testnet | HYPE | 0.01, 0.1, 0.5 |
| Hyperliquid Testnet | USDC | 1, 2, 5 |
| Solana Devnet | SOL | 0.1, 0.5, 1 |
| Solana Devnet | USDC | 1, 2, 5 |

> Use the `get_available_denominations` tool to query live denominations — new ones are added regularly.

## Quick Start

### 1. Install

```bash
git clone https://github.com/InterNullOrg/blackbox_mcp.git
cd blackbox_mcp
npm install
npm run build
```

### 2. Configure Your MCP Client

Add the server to your AI agent's MCP configuration.

<details>
<summary><strong>Claude Desktop</strong></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "blackbox": {
      "command": "node",
      "args": ["/absolute/path/to/blackbox_mcp/dist/index.js"],
      "env": {
        "DKG_NODE_1": "https://theblackbox.network/node1",
        "DKG_NODE_2": "https://theblackbox.network/node2",
        "DKG_NODE_3": "https://theblackbox.network/node3",
        "DKG_NODE_4": "https://theblackbox.network/node4",
        "DKG_NODE_5": "https://theblackbox.network/node5"
      }
    }
  }
}
```
</details>

<details>
<summary><strong>Claude Code</strong></summary>

Add to project `.mcp.json` or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "blackbox": {
      "command": "node",
      "args": ["/absolute/path/to/blackbox_mcp/dist/index.js"],
      "env": {
        "DKG_NODE_1": "https://theblackbox.network/node1",
        "DKG_NODE_2": "https://theblackbox.network/node2",
        "DKG_NODE_3": "https://theblackbox.network/node3",
        "DKG_NODE_4": "https://theblackbox.network/node4",
        "DKG_NODE_5": "https://theblackbox.network/node5"
      }
    }
  }
}
```
</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "blackbox": {
      "command": "node",
      "args": ["/absolute/path/to/blackbox_mcp/dist/index.js"],
      "env": {
        "DKG_NODE_1": "https://theblackbox.network/node1",
        "DKG_NODE_2": "https://theblackbox.network/node2",
        "DKG_NODE_3": "https://theblackbox.network/node3",
        "DKG_NODE_4": "https://theblackbox.network/node4",
        "DKG_NODE_5": "https://theblackbox.network/node5"
      }
    }
  }
}
```
</details>

<details>
<summary><strong>Development mode (hot reload)</strong></summary>

Use `tsx` instead of `node` for development:

```json
{
  "mcpServers": {
    "blackbox": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/blackbox_mcp/src/index.ts"],
      "env": {
        "DKG_NODE_1": "https://theblackbox.network/node1",
        "DKG_NODE_2": "https://theblackbox.network/node2",
        "DKG_NODE_3": "https://theblackbox.network/node3",
        "DKG_NODE_4": "https://theblackbox.network/node4",
        "DKG_NODE_5": "https://theblackbox.network/node5"
      }
    }
  }
}
```
</details>

### 3. Talk to Your Agent

Once configured, the agent automatically discovers all 18 tools. Example prompts:

```
"Create a wallet and deposit 0.1 ETH on Sepolia"
"Claim 10 keys of 0.001 ETH on Base Sepolia from my deposit"
"Withdraw key #3 to my wallet on Base Sepolia"
"Check the health of the DKG network"
"Move 0.05 ETH from Sepolia to Base Sepolia privately"
```

## Available Tools (18)

### Wallet Management
| Tool | Description |
|------|-------------|
| `create_wallet` | Create a new EVM or Solana wallet with encrypted storage |
| `import_wallet` | Import an existing wallet from a private key |
| `list_wallets` | List all stored wallets |
| `get_balance` | Get native and token balances on any chain |

### Protocol Discovery
| Tool | Description |
|------|-------------|
| `get_supported_chains` | List all supported chains with RPC URLs and treasury addresses |
| `get_chain_tokens` | Get tokens and denominations for a specific chain |
| `get_available_denominations` | Get registered denominations (merkle roots) for a chain |
| `get_token_mappings` | Get cross-chain token mapping rules |
| `check_health` | Check DKG network health |
| `get_leaderboard` | Get top depositors leaderboard |

### Core Operations
| Tool | Description |
|------|-------------|
| `deposit` | Deposit funds into the treasury (handles ERC20 approval automatically) |
| `claim_keys` | Request keyshares from DKG nodes and reconstruct private keys via Lagrange interpolation |
| `withdraw_onchain` | Execute on-chain withdrawal using a one-time key |
| `deposit_and_claim` | Combined deposit + claim in one step |

### Relay & Swap
| Tool | Description |
|------|-------------|
| `relay_withdraw` | Gas-free withdrawal via the relayer service |
| `check_relay_status` | Check relay job status |
| `get_relay_info` | Get relay service info and fees |
| `get_swap_quote` | Get cross-chain swap quote |

### Agent Guide Resource

The server exposes a `blackbox://agent-guide` resource containing detailed instructions for agents — denomination rules, security model, error handling, and step-by-step workflows. MCP-compatible agents read this automatically.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DKG_NODE_1` through `DKG_NODE_5` | Individual DKG node URLs | `http://localhost:8081-8085` |
| `DKG_NODE_URLS` | Comma-separated node URLs (alternative) | — |
| `DKG_THRESHOLD` | Minimum shares needed for reconstruction | `3` |
| `WALLET_STORE_PATH` | Path to encrypted wallet storage | `./wallets` |

## How It Works

### Deposit

1. Agent calls `deposit` with chain, amount, and token
2. MCP server submits a deposit transaction to the on-chain treasury contract
3. Treasury locks the funds

### Key Claim (Distributed Key Generation)

1. Agent calls `claim_keys` with the deposit tx hash and withdrawal requests
2. MCP server signs a proof message with the agent's wallet
3. Each of the 5 DKG nodes independently:
   - Verifies the deposit on-chain
   - Verifies the signature
   - Returns its keyshare (a partial secret)
4. MCP server reconstructs the full private key locally using **Lagrange interpolation** over secp256k1
5. Each key is a one-time-use ECDSA key tied to a specific merkle root and key index

No single node ever knows the full private key. Any 3-of-5 shares are sufficient.

### Withdrawal

1. Agent calls `withdraw_onchain` (or `relay_withdraw` for gas-free)
2. MCP server signs the withdrawal message with the reconstructed one-time key
3. The treasury contract verifies:
   - ECDSA signature validity
   - Merkle proof (key belongs to a registered batch)
   - Nullifier (key hasn't been used before)
4. Funds are released to the recipient
5. The key is permanently marked as spent

### Cross-Chain

Deposits on chain A can generate withdrawal keys for chain B. Requirements:
- A valid token mapping exists between the chains (admin-configured)
- The denomination is registered on the target chain
- The deposit amount covers the total requested value

## Security Model

| Property | Implementation |
|----------|---------------|
| No single point of failure | 3-of-5 threshold — any 3 nodes reconstruct, no pair can |
| One-time keys | On-chain nullifier prevents reuse |
| Wallet encryption | AES-256-GCM with PBKDF2 (100k iterations) |
| Request authentication | ECDSA/Ed25519 signature on every keyshare request |
| Deposit verification | Each node independently verifies deposits on-chain |
| Idempotent claims | Re-requesting same deposit returns identical keys |
| UTXO model | Deposit fully allocated on first claim; different configs rejected |
| Timestamp validation | Requests must be within 5 minutes |

## Agentic Usage Patterns

### Privacy Payment Agent
```
1. create_wallet → agent wallet
2. (user funds wallet with ETH)
3. deposit → 0.001 ETH on Sepolia
4. claim_keys → 1 key for base_sepolia
5. withdraw_onchain → sends to recipient on Base Sepolia
   (deposit chain != withdrawal chain = unlinkable)
```

### Batch Payment Agent
```
1. deposit → 0.1 ETH on Sepolia
2. claim_keys → 100 keys of 0.001 ETH across multiple chains
3. withdraw_onchain → execute each withdrawal to different recipients
   (each withdrawal is independent and unlinkable)
```

### Gas-Free Agent
```
1. claim_keys → get keys from a previous deposit
2. get_relay_info → check if relay is enabled + get fees
3. relay_withdraw → relayer pays gas on target chain
4. check_relay_status → poll until confirmed
```

## Testing

The repository includes test suites that were used to validate the protocol:

```bash
# End-to-end: deposit → claim → withdraw
npx tsx test-e2e.ts

# Edge cases: invalid denominations, double-spend, wrong signer, expired timestamps
npx tsx test-edge-cases.ts

# 100-key stress test: all C(5,3)=10 share combinations per key
npx tsx test-100-keys.ts

# Cross-chain 50+50 split with timing measurements
npx tsx test-100-keys-v2.ts

# Idempotency: re-claim returns identical keys
npx tsx test-idempotency-splits.ts
```

### Test Results (Verified)

- 200 keys generated across test runs — all reconstructed successfully
- 2000 share combinations tested (10 per key) — all passed
- All key_indexes and addresses are unique per batch
- Re-claims return identical keys (verified 3 times independently)
- Backend rejects different claim configs for same deposit (UTXO model)
- Key retrieval: ~52s for 100 keys (P2P mini-VSS exchange)
- Local reconstruction: ~5ms per key (Lagrange interpolation)

## Project Structure

```
blackbox_mcp/
├── src/
│   ├── index.ts      # MCP server — 18 tools + agent guide resource
│   ├── api.ts        # BlackBox API client (DKG node communication)
│   ├── config.ts     # Environment configuration loader
│   ├── crypto.ts     # Lagrange interpolation, ECDSA signatures, key reconstruction
│   └── wallet.ts     # Encrypted wallet manager (AES-256-GCM + PBKDF2)
├── package.json
├── tsconfig.json
└── test-*.ts         # Test suites
```

## License

MIT

# BlackBox MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that enables AI agents to interact with the [BlackBox Protocol](https://theblackbox.network) — a privacy-preserving, cross-chain payment system built on distributed threshold cryptography.

For the complete tool reference including all parameters, example calls, and example responses, see [llms-full.txt](llms-full.txt).

---

## What it does

The MCP server gives any AI agent the ability to:

- Deposit tokens into an on-chain treasury on any supported chain
- Claim one-time-use private keys via 3-of-5 distributed key generation
- Withdraw funds on any supported chain (including cross-chain)
- Relay gas-free withdrawals via the built-in relayer service
- Manage wallets with encrypted local storage

---

## Install

```bash
git clone https://github.com/InterNullOrg/blackbox_mcp.git
cd blackbox_mcp
npm install
npm run build
```

---

## Config

Add the server to your MCP client configuration. Replace the path with the absolute path to your clone.

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

Config file locations:

| Client         | Config file path                                                      |
|----------------|-----------------------------------------------------------------------|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` (Windows)              |
| Claude Code    | `.mcp.json` in project root, or `~/.claude/settings.json`            |
| Cursor         | `.cursor/mcp.json` in project root                                    |

### Environment Variables

| Variable             | Description                                         | Default                  |
|----------------------|-----------------------------------------------------|--------------------------|
| `DKG_NODE_1`–`5`    | Individual DKG node URLs                            | `http://localhost:8081–8085` |
| `DKG_NODE_URLS`      | Comma-separated node URLs (alternative)             | —                        |
| `DKG_THRESHOLD`      | Minimum shares for key reconstruction               | `3`                      |
| `WALLET_STORE_PATH`  | Path to encrypted wallet storage                    | `./wallets`              |

---

## Auth

No API keys or OAuth tokens are required. Authentication is wallet-based:

- The agent creates or imports an EVM/Solana wallet (stored encrypted with AES-256-GCM + PBKDF2 at 100k iterations).
- Each key claim request is signed with the agent's wallet private key. The DKG nodes independently verify that the deposit was made by the requesting address.
- Timestamps must be fresh (within ~5 minutes). Stale requests are rejected.

The agent wallet password is required as a parameter in each tool call that accesses the wallet.

---

## Tools (18)

### Wallet Management

| Tool | Description |
|------|-------------|
| `create_wallet` | Create a new EVM or Solana wallet. Returns address and private key (shown once). Stores encrypted. |
| `import_wallet` | Import an existing EVM wallet from a private key. |
| `list_wallets` | List all stored wallets (names and addresses). |
| `get_balance` | Get native and/or token balance on any supported chain. |

### Protocol Discovery

| Tool | Description |
|------|-------------|
| `get_supported_chains` | List all supported chains with RPC URLs, treasury addresses, and chain metadata. |
| `get_chain_tokens` | Get tokens and decimals for a specific chain. Always check decimals — BNB USDC uses 18, not 6. |
| `get_available_denominations` | Get registered deposit amounts (merkle roots) for a chain. Deposit amounts must match exactly. |
| `get_token_mappings` | Get cross-chain token mapping rules (which tokens can move between which chains). |
| `check_health` | Check DKG network health (nodes online, threshold status). |
| `get_leaderboard` | Get top depositors leaderboard. |

### Core Operations

| Tool | Description |
|------|-------------|
| `deposit` | Deposit funds into the treasury. Handles ERC20 approval automatically. Returns tx hash for `claim_keys`. |
| `claim_keys` | Request keyshares from all DKG nodes and reconstruct one-time withdrawal keys via Lagrange interpolation. |
| `withdraw_onchain` | Execute an on-chain withdrawal using a claimed key. Agent wallet pays gas. |
| `deposit_and_claim` | Combined deposit + claim in one step. Waits for block confirmations internally. |

### Relay and Swap

| Tool | Description |
|------|-------------|
| `relay_withdraw` | Gas-free withdrawal via the relayer service. Relayer pays gas and takes a fee. |
| `check_relay_status` | Poll relay job status until confirmed. |
| `get_relay_info` | Check if relay is enabled, get relayer address and fees. |
| `get_swap_quote` | Get a cross-chain swap quote from the relay service. |

---

## MCP Resource

The server exposes one resource at `blackbox://agent-guide`. It contains detailed step-by-step workflow instructions, denomination rules, security model notes, and error handling guidance. MCP-compatible clients read this automatically on connection.

---

## Typical Workflow

```
1. create_wallet           # Create agent wallet
2. (fund wallet with ETH/USDC)
3. get_available_denominations  # Check valid deposit amounts
4. deposit                 # Lock funds in treasury on chain A
5. claim_keys              # Get one-time keys (can target chain B)
6. withdraw_onchain        # Release funds to recipient on chain B
```

The deposit chain and withdrawal chain are never linked on-chain, providing sender privacy.

---

## Key Constraints

- Deposit amount must exactly match a registered denomination (call `get_available_denominations` first).
- The wallet claiming keys must be the same address that made the deposit.
- Token types are enforced: deposit USDC, you must claim USDC keys (not ETH).
- Each withdrawal key is one-time-use; the on-chain nullifier prevents reuse.
- Keys are chain-specific: a key claimed for `base_sepolia` cannot be used on `sepolia`.
- For relay withdrawal, `max_relayer_fee` must be > 0.

---

## Supported Chains

| Chain               | Native Token | EVM / Solana |
|---------------------|-------------|--------------|
| Sepolia             | ETH         | EVM          |
| Base Sepolia        | ETH         | EVM          |
| BNB Testnet         | TBNB        | EVM          |
| Polygon Amoy        | POL         | EVM          |
| Hyperliquid Testnet | HYPE        | EVM          |
| Solana Devnet       | SOL         | Solana       |

---

See [llms-full.txt](llms-full.txt) for complete parameter tables, example calls, and example responses for every tool.

# BlackBox Protocol — API and Protocol Reference

This page documents the underlying protocol endpoints and on-chain contracts used by the BlackBox MCP server. The MCP server is the primary and recommended interface for AI agents. Direct API access is only needed if you are building a custom client or debugging.

For the agent-facing tool reference, see [mcp.md](mcp.md) and [llms-full.txt](llms-full.txt).

---

## Interface Summary

The BlackBox MCP server is the only supported interface for AI agents. There is no separate public REST API exposed to end users. The MCP server communicates internally with:

1. **DKG node HTTP API** — for keyshare requests, chain config, relay operations.
2. **EVM/Solana RPC** — for on-chain deposits and withdrawals via the treasury contract.

---

## DKG Node HTTP API

Each of the 5 DKG nodes exposes a REST API. The MCP server fans out requests to all nodes and collects at least 3 successful responses before reconstructing a key.

Default node URLs (production):
```
https://theblackbox.network/node1
https://theblackbox.network/node2
https://theblackbox.network/node3
https://theblackbox.network/node4
https://theblackbox.network/node5
```

All endpoints accept and return JSON. No authentication headers are required for read endpoints. Write endpoints (keyshare requests) are authenticated via ECDSA signature in the request body.

### Read Endpoints

#### `GET /api/health`

Check node health.

**Response:**
```json
{
  "status": "ok",
  "node_id": 1
}
```

---

#### `GET /api/config/chains`

Get all supported chains.

**Response:**
```json
{
  "chains": [
    {
      "ChainName": "sepolia",
      "ChainID": 11155111,
      "ChainType": "evm",
      "RPCURL": "https://rpc.sepolia.org",
      "TreasuryAddress": "0x...",
      "BlockExplorer": "https://sepolia.etherscan.io",
      "NativeCurrency": "ETH",
      "SupportedTokens": ["USDC", "LINK"]
    }
  ]
}
```

---

#### `GET /api/config/tokens?chain=<chain_name>`

Get tokens for a chain.

**Query parameters:**
- `chain` (string): chain name (e.g., `sepolia`)

**Response:**
```json
{
  "tokens": [
    {
      "Symbol": "USDC",
      "Address": "0xUSDC...",
      "Decimals": 6
    }
  ]
}
```

---

#### `GET /api/config/merkle-roots?chain=<chain_name>`

Get registered merkle roots (valid denominations) for a chain.

**Query parameters:**
- `chain` (string, optional): filter by chain name

**Response:**
```json
{
  "merkle_roots": [
    {
      "Denomination": "1",
      "MerkleRootIDOnChain": 6,
      "TokenSymbol": "USDC",
      "ChainName": "sepolia"
    }
  ]
}
```

Only entries with `MerkleRootIDOnChain >= 0` are active.

---

#### `GET /api/token-mappings`

Get cross-chain token mapping rules.

**Response:** Object keyed by token symbol, with chain-pair sub-objects.

```json
{
  "ETH": {
    "sepolia:base_sepolia": {
      "source_token": "ETH",
      "target_token": "ETH",
      "rate": "1"
    }
  }
}
```

---

#### `GET /api/v2/leaderboard?limit=<n>`

Get top depositors.

**Query parameters:**
- `limit` (number, default 100): max entries

---

#### `GET /api/v2/relay/info`

Get relay service info.

**Response:**
```json
{
  "info": {
    "enabled": true,
    "evm_relayer_address": "0xRelayer...",
    "supported_chains": ["sepolia", "base_sepolia"]
  }
}
```

---

#### `GET /api/v2/relay/status/<job_id>`

Get relay job status.

**Response:**
```json
{
  "job_id": "uuid",
  "status": "confirmed",
  "tx_hash": "0x..."
}
```

---

### Write Endpoints

#### `POST /api/v2/request-keyshare`

Request a keyshare from a DKG node. Called by the MCP server for each of the 5 nodes in parallel. Requires a valid ECDSA signature from the depositor's wallet.

**Request body:**
```json
{
  "deposit_tx_hash": "0xdeposit...",
  "source_chain": "sepolia",
  "withdrawal_requests": [
    {
      "target_chain": "base_sepolia",
      "token_symbol": "USDC",
      "denomination": "1"
    }
  ],
  "user_address": "0xDepositorAddress...",
  "signature": "0xECDSAsignature...",
  "timestamp": 1700000000,
  "occurrence_offset": 0,
  "spend_request_id": "0xhash..."
}
```

**Signature construction:**

The proof message that is signed is constructed by the MCP server's `createProofMessage` function (`src/crypto.ts`). The message covers: `deposit_tx_hash`, `source_chain`, `withdrawal_requests`, `user_address`, and `timestamp`. The wallet signs the message using `ethers.Wallet.signMessage`.

**Response (success):**
```json
{
  "success": true,
  "node_id": 1,
  "keyshares": [
    {
      "share_id": "share-uuid",
      "share_value": "hex-encoded-share",
      "key_index": 42,
      "address": "0xKeyAddress...",
      "merkle_root": "0xroot...",
      "merkle_root_id": 6,
      "merkle_proof": ["0xproof1...", "0xproof2..."],
      "denomination": "1",
      "chain_name": "base_sepolia",
      "chain_id": 84532,
      "treasury_address": "0xTreasury...",
      "token_symbol": "USDC",
      "token_address": "0xUSDC...",
      "token_decimals": 6
    }
  ],
  "threshold": 3,
  "total_nodes": 5,
  "deposit_amount": 1,
  "claimed_amount": 1,
  "remaining_deposit": 0
}
```

The MCP server collects at least 3 successful responses, extracts the `share_value` from each, and reconstructs the full private key locally using Lagrange interpolation over secp256k1 (`src/crypto.ts: reconstructPrivateKey`).

---

#### `POST /api/v2/relay/withdraw`

Submit a relay withdrawal job. The relayer will submit the on-chain withdrawal transaction.

**Request body:**
```json
{
  "chain": "base_sepolia",
  "chain_type": "evm",
  "recipient": "0xRecipient...",
  "amount": "1000000",
  "token": "0xUSDC...",
  "signature": "0xRelayWithdrawalSig...",
  "merkle_proof": ["0xproof1..."],
  "merkle_root_id": 6,
  "key_index": 42,
  "max_relayer_fee": "100000"
}
```

The relay withdrawal signature differs from the direct on-chain withdrawal signature. It includes the relayer address and max relayer fee in the signed message (`src/crypto.ts: createRelayWithdrawalSignature`).

**Response:**
```json
{
  "job_id": "relay-job-uuid",
  "status": "pending"
}
```

---

#### `POST /api/v2/relay/quote-swap`

Get a cross-chain swap quote.

**Request body:**
```json
{
  "asset_identifier_in": "USDC_sepolia",
  "asset_identifier_out": "USDC_base_sepolia",
  "exact_amount_in": "1000000",
  "swapType": "EXACT_IN",
  "dry": true
}
```

---

## On-Chain Contracts

### Treasury Contract

Each supported chain has a deployed treasury contract. Addresses are returned by `GET /api/config/chains`.

**ABI (relevant functions):**

```solidity
function deposit(address token, uint256 amount) payable;

function withdraw(
  address token,
  address payable recipient,
  uint256 amount,
  uint256 merkleRootId,
  bytes signature,
  bytes32[] merkleProof,
  uint256 keyIndex
);
```

**`deposit`:**
- For native tokens: pass `address(0)` as `token`, send ETH as `msg.value`.
- For ERC20 tokens: pass the token contract address, amount in base units. ERC20 approval must be granted first (the MCP server does this automatically).
- Polygon Amoy requires a minimum 30 gwei priority fee (handled by the MCP server).

**`withdraw`:**
- `signature`: ECDSA signature from the one-time withdrawal key over the withdrawal message. Message covers: recipient, token, amount, merkleRootId, keyIndex, chainId.
- `merkleProof`: Proof that the key belongs to the registered batch.
- `keyIndex`: Identifies which key in the merkle tree.
- The contract verifies the ECDSA signature, the merkle proof, and that the nullifier (key) has not been used before.

### ERC20 Approval

Before depositing an ERC20 token, the treasury contract must be approved as a spender. The MCP server checks the current allowance and submits an `approve` transaction automatically if needed.

---

## Key Reconstruction

Key reconstruction happens entirely on the MCP server (client side). The DKG nodes never know the full key.

1. The MCP server sends the keyshare request to all 5 nodes in parallel.
2. Each node returns its `share_value` (a scalar on secp256k1).
3. The MCP server collects at least `threshold` (default: 3) successful share responses.
4. It runs Lagrange interpolation over the shares to recover the secret scalar (`src/crypto.ts: reconstructPrivateKey`).
5. It verifies the reconstructed key matches the expected Ethereum address (`verifyKeyMatchesAddress`).
6. The reconstructed private key is returned to the agent as part of the `claim_keys` response.

The private key is a one-time-use ECDSA key. It must only be used once for withdrawal.

---

## Data Flow Diagram

```
Agent                   MCP Server              DKG Nodes (x5)         EVM Chain
  |                         |                        |                     |
  |--- deposit() ---------> |                        |                     |
  |                         |--- treasury.deposit() ------------------>   |
  |                         |<-- tx_hash --------------------------------  |
  |<-- tx_hash ------------ |                        |                     |
  |                         |                        |                     |
  |--- claim_keys() ------> |                        |                     |
  |                         |--- POST /request-keyshare --> node1          |
  |                         |--- POST /request-keyshare --> node2          |
  |                         |--- POST /request-keyshare --> node3          |
  |                         |--- POST /request-keyshare --> node4          |
  |                         |--- POST /request-keyshare --> node5          |
  |                         |<-- share1, share2, share3 (3-of-5) ------   |
  |                         |--- Lagrange interpolation (local)            |
  |<-- private_key -------- |                        |                     |
  |                         |                        |                     |
  |--- withdraw_onchain() ->|                        |                     |
  |                         |--- treasury.withdraw() ------------------>  |
  |                         |<-- receipt --------------------------------  |
  |<-- tx_hash ------------ |                        |                     |
```

---

## Source

https://github.com/InterNullOrg/blackbox_mcp

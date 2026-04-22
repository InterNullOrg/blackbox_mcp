import { InterNullConfig } from './config.js';

export interface ChainInfo {
  chain_name: string;
  chain_id: number;
  chain_type: string;
  name: string;
  rpc_url: string;
  treasury_address: string;
  block_explorer: string;
  native_currency: string;
  supported_tokens: string[];
}

export interface MerkleRoot {
  denomination: string;
  merkle_root_id_on_chain: number;
  token_symbol: string;
  chain_name: string;
}

export interface KeyshareResult {
  share_id: string;
  share_value: string;
  key_index: number;
  address: string;
  merkle_root: string;
  merkle_root_id: number;
  merkle_proof: string[];
  denomination: string;
  chain_name: string;
  chain_id: number;
  treasury_address: string;
  token_symbol: string;
  token_address: string;
  token_decimals: number;
}

export interface NodeKeyshareResponse {
  success: boolean;
  node_id: number;
  keyshares: KeyshareResult[];
  threshold: number;
  total_nodes: number;
  deposit_amount: number;
  claimed_amount: number;
  remaining_deposit: number;
}

export class InterNullAPI {
  private config: InterNullConfig;

  constructor(config: InterNullConfig) {
    this.config = config;
  }

  private async fetchFromAnyNode<T>(path: string): Promise<T> {
    const errors: string[] = [];
    for (const nodeUrl of this.config.nodeUrls) {
      try {
        const resp = await fetch(`${nodeUrl}${path}`);
        if (!resp.ok) {
          errors.push(`${nodeUrl}: HTTP ${resp.status}`);
          continue;
        }
        return await resp.json() as T;
      } catch (e: any) {
        errors.push(`${nodeUrl}: ${e.message}`);
      }
    }
    throw new Error(`All nodes failed for ${path}: ${errors.join('; ')}`);
  }

  async getHealth(): Promise<any> {
    return this.fetchFromAnyNode('/api/health');
  }

  async getChains(): Promise<ChainInfo[]> {
    const data = await this.fetchFromAnyNode<any>('/api/config/chains');
    return (data.chains || []).map((c: any) => ({
      chain_name: c.ChainName || c.chain_name,
      chain_id: c.ChainID || c.chain_id,
      chain_type: c.ChainType || c.chain_type,
      name: c.Name || c.name || c.ChainName || c.chain_name,
      rpc_url: c.RPCURL || c.rpc_url,
      treasury_address: c.TreasuryAddress || c.treasury_address,
      block_explorer: c.BlockExplorer || c.block_explorer,
      native_currency: c.NativeCurrency || c.native_currency,
      supported_tokens: c.SupportedTokens || c.supported_tokens || [],
    }));
  }

  async getTokens(chain: string): Promise<any[]> {
    const data = await this.fetchFromAnyNode<any>(`/api/config/tokens?chain=${chain}`);
    return data.tokens || [];
  }

  async getMerkleRoots(chain?: string): Promise<MerkleRoot[]> {
    const path = chain ? `/api/config/merkle-roots?chain=${chain}` : '/api/config/merkle-roots';
    const data = await this.fetchFromAnyNode<any>(path);
    return (data.merkle_roots || [])
      .filter((r: any) => (r.MerkleRootIDOnChain ?? r.merkle_root_id_on_chain ?? -1) >= 0)
      .map((r: any) => ({
        denomination: r.Denomination || r.denomination,
        merkle_root_id_on_chain: r.MerkleRootIDOnChain ?? r.merkle_root_id_on_chain,
        token_symbol: r.TokenSymbol || r.token_symbol || 'ETH',
        chain_name: r.ChainName || r.chain_name,
      }));
  }

  async getTokenMappings(): Promise<any> {
    const data = await this.fetchFromAnyNode<any>('/api/token-mappings');
    // API returns an object keyed by token symbol (e.g., { ETH: { "sepolia:base_sepolia": {...} } })
    // not an array
    return data;
  }

  async getLeaderboard(limit = 100): Promise<any> {
    return this.fetchFromAnyNode(`/api/v2/leaderboard?limit=${limit}`);
  }

  async requestKeyshares(params: {
    depositTxHash: string;
    sourceChain: string;
    withdrawalRequests: Array<{ target_chain: string; token_symbol: string; denomination: string }>;
    userAddress: string;
    signature: string;
    timestamp: number;
    occurrenceOffset?: number;
    spendRequestId?: string;
  }): Promise<Array<{ success: boolean; nodeId?: number; keyshares?: KeyshareResult[]; threshold?: number; depositAmount?: number; claimedAmount?: number; remainingDeposit?: number; error?: string }>> {
    const promises = this.config.nodeUrls.map(async (nodeUrl) => {
      try {
        const resp = await fetch(`${nodeUrl}/api/v2/request-keyshare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deposit_tx_hash: params.depositTxHash,
            source_chain: params.sourceChain,
            withdrawal_requests: params.withdrawalRequests,
            user_address: params.userAddress,
            signature: params.signature,
            timestamp: params.timestamp,
            occurrence_offset: params.occurrenceOffset || 0,
            spend_request_id: params.spendRequestId || '',
          }),
        });

        if (!resp.ok) {
          const text = await resp.text();
          return { success: false, error: `Node ${nodeUrl}: ${resp.status} ${text}` };
        }

        const data = await resp.json() as NodeKeyshareResponse;
        if (!data.success) {
          return { success: false, error: (data as any).error || 'Unknown error' };
        }

        return {
          success: true,
          nodeId: data.node_id,
          keyshares: data.keyshares,
          threshold: data.threshold,
          depositAmount: data.deposit_amount,
          claimedAmount: data.claimed_amount,
          remainingDeposit: data.remaining_deposit,
        };
      } catch (e: any) {
        return { success: false, error: `Node ${nodeUrl}: ${e.message}` };
      }
    });

    return Promise.all(promises);
  }

  async relayWithdraw(params: {
    chain: string;
    chainType: string;
    recipient: string;
    amount: string;
    token?: string;
    signature: string;
    merkleProof: string[];
    merkleRootId: number;
    keyIndex: number;
    maxRelayerFee?: string;
    publicKey?: string; // Ed25519 public key (base58), required for Solana
    treasuryTokenAccount?: string; // Treasury ATA (base58), required for Solana SPL tokens
  }): Promise<any> {
    // Try coordinator node first, then others
    const errors: string[] = [];
    for (const nodeUrl of this.config.nodeUrls) {
      try {
        const body: any = {
          chain: params.chain,
          chain_type: params.chainType,
          recipient: params.recipient,
          amount: params.amount,
          token: params.token,
          signature: params.signature,
          merkle_proof: params.merkleProof,
          merkle_root_id: params.merkleRootId,
          key_index: params.keyIndex,
          max_relayer_fee: params.maxRelayerFee || '0',
        };
        if (params.publicKey) body.public_key = params.publicKey;
        if (params.treasuryTokenAccount) body.treasury_token_account = params.treasuryTokenAccount;
        const resp = await fetch(`${nodeUrl}/api/v2/relay/withdraw`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const data = await resp.json();
        if (resp.ok) return data;
        errors.push(`${nodeUrl}: ${JSON.stringify(data)}`);
      } catch (e: any) {
        errors.push(`${nodeUrl}: ${e.message}`);
      }
    }
    throw new Error(`Relay withdraw failed: ${errors.join('; ')}`);
  }

  async getRelayStatus(jobId: string): Promise<any> {
    return this.fetchFromAnyNode(`/api/v2/relay/status/${jobId}`);
  }

  async getSwapQuote(params: {
    assetIn: string;
    assetOut: string;
    amount: string;
    swapType?: string;
    dry?: boolean;
  }): Promise<any> {
    const nodeUrl = this.config.nodeUrls[0];
    const resp = await fetch(`${nodeUrl}/api/v2/relay/quote-swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset_identifier_in: params.assetIn,
        asset_identifier_out: params.assetOut,
        exact_amount_in: params.amount,
        swapType: params.swapType || 'EXACT_IN',
        dry: params.dry ?? true,
      }),
    });
    return resp.json();
  }

  async getRelayInfo(): Promise<any> {
    return this.fetchFromAnyNode('/api/v2/relay/info');
  }
}

import { existsSync } from 'fs';
import { join } from 'path';

export interface InterNullConfig {
  nodeUrls: string[];
  threshold: number;
  walletStorePath: string;
}

function resolveWalletStorePath(): string {
  const envPath = process.env.WALLET_STORE_PATH;
  if (envPath) return envPath;

  const home = process.env.HOME || process.env.USERPROFILE || '.';
  const newPath = join(home, '.internull-mcp', 'wallets');
  const legacyPath = join(home, '.blackbox-mcp', 'wallets');

  // If we have a legacy wallet store but no new one yet, keep reading from legacy.
  // Existing users don't silently lose access to wallets they created under the old path.
  if (!existsSync(join(newPath, 'wallets.json')) && existsSync(join(legacyPath, 'wallets.json'))) {
    return legacyPath;
  }
  return newPath;
}

export function loadConfig(): InterNullConfig {
  const nodeUrls: string[] = [];

  // Check for individual node URLs (DKG_NODE_1 through DKG_NODE_5)
  for (let i = 1; i <= 5; i++) {
    const url = process.env[`DKG_NODE_${i}`];
    if (url) nodeUrls.push(url);
  }

  // Fallback to comma-separated list
  if (nodeUrls.length === 0 && process.env.DKG_NODE_URLS) {
    nodeUrls.push(...process.env.DKG_NODE_URLS.split(',').map(u => u.trim()));
  }

  // Default: production DKG nodes
  if (nodeUrls.length === 0) {
    for (let i = 1; i <= 5; i++) {
      nodeUrls.push(`https://theblackbox.network/node${i}`);
    }
  }

  return {
    nodeUrls,
    threshold: parseInt(process.env.DKG_THRESHOLD || '3'),
    walletStorePath: resolveWalletStorePath(),
  };
}

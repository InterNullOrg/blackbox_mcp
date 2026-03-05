export interface BlackBoxConfig {
  nodeUrls: string[];
  threshold: number;
  walletStorePath: string;
}

export function loadConfig(): BlackBoxConfig {
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

  // Default: 5 local nodes
  if (nodeUrls.length === 0) {
    for (let i = 1; i <= 5; i++) {
      nodeUrls.push(`http://localhost:${8080 + i}`);
    }
  }

  return {
    nodeUrls,
    threshold: parseInt(process.env.DKG_THRESHOLD || '3'),
    walletStorePath: process.env.WALLET_STORE_PATH || './wallets',
  };
}

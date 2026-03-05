import { ethers } from 'ethers';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface StoredWallet {
  name: string;
  address: string;
  encryptedKey: string;  // AES-256-GCM encrypted private key
  iv: string;
  tag: string;
  createdAt: string;
  walletType: 'evm' | 'solana';
}

const ALGO = 'aes-256-gcm';

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
}

function encrypt(plaintext: string, password: string): { ciphertext: string; iv: string; tag: string; salt: string } {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return { ciphertext: encrypted, iv: iv.toString('hex'), tag: tag.toString('hex'), salt: salt.toString('hex') };
}

function decrypt(ciphertext: string, iv: string, tag: string, salt: string, password: string): string {
  const key = deriveKey(password, Buffer.from(salt, 'hex'));
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export class WalletManager {
  private storePath: string;
  private wallets: Map<string, StoredWallet & { salt: string }> = new Map();

  constructor(storePath: string) {
    this.storePath = storePath;
    if (!fs.existsSync(storePath)) {
      fs.mkdirSync(storePath, { recursive: true });
    }
    this.loadWallets();
  }

  private walletsFile(): string {
    return path.join(this.storePath, 'wallets.json');
  }

  private loadWallets() {
    const file = this.walletsFile();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      for (const w of data) {
        this.wallets.set(w.name, w);
      }
    }
  }

  private saveWallets() {
    const file = this.walletsFile();
    fs.writeFileSync(file, JSON.stringify(Array.from(this.wallets.values()), null, 2));
  }

  createWallet(name: string, password: string, type: 'evm' | 'solana' = 'evm'): { address: string; privateKey: string } {
    if (this.wallets.has(name)) {
      throw new Error(`Wallet "${name}" already exists`);
    }

    let address: string;
    let privateKeyStr: string;

    if (type === 'solana') {
      const keypair = Keypair.generate();
      address = keypair.publicKey.toBase58();
      privateKeyStr = bs58.encode(keypair.secretKey);
    } else {
      const wallet = ethers.Wallet.createRandom();
      address = wallet.address;
      privateKeyStr = wallet.privateKey;
    }

    const { ciphertext, iv, tag, salt } = encrypt(privateKeyStr, password);

    this.wallets.set(name, {
      name,
      address,
      encryptedKey: ciphertext,
      iv,
      tag,
      salt,
      walletType: type,
      createdAt: new Date().toISOString(),
    });
    this.saveWallets();

    return { address, privateKey: privateKeyStr };
  }

  importWallet(name: string, privateKey: string, password: string, type: 'evm' | 'solana' = 'evm'): { address: string } {
    if (this.wallets.has(name)) {
      throw new Error(`Wallet "${name}" already exists`);
    }

    let address: string;
    if (type === 'solana') {
      const decoded = bs58.decode(privateKey);
      const keypair = Keypair.fromSecretKey(decoded);
      address = keypair.publicKey.toBase58();
    } else {
      const wallet = new ethers.Wallet(privateKey);
      address = wallet.address;
    }

    const { ciphertext, iv, tag, salt } = encrypt(privateKey, password);

    this.wallets.set(name, {
      name,
      address,
      encryptedKey: ciphertext,
      iv,
      tag,
      salt,
      walletType: type,
      createdAt: new Date().toISOString(),
    });
    this.saveWallets();

    return { address };
  }

  getWallet(name: string): StoredWallet | undefined {
    return this.wallets.get(name);
  }

  getSigner(name: string, password: string, provider: ethers.providers.Provider): ethers.Wallet {
    const stored = this.wallets.get(name);
    if (!stored) throw new Error(`Wallet "${name}" not found`);

    const privateKey = decrypt(stored.encryptedKey, stored.iv, stored.tag, stored.salt, password);
    return new ethers.Wallet(privateKey, provider);
  }

  getPrivateKey(name: string, password: string): string {
    const stored = this.wallets.get(name);
    if (!stored) throw new Error(`Wallet "${name}" not found`);
    return decrypt(stored.encryptedKey, stored.iv, stored.tag, stored.salt, password);
  }

  listWallets(): Array<{ name: string; address: string; type: string; createdAt: string }> {
    return Array.from(this.wallets.values()).map(w => ({
      name: w.name,
      address: w.address,
      type: w.walletType || 'evm',
      createdAt: w.createdAt,
    }));
  }

  deleteWallet(name: string): boolean {
    const deleted = this.wallets.delete(name);
    if (deleted) this.saveWallets();
    return deleted;
  }
}

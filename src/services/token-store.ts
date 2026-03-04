/**
 * Persists Google OAuth tokens to a local JSON file.
 * For production, replace with a proper database (Postgres, Redis, etc.).
 */
import * as fs from 'fs';
import { GoogleTokens, UserTokenRecord } from '../types';
import { config } from '../config';

type TokenStore = Record<string, UserTokenRecord>;

let store: TokenStore = {};

// Load persisted tokens on startup
try {
  if (fs.existsSync(config.tokenStorePath)) {
    const data = fs.readFileSync(config.tokenStorePath, 'utf-8');
    store = JSON.parse(data) as TokenStore;
    console.log(`[token-store] Loaded ${Object.keys(store).length} user token(s)`);
  }
} catch (err) {
  console.warn('[token-store] Could not load token store, starting fresh:', err);
}

function persist(): void {
  try {
    fs.writeFileSync(config.tokenStorePath, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('[token-store] Failed to persist:', err);
  }
}

export function saveTokens(slackUserId: string, googleEmail: string, tokens: GoogleTokens): void {
  store[slackUserId] = { slackUserId, googleEmail, tokens };
  persist();
}

export function getTokenRecord(slackUserId: string): UserTokenRecord | undefined {
  return store[slackUserId];
}

export function removeTokens(slackUserId: string): void {
  delete store[slackUserId];
  persist();
}

export function getAllConnectedUsers(): UserTokenRecord[] {
  return Object.values(store);
}

export function isConnected(slackUserId: string): boolean {
  return !!store[slackUserId];
}

/**
 * Telegram Authentication Script
 *
 * Run this during setup to authenticate with Telegram via MTProto.
 * Prompts for API credentials, phone number, verification code, and optional 2FA.
 * Saves credentials and session string for the main app to use.
 *
 * Usage: npx tsx src/telegram-auth.ts
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';
import fs from 'fs';
import path from 'path';

const AUTH_DIR = './store/auth';
const CREDENTIALS_PATH = path.join(AUTH_DIR, 'telegram-credentials.json');
const SESSION_PATH = path.join(AUTH_DIR, 'session.txt');

interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

function loadCredentials(): TelegramCredentials | null {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const data = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
      if (data.apiId && data.apiHash) return data;
    }
  } catch { /* ignore */ }
  return null;
}

function loadSession(): string {
  try {
    if (fs.existsSync(SESSION_PATH)) {
      return fs.readFileSync(SESSION_PATH, 'utf-8').trim();
    }
  } catch { /* ignore */ }
  return '';
}

async function authenticate(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  // Load or prompt for API credentials
  let credentials = loadCredentials();
  if (!credentials) {
    console.log('Telegram API credentials required.');
    console.log('Get them from: https://my.telegram.org/apps\n');

    const apiIdStr = await input.text('Enter your api_id:');
    const apiId = parseInt(apiIdStr, 10);
    if (isNaN(apiId)) {
      console.error('Invalid api_id - must be a number.');
      process.exit(1);
    }

    const apiHash = await input.text('Enter your api_hash:');
    if (!apiHash) {
      console.error('api_hash cannot be empty.');
      process.exit(1);
    }

    credentials = { apiId, apiHash };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
    console.log(`Credentials saved to ${CREDENTIALS_PATH}\n`);
  } else {
    console.log('Using saved API credentials.\n');
  }

  // Load existing session or start fresh
  const sessionString = loadSession();
  const session = new StringSession(sessionString);

  const client = new TelegramClient(session, credentials.apiId, credentials.apiHash, {
    connectionRetries: 3,
  });

  await client.connect();

  // Check if already authorized
  if (await client.isUserAuthorized()) {
    console.log('Already authenticated with Telegram.');
    console.log('  To re-authenticate, delete store/auth/session.txt and run again.');
    await client.disconnect();
    process.exit(0);
  }

  console.log('Starting Telegram authentication...\n');

  await client.start({
    phoneNumber: async () => await input.text('Enter your phone number (with country code, e.g., +1234567890):'),
    phoneCode: async () => await input.text('Enter the verification code sent to your Telegram app:'),
    password: async () => await input.text('Enter your 2FA password (if enabled):'),
    onError: (err) => {
      console.error('Authentication error:', err.message);
    },
  });

  // Save the session string
  const savedSession = client.session.save() as unknown as string;
  fs.writeFileSync(SESSION_PATH, savedSession);

  console.log('\nSuccessfully authenticated with Telegram!');
  console.log(`  Session saved to ${SESSION_PATH}`);
  console.log('  You can now start the NanoClaw service.\n');

  await client.disconnect();
  process.exit(0);
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});

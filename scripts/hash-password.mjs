// Generates a "username:password_hash" pair for the LUMORA_USERS env var.
// Usage: node scripts/hash-password.mjs <username> <password>
import crypto from 'crypto';

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node scripts/hash-password.mjs <username> <password>');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 64);
const password_hash = `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;

console.log(JSON.stringify({ username, password_hash }));

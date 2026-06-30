import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const patchRoot = path.resolve(path.dirname(__filename), '..');
const targetRoot = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

const files = [
  'server/src/connectors/uberConnector.js',
  'server/src/connectors/whatsappConnector.js',
  'server/src/whatsappParser.js'
];

if (!fs.existsSync(path.join(targetRoot, 'server'))) {
  console.error('Target root does not look like a Freda Ops Cockpit repo. Expected a server folder.');
  console.error(`Target: ${targetRoot}`);
  process.exit(1);
}

for (const rel of files) {
  const src = path.join(patchRoot, rel);
  const dst = path.join(targetRoot, rel);
  if (!fs.existsSync(src)) throw new Error(`Missing patch file: ${src}`);
  if (fs.existsSync(dst)) {
    const backup = `${dst}.pre-v33-backup`;
    fs.copyFileSync(dst, backup);
    console.log(`Backup: ${backup}`);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`Patched: ${rel}`);
}

console.log('V33 patch applied. POS/reporting files were not modified.');
console.log('Next: cd server && npm run check');

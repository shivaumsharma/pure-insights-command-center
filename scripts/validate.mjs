// Runs the independent Python validation (validation/validate.py). Finds a Python on this machine, passes the exit code through.
//   npm run validate

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../validation/validate.py');
const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];

for (const python of candidates) {
  const result = spawnSync(python, [script], { stdio: 'inherit', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (result.error?.code === 'ENOENT') continue; // not installed under this name: try the next
  process.exit(result.status ?? 1);
}
console.error('Python 3 is needed for the independent validation and was not found. Install it from python.org, or skip this step.');
process.exit(2);

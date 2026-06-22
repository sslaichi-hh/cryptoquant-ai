import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..');
const mode = process.argv[2] === 'production' ? 'production' : 'development';
const tsxCli = path.join(workspaceRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const child = spawn(process.execPath, [tsxCli, 'server.ts'], {
  cwd: workspaceRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: mode,
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});


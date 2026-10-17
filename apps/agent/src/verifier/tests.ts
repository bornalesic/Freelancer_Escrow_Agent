import { spawn } from 'node:child_process';

const TAIL_LINES = 40;
const MAX_BUFFER_CHARS = 64 * 1024;

export interface CommandResult {
  exitCode?: number;
  timedOut: boolean;
  output: string; // last 40 lines of combined stdout + stderr
  durationMs: number;
  error?: string;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Keep only PATH and HOME from our env: no mnemonics or tokens reach the freelancer's code. */
function minimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CI: 'true',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL'); // whole process group (child was spawned detached)
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Run a shell command in `cwd` with a hard timeout. Never rejects. The process tree is killed on
 * timeout and also after a normal exit (no lingering background processes).
 */
export function runCommand(command: string, cwd: string, timeoutSec: number): Promise<CommandResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let buffer = '';
    let timedOut = false;
    let exitCode: number | undefined;
    let settled = false;

    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = buffer.replace(ANSI, '').trimEnd().split(/\r?\n/).slice(-TAIL_LINES).join('\n');
      resolve({
        exitCode,
        timedOut,
        output,
        durationMs: Date.now() - start,
        ...(error ? { error } : timedOut ? { error: `Timed out after ${timeoutSec} s` } : {}),
      });
    };

    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      env: minimalEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (d: Buffer) => {
      buffer += d.toString('utf8');
      if (buffer.length > MAX_BUFFER_CHARS) buffer = buffer.slice(-MAX_BUFFER_CHARS);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      setTimeout(() => finish(), 1000); // in case 'close' never comes
    }, timeoutSec * 1000);

    child.on('error', (err) => finish(`Could not start the command: ${err.message}`));
    child.on('exit', (code) => {
      exitCode = code ?? undefined;
      killTree(child.pid);
      setTimeout(() => finish(), 500); // let the pipes drain, but don't wait on orphans holding them
    });
    child.on('close', () => finish());
  });
}

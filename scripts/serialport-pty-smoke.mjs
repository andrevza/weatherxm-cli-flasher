import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { SerialPort } from 'serialport';

const pythonPty = String.raw`
import os, pty, select, sys, tty
master, slave = pty.openpty()
tty.setraw(slave)
print(os.ttyname(slave), flush=True)
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin], [], [])
        if sys.stdin in ready:
            if not sys.stdin.readline(): break
        if master in ready:
            data = os.read(master, 4096)
            if not data: break
            print("TX:" + data.hex(), flush=True)
            if data == b"ping\n": os.write(master, b"pong\n")
finally:
    os.close(master)
    os.close(slave)
`;

const lines = [];
const ptyProcess = spawn('python3', ['-u', '-c', pythonPty], { stdio: ['pipe', 'pipe', 'inherit'] });
const lineReader = createInterface({ input: ptyProcess.stdout });
lineReader.on('line', (line) => lines.push(line));

const waitForLine = async (predicate, description, timeoutMs = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = lines.find(predicate);
    if (found) return found;
    if (ptyProcess.exitCode !== null) throw new Error(`PTY helper exited before ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
};

let port;
try {
  const listedPorts = await SerialPort.list();
  if (!Array.isArray(listedPorts) || listedPorts.some((item) => typeof item.path !== 'string')) {
    throw new Error('SerialPort.list() did not return a valid port list');
  }
  const ptyPath = await waitForLine((line) => line.startsWith('/dev/'), 'PTY path');
  const enumeratedNodes = await readdir(dirname(ptyPath));
  if (!enumeratedNodes.includes(basename(ptyPath)) || !(await stat(ptyPath)).isCharacterDevice()) {
    throw new Error('PTY serial device was not visible in the device directory');
  }
  port = new SerialPort({ path: ptyPath, baudRate: 115200, autoOpen: false });
  await new Promise((resolve, reject) => port.open((error) => error ? reject(error) : resolve()));

  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for PTY response')), 5000);
    port.on('data', (chunk) => {
      if (chunk.toString().includes('pong\n')) {
        clearTimeout(timer);
        resolve();
      }
    });
    port.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  await new Promise((resolve, reject) => port.write('ping\n', (error) => error ? reject(error) : resolve()));
  await received;
  await waitForLine((line) => line === 'TX:70696e670a', 'PTY peer to receive serial write');
  await new Promise((resolve, reject) => port.close((error) => error ? reject(error) : resolve()));
  port = undefined;

  const broken = new SerialPort({ path: `${ptyPath}.missing`, baudRate: 115200, autoOpen: false });
  await new Promise((resolve) => broken.open((error) => error ? resolve() : resolve()));
  if (broken.isOpen) {
    await new Promise((resolve) => broken.close(() => resolve()));
    throw new Error('Opening a missing port unexpectedly succeeded');
  }

  process.stdout.write('SerialPort PTY smoke passed: device enumeration, open, write, read, close, and failed-open cleanup\n');
} finally {
  if (port?.isOpen) await new Promise((resolve) => port.close(() => resolve()));
  ptyProcess.stdin.end();
  lineReader.close();
}

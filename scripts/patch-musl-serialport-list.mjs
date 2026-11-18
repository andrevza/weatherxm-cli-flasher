import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageJsonPath = resolve('node_modules/@serialport/bindings-cpp/package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
if (packageJson.version !== '13.0.0') {
  throw new Error(`Expected @serialport/bindings-cpp 13.0.0, found ${packageJson.version}`);
}

const sourcePath = resolve('node_modules/@serialport/bindings-cpp/dist/linux-list.js');
const original = readFileSync(sourcePath, 'utf8');
const marker = 'udevadm.on(\'error\', reject);';
if (!original.includes(marker)) {
  throw new Error('SerialPort Linux listing implementation changed; review the musl fallback patch');
}

const fallback = `udevadm.on('error', (error) => {
            if ((error === null || error === void 0 ? void 0 : error.code) !== 'ENOENT') {
                reject(error);
                return;
            }
            // Alpine base images may not ship udevadm. Preserve useful port
            // enumeration by listing conventional serial device nodes.
            try {
                const fs = require('node:fs');
                const path = require('node:path');
                resolve(fs.readdirSync('/dev')
                    .filter((name) => checkPathOfDevice(name))
                    .map((name) => ({ path: path.join('/dev', name) })));
            }
            catch (fallbackError) {
                reject(fallbackError);
            }
        });`;
writeFileSync(sourcePath, original.replace(marker, fallback));

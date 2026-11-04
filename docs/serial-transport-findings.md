# WG1200 serial transport findings

## Finding: trailing stub digest caused protocol desynchronization

For ESP32 stub `READ_FLASH` (`0xD2`), the host first receives a normal command response, then raw SLIP-framed data. Each data packet is acknowledged with a raw four-byte cumulative byte count. After the final data packet is acknowledged, the stub sends one raw 16-byte MD5 digest frame. That digest has no command header or opcode.

The installed `esptool-js` 0.7.0 `readFlash()` consumed data until it reached the requested byte count and returned without consuming or validating the digest. On the next `0xD2` request, `command()` flushed currently buffered input, then `readPacket(0xD2)` expected a command response. A digest arriving after that flush is ignored by `readPacket()` as a non-command packet; the operation then waits for the next response and times out. The Linux trace timing is consistent with this race. On macOS, the digest can arrive before the next command flushes input, hiding the omission.

`src/upstream/flasher/transport.ts` now consumes and compares the stub digest against MD5 of the received data before `readFlash()` resolves. A bad digest is safe to retry because the entire exchange, including its terminal frame, was consumed. A timeout, malformed digest, or other incomplete transaction is not retried because the stub may still be out of sync. No timing delay is used to paper over the sequencing issue.

`src/nodeSerialPort.ts` waits for both the SerialPort write callback and `port.drain()`. SerialPort documents that Linux drain uses `tcdrain()` and waits for queued output to transmit; this correctly ensures the four-byte acknowledgement was sent. Drain cannot confirm that the stub processed the ACK or completed the transaction, so consuming the digest is a separate required protocol step.

## Source comparison

- esptool-js `Transport.write()` SLIP-frames a command, then awaits `writer.write()`: `node_modules/esptool-js/lib/webserial.js:139`.
- The browser transport continuously reads the Web Serial stream in `readLoop()` and appends chunks to its own buffer: `node_modules/esptool-js/lib/webserial.js:165`. `connect()` opens at the requested baud and the loader starts the read loop: `node_modules/esptool-js/lib/webserial.js:453`, `node_modules/esptool-js/lib/esploader.js:570`.
- esptool-js `readFlash()` requests blocks of 0x1000 and packets of 1024 bytes, then sends cumulative received-byte acknowledgements after each packet: `node_modules/esptool-js/lib/esploader.js:1238`. Its 0.7.0 implementation did not read the trailing digest.
- The CLI's `NodeSerialPort` translates SerialPort `data` events directly into a Web ReadableStream. Web Streams and esptool-js perform buffering and SLIP decoding, so a serial event boundary is not treated as a packet boundary. The adapter also pauses/resumes the SerialPort source in response to stream backpressure.
- The Node adapter now treats `write` callback plus `drain` as the completion point; it logs accepted and drained byte counts separately when diagnostics are enabled.
- Official WeatherXM transport constants specify both ROM and flash baud at 115200 (`src/upstream/flasher/constants.ts:16-17`); there is no normal ROM-to-stub baud transition. `changeBaudrate()` is available for a caller-supplied baud and updates the Node port in place.
- The official web-flasher reference log records a successful ROM/stub session and metadata reads at the same offsets. Its ESP32-S3 secure-boot workaround is implemented in `src/upstream/flasher/transport.ts` (`patchEsploaderRunStub`): read secure-boot eFuse, optionally disable USB-JTAG/Serial watchdogs, upload stub to RAM, call `memFinish(0)`, redirect the ROM SPI legacy read pointer to the stub entry, trigger `READ_FLASH_SLOW`, check `OHAI`, restore the pointer, and apply USB flash write sizing. These are loader/register actions; no flash erase/write is used for inspection.

SerialPort's documented stream API states that Linux drain uses `tcdrain()` and waits for output transmission: [SerialPort stream API](https://serialport.io/docs/11.x.x/api-stream/). Espressif documents the raw flash-data ACK and terminal 16-byte digest sequence in its [serial protocol reference](https://docs.espressif.com/projects/esptool/en/latest/esp32h4/advanced-topics/serial-protocol.html?title=esptool.py+Programming+Guide+for+ESP32-H4). The esptool-js implementation is visible in [webserial transport](https://github.com/espressif/esptool-js/blob/master/lib/webserial.ts) and [loader flash read](https://github.com/espressif/esptool-js/blob/master/lib/esploader.ts).

## Diagnostic logging

Run a read-only command with `--trace-serial` to write safe transport metadata to stderr:

```sh
weatherxm-flash --port /dev/ttyUSB0 --trace-serial info
```

The trace includes port settings, control-signal changes, baud transitions, byte counts, read timeouts, SLIP frame boundaries, expected response opcodes, flash read ranges, and whether a trailing 16-byte digest verified. It never includes serial payloads, flash contents, credentials, certificates, or hashes of protected contents.

## Verification performed

- `tests/flashReadProtocol.test.ts` reproduces consecutive 4 KiB reads, cumulative packet ACKs, digest consumption before the next `0xD2`, and digest mismatch rejection.
- `npm run typecheck` and the full Vitest suite are run before the Git baseline commit; their results are recorded in the task summary.
- The user reports successful repeated physical read-only operations on the Raspberry Pi 5 and macOS ARM64. No firmware write or erase was requested or performed for this investigation.

## Remaining uncertainty

The underlying protocol state was identified from the trace sequence and the documented stub protocol. The regression test verifies the exact transaction boundary in-process. Physical runs reported by the user provide device evidence, but this repository task did not independently reproduce the Raspberry Pi session. The old failing binary's raw 16-byte digest was not retained, so its specific digest contents cannot be compared retrospectively.

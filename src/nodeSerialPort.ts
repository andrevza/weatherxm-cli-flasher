type SerialPortCtor = new (options: { path: string; baudRate: number; autoOpen: boolean; hupcl?: boolean }) => any;
type SerialPortLike = {
  isOpen: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  open(callback: (error: Error | null) => void): void;
  write(data: Buffer, callback: (error: Error | null) => void): void;
  drain(callback: (error: Error | null) => void): void;
  update(options: { baudRate: number }, callback: (error: Error | null) => void): void;
  set(options: { dtr: boolean; rts: boolean }, callback: (error: Error | null) => void): void;
  close(callback: () => void): void;
  pause?(): unknown;
  resume?(): unknown;
};
export type SerialTrace = (message: string) => void;
export type SerialPortFactory = (options: { path: string; baudRate: number; autoOpen: false; hupcl?: boolean }) => SerialPortLike | Promise<SerialPortLike>;
export type SerialLifecycle = (stage: string, state: 'start' | 'complete' | 'failed', detail?: string) => void;

/** Adapts node-serialport's event API to the Web Serial shape used by esptool-js. */
export class NodeSerialPort {
  readable?: ReadableStream<Uint8Array>;
  writable?: WritableStream<Uint8Array>;
  private port?: SerialPortLike;
  private dtr = false;
  private rts = false;
  private signalsInitialized = false;
  private baudRate = 115200;
  constructor(
    private readonly path: string,
    private readonly trace?: SerialTrace,
    private readonly portFactory?: SerialPortFactory,
    private readonly passive = false,
    private readonly lifecycle?: SerialLifecycle,
    private readonly detailedSignalTransitions = false,
  ) {}

  private log(message: string): void {
    this.trace?.(message);
  }

  getInfo(): { usbVendorId?: number; usbProductId?: number } {
    return {};
  }

  async open(options: { baudRate?: number }): Promise<void> {
    if (this.port?.isOpen) return;
    const baudRate = options.baudRate ?? 115200;
    const serialOptions = { path: this.path, baudRate, autoOpen: false as const, ...(this.passive ? { hupcl: false } : {}) };
    this.log(`open path=${this.path} baud=${baudRate} dataBits=8 parity=none stopBits=1 flowControl=none`);
    const stage = `Opening serial port ${this.path}`;
    this.lifecycle?.(stage, 'start');
    let port: SerialPortLike;
    try {
      if (this.portFactory) {
        port = await this.portFactory(serialOptions);
      } else {
        const { SerialPort } = await import('serialport');
        const Port = SerialPort as unknown as SerialPortCtor;
        port = new Port(serialOptions);
      }
      this.port = port;
      await new Promise<void>((resolve, reject) => port.open((err: Error | null) => {
        if (err) {
          this.log(`open failed: ${err.message}`);
          reject(err);
        } else resolve();
      }));
      // Opening a native serial descriptor may alter modem lines, so the first
      // requested state after every open must always be applied explicitly.
      this.signalsInitialized = false;
      this.lifecycle?.(stage, 'complete');
    } catch (error) {
      this.lifecycle?.(stage, 'failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
    this.baudRate = baudRate;
    let receivedBytes = 0;

    let streamEnded = false;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        port.on('data', (chunk: Buffer) => {
          if (streamEnded) return;
          receivedBytes += chunk.length;
          this.log(`rx chunkBytes=${chunk.length} totalBytes=${receivedBytes}`);
          controller.enqueue(new Uint8Array(chunk));
          if ((controller.desiredSize ?? 1) <= 0) port.pause?.();
        });
        port.on('error', (err: Error) => {
          if (streamEnded) return;
          streamEnded = true;
          this.log(`rx error: ${err.message}`);
          controller.error(err);
        });
        port.on('close', () => {
          if (streamEnded) return;
          streamEnded = true;
          this.log(`rx closed totalBytes=${receivedBytes}`);
          controller.close();
        });
      },
      pull: () => {
        if (!streamEnded) port.resume?.();
      },
      cancel: () => { streamEnded = true; },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        this.log(`tx queuedBytes=${chunk.length}`);
        await new Promise<void>((resolve, reject) => {
          port.write(Buffer.from(chunk), (err: Error | null) => err ? reject(err) : resolve());
        });
        // Web Serial writer.write() resolves after the underlying serial sink has
        // consumed the bytes. serialport's write callback only confirms its JS
        // write operation; drain() waits until the OS has transmitted them.
        await new Promise<void>((resolve, reject) => {
          port.drain((err: Error | null) => err ? reject(err) : resolve());
        });
        this.log(`tx drainedBytes=${chunk.length}`);
      },
    });
  }

  async setBaudRate(baudRate: number): Promise<void> {
    if (!this.port?.isOpen || baudRate === this.baudRate) return;
    this.log(`baud change ${this.baudRate} -> ${baudRate}`);
    await new Promise<void>((resolve, reject) => {
      this.port!.update({ baudRate }, (err: Error | null) => err ? reject(err) : resolve());
    });
    this.baudRate = baudRate;
  }

  async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void> {
    const previousDtr = this.dtr; const previousRts = this.rts;
    this.dtr = signals.dataTerminalReady ?? this.dtr;
    this.rts = signals.requestToSend ?? this.rts;
    const port = this.port;
    this.log(`signals dtr=${this.dtr} rts=${this.rts}`);
    if (!port?.isOpen) return;
    const changed = previousDtr !== this.dtr || previousRts !== this.rts;
    if (!changed && this.signalsInitialized) return;
    const stage = 'Applying RTS/DTR reset signals';
    if (changed && this.detailedSignalTransitions) this.lifecycle?.(stage, 'start');
    try {
      await new Promise<void>((resolve, reject) => port.set({ dtr: this.dtr, rts: this.rts }, (err: Error | null) => err ? reject(err) : resolve()));
      this.signalsInitialized = true;
      if (changed && this.detailedSignalTransitions) this.lifecycle?.(stage, 'complete');
    } catch (error) {
      if (changed && this.detailedSignalTransitions) this.lifecycle?.(stage, 'failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async close(): Promise<void> {
    const port = this.port;
    this.port = undefined;
    this.readable = undefined;
    this.writable = undefined;
    if (port?.isOpen) {
      this.log('close requested');
      await new Promise<void>((resolve) => port.close(() => resolve()));
      this.log('close complete');
    }
  }
}

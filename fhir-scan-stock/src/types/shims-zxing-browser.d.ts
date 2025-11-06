// src/types/shims-zxing-browser.d.ts
declare module '@zxing/browser' {
  export interface IScannerControls {
    stop(): void;
  }

  export class BrowserMultiFormatReader {
    constructor(hints?: any, timeBetweenScansMillis?: number);

    // ✅ 你代码里用到的静态方法
    static listVideoInputDevices(): Promise<MediaDeviceInfo[]>;

    decodeFromVideoDevice(
      deviceId: string | undefined,
      video: HTMLVideoElement,
      callback: (
        result: { getText(): string } | undefined,
        err?: unknown,
        controls?: IScannerControls
      ) => void
    ): Promise<IScannerControls>;

    reset(): void;
  }
}

export {};

declare global {
  interface Window {
    electronAPI: {
      // sendDataToMain: (data: string) => Promise<string>;
      pickPath: (props: string[]) => Promise<string | null>;
      runExport: (opts: any) => Promise<any>;
    };
  }
}
// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from 'electron';

// Expose a controlled API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // sendDataToMain: (data: string) => ipcRenderer.invoke('get-from-ui', data),
  pickPath: async (data: string[]) => await ipcRenderer.invoke('pick-path', { props: data }),
  runExport: async (opts: any) => await ipcRenderer.invoke('run-export', opts),
  onProgress: (callback: (data: { type: string; progress: number; message?: string }) => void) => {
    ipcRenderer.on('exportProgress', (_event, data) => callback(data));
  },
  onError: (callback: (error: string) => void) => {
    ipcRenderer.on('exportError', (_event, error) => callback(error));
  },
  onComplete: (callback: () => void) => {
    ipcRenderer.on('exportComplete', () => callback());
  }
});
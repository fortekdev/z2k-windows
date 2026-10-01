import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// Узкий мост: renderer вызывает только команды из белого списка main-процесса (см. ipc.ts)
const api = {
  invoke: <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke('z2k', channel, ...args),
  on: (event: string, cb: (payload: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, name: string, payload: unknown) => {
      if (name === event) cb(payload);
    };
    ipcRenderer.on('z2k:event', listener);
    return () => { ipcRenderer.removeListener('z2k:event', listener); };
  },
};

contextBridge.exposeInMainWorld('z2k', api);

export type Z2kBridge = typeof api;

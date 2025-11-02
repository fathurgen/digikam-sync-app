import QRCode from 'qrcode';
import { StorageService } from './services/storage';
import { LOCALSTORAGE_KEY } from './shared/constants';

document.addEventListener('DOMContentLoaded', () => {
  const dbEl = document.getElementById('dbPath') as HTMLInputElement;
  const photosEl = document.getElementById('photosRoot') as HTMLInputElement;
  const outEl = document.getElementById('outFolder') as HTMLInputElement;
  const logEl = document.getElementById('log') as HTMLElement;
  const progressEl = document.getElementById('progressBar') as HTMLProgressElement
  const btnPickDb = document.getElementById('btnPickDb') as HTMLButtonElement | null;
  const btnPickPhotos = document.getElementById('btnPickPhotos') as HTMLButtonElement | null;
  const btnPickOut = document.getElementById('btnPickOut') as HTMLButtonElement | null;

  const btnStart = document.getElementById('btnStartServer') as HTMLButtonElement | null;
  const btnStop = document.getElementById('btnStopServer') as HTMLButtonElement | null;
  const serverUrlEl = document.getElementById('serverUrl') as HTMLElement | null;

  // elemen status device
  const deviceStatusEl = document.getElementById('deviceStatus') as HTMLElement | null;
  const deviceInfoEl = document.getElementById('deviceInfo') as HTMLElement | null;
  
  loadLastPaths(dbEl, photosEl, outEl);

  deviceInfoEl.hidden = true;

  const appendLog = (s: string) => {
    if (logEl) {
      logEl.textContent += s + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    }
    // console.log(s);
  };

  if (!(window as any).electronAPI) {
    appendLog('electronAPI not available. Check preload config.');
    return;
  }

  const api = (window as any).electronAPI;

  // Update progress handlers
  api.onProgress((data: any) => {
    progressEl.value = data.progress;
    appendLog(`${data.message || `Progress: ${data.progress}%`}`);
  });

  api.onError((error: any) => {
    appendLog(`❌ Error: ${error}`);
    progressEl.value = 0;
  });

  api.onComplete(() => {
    appendLog('✅ Export completed successfully.');
    appendLog('✅ Library ready to sync with mobile apps.');
    progressEl.value = 100;
    if (deviceInfoEl) deviceInfoEl.hidden = false;

    // Short-lived frequent polling until a device appears, then stop
    const deviceStatusInterval = setInterval(async () => {
      try {
        const res = await pollDeviceStatus();
        if (res && res.device) {
          clearInterval(deviceStatusInterval);
        }
      } catch {
        // ignore errors during short polling
      }
    }, 1000);
  });

  btnPickDb?.addEventListener('click', async () => {
    const p = await api.pickPath(['openFile']);
    if (p) dbEl.value = p;
  });

  btnPickPhotos?.addEventListener('click', async () => {
    const p = await api.pickPath(['openDirectory']);
    if (p) photosEl.value = p;
  });

  btnPickOut?.addEventListener('click', async () => {
    const p = await api.pickPath(['openDirectory']);
    if (p) outEl.value = p;
  });

  // runButton?.addEventListener('click', async () => {
  //   try {
  //     const dbPath = dbEl.value.trim();
  //     const photosRoot = photosEl.value.trim();
  //     const outFolder = outEl.value.trim();
      
  //     if (!dbPath || !photosRoot || !outFolder) {
  //       appendLog('Please select all paths first.');
  //       return;
  //     }

  //     // Disable the run button
  //     runButton.disabled = true;
  //     logEl.textContent = 'Starting export...\n';
  //     progressEl.value = 0;

  //     await api.runExport({ dbPath, photosRoot, outFolder });
  //   } catch (error) {
  //     appendLog(`❌ Export failed: ${error.message}`);
  //     progressEl.value = 0;
  //   } finally {
  //     runButton.disabled = false;
  //   }
  // });



  btnStart?.addEventListener('click', async () => {
    
    try {
      const dbPath = dbEl.value.trim();
      const photosRoot = photosEl.value.trim();
      const outFolder = outEl.value.trim();
      
      if (!dbPath || !photosRoot || !outFolder) {
        appendLog('Please select all paths first.');
        return;
      }

      saveLastPaths(dbPath, photosRoot, outFolder);

      serverUrlEl!.textContent = 'Starting...';
      const res: any = await (window as any).electronAPI.startServer(dbPath, photosRoot, outFolder);
      if (res.ok) {
        // Disable the run button
        btnStart.disabled = true;
        
        // Show server URL
        const url = res.info.url;
        serverUrlEl!.innerHTML = `Server running: <b>${url}</b><br>Albums: <code>${url}/albums.json</code>`;
        appendLog('Server started: ' + url);
        
        // Start export
        logEl.textContent = 'Starting export...\n';
        progressEl.value = 0;
        // await api.runExport({ dbPath, photosRoot, outFolder });

      } else {
        serverUrlEl!.textContent = 'Start failed: ' + res.error;
        appendLog('Server start failed: ' + res.error);
      }

    } catch (error) {
      appendLog(`❌ Export failed: ${error.message}`);
      deviceInfoEl.hidden = true;
      progressEl.value = 0;
    } finally {
      btnStart.disabled = false;
    }
    
  });

  btnStop?.addEventListener('click', async () => {
    const res: any = await (window as any).electronAPI.stopServer();
    if (res.ok) {
      serverUrlEl!.textContent = 'Server stopped';
      appendLog('Server stopped');
    } else {
      appendLog('Stop failed: ' + res.error);
    }
  });

  // Build URL for QR code: prefer the server info shown in serverUrlEl, otherwise fallback to the current host with default port 3000
  const serverText = serverUrlEl?.textContent || '';
  const hostMatch = /https?:\/\/([^:/\s]+)(?::(\d+))?/.exec(serverText);
  const host = hostMatch?.[1] || window.location.hostname || 'localhost';
  async function pollDeviceStatus(): Promise<{ status: string; device: string }> {
    let data = {
      status: '',
      device: ''
    };
    if (!serverUrlEl || !serverUrlEl.textContent) return data;
    const match = /http:\/\/([^:/\s]+):(\d+)/.exec(serverUrlEl.textContent);
    if (!match) return data;
    const host = match[1];
    const port = match[2];
    try {
      const res = await fetch(`http://${host}:${port}/api/device-status`);
      if (res.ok) {
        data = await res.json();
        if (deviceStatusEl) {
          deviceStatusEl.textContent = `${data.status || 'Tidak ada'}${data.device ? ' | ' + data.device : ''}`;
        }
        return data;
      } else {
        if (deviceStatusEl) deviceStatusEl.textContent = 'Tidak ada';
        return data;
      }
    } catch {
      if (deviceStatusEl) deviceStatusEl.textContent = 'Tidak ada';
      return data;
    }
  }
});


function saveLastPaths(dbPath: string, photosRoot: string, outFolder: string) {
  const storage = new StorageService();
  storage.setItem(LOCALSTORAGE_KEY.LAST_DB_PATH, dbPath);
  storage.setItem(LOCALSTORAGE_KEY.LAST_PHOTOS_ROOT, photosRoot);
  storage.setItem(LOCALSTORAGE_KEY.LAST_OUT_FOLDER, outFolder);
}

function loadLastPaths(dbEl: HTMLInputElement, photosEl: HTMLInputElement, outEl: HTMLInputElement) {
  const storage = new StorageService();
  const dbPath = storage.getItem(LOCALSTORAGE_KEY.LAST_DB_PATH) || '';
  const photosRoot = storage.getItem(LOCALSTORAGE_KEY.LAST_PHOTOS_ROOT) || '';
  const outFolder = storage.getItem(LOCALSTORAGE_KEY.LAST_OUT_FOLDER) || '';
  if (dbEl) dbEl.value = dbPath;
  if (photosEl) photosEl.value = photosRoot;
  if (outEl) outEl.value = outFolder;
}
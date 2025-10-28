import QRCode from 'qrcode';

document.addEventListener('DOMContentLoaded', () => {
  const dbEl = document.getElementById('dbPath') as HTMLInputElement;
  const photosEl = document.getElementById('photosRoot') as HTMLInputElement;
  const outEl = document.getElementById('outFolder') as HTMLInputElement;
  const logEl = document.getElementById('log') as HTMLElement;
  const progressEl = document.getElementById('progressBar') as HTMLProgressElement
  const runButton = document.getElementById('run') as HTMLButtonElement | null;
  const pickDb = document.getElementById('pickDb');
  const pickPhotos = document.getElementById('pickPhotos');
  const pickOut = document.getElementById('pickOut');

  const btnStart = document.getElementById('btnStartServer');
  const btnStop = document.getElementById('btnStopServer');
  const serverUrlEl = document.getElementById('serverUrl');

  const appendLog = (s: string) => {
    if (logEl) {
      logEl.textContent += s + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    }
    console.log(s);
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
    progressEl.value = 100;
  });

  pickDb?.addEventListener('click', async () => {
    const p = await api.pickPath(['openFile']);
    if (p) dbEl.value = p;
  });

  pickPhotos?.addEventListener('click', async () => {
    const p = await api.pickPath(['openDirectory']);
    if (p) photosEl.value = p;
  });

  pickOut?.addEventListener('click', async () => {
    const p = await api.pickPath(['openDirectory']);
    if (p) outEl.value = p;
  });

  runButton?.addEventListener('click', async () => {
    try {
      const dbPath = dbEl.value.trim();
      const photosRoot = photosEl.value.trim();
      const outFolder = outEl.value.trim();
      
      if (!dbPath || !photosRoot || !outFolder) {
        appendLog('Please select all paths first.');
        return;
      }

      // Disable the run button
      runButton.disabled = true;
      logEl.textContent = 'Starting export...\n';
      progressEl.value = 0;

      await api.runExport({ dbPath, photosRoot, outFolder });
    } catch (error) {
      appendLog(`❌ Export failed: ${error.message}`);
      progressEl.value = 0;
    } finally {
      runButton.disabled = false;
    }
  });



  btnStart?.addEventListener('click', async () => {
    const photosRoot = (document.getElementById('photosRoot') as HTMLInputElement).value;
    const outFolder = (document.getElementById('outFolder') as HTMLInputElement).value;
    if (!photosRoot || !outFolder) {
      appendLog('Please set photosRoot and outFolder first');
      return;
    }
    serverUrlEl!.textContent = 'Starting...';
    const res: any = await (window as any).electronAPI.startServer(photosRoot, outFolder);
    if (res.ok) {
      const url = res.info.url;
      serverUrlEl!.innerHTML = `Server running: <b>${url}</b><br>Albums: <code>${url}/albums.json</code>`;
      appendLog('Server started: ' + url);
    } else {
      serverUrlEl!.textContent = 'Start failed: ' + res.error;
      appendLog('Server start failed: ' + res.error);
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
  const port = hostMatch?.[2] || '3000';
  const tokenParam = new URLSearchParams(window.location.search).get('token') || '';
  const url = `http://${host}:${port}${tokenParam ? `?token=${tokenParam}` : ''}`;
  QRCode.toCanvas(document.getElementById('canvas') as HTMLCanvasElement, url, function (error: any) {
    if (error) console.error(error);
  });
});

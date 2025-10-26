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
});

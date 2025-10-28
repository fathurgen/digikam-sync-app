import { app, BrowserWindow, dialog, ipcMain  } from 'electron';
import started from 'electron-squirrel-startup';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import { Worker } from 'worker_threads';
import { exportAlbums, generateManifest, preGenerateThumbnails } from './services/electron-exporter';
import { getServerInfo, startServer, stopServer } from './main/server';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Open the DevTools.
  mainWindow.webContents.openDevTools();
};

app.on('ready', createWindow);

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// function -----------------------------------
ipcMain.handle('pick-path', async (ev, opts) => {
  const res: any = await dialog.showOpenDialog({ properties: opts.props || ['openFile'] });
  if (res.canceled) return null;
  return res.filePaths[0];
});


ipcMain.handle('run-export', async (_, args) => {
  try {
    const { dbPath, photosRoot, outFolder } = args;
    
    // Send initial progress
    mainWindow?.webContents.send('exportProgress', {
      type: 'init',
      progress: 0,
      message: 'Exporting albums...'
    });

    // Export albums
    // const result = await exportAlbums(dbPath, photosRoot, outFolder);
    const result = exportAlbums(dbPath, photosRoot, outFolder, (message, progress) => {
        mainWindow?.webContents.send('exportProgress', {
            type: 'albums',
            progress,
            message
        });
    });

    // Generate manifest
    // await generateManifest(photosRoot, outFolder);
    generateManifest(photosRoot, outFolder, (message, progress) => {
        mainWindow?.webContents.send('exportProgress', {
            type: 'manifest',
            progress,
            message
        });
    });

    const allImages = result.albums.flatMap(a => a.images);
    let processedCount = 0;

    // Process thumbnails in batches
    const batchSize = 10;
    for (let i = 0; i < allImages.length; i += batchSize) {
      const batch = allImages.slice(i, i + batchSize);
      await Promise.all(batch.map(async (imagePath) => {
        try {
          const thumbDir = path.join(outFolder, '.thumbs');
          const thumbWorker = new Worker(
            path.join(__dirname, 'workers', 'thumbWorker.js'),
            { type: 'module' } as any
          );

          return new Promise((resolve, reject) => {
            thumbWorker.on('message', (msg) => {
              processedCount++;
              const progress = 50 + Math.floor((processedCount / allImages.length) * 50);
              
              mainWindow?.webContents.send('exportProgress', {
                type: 'thumbnails',
                progress,
                message: `Processing image ${processedCount}/${allImages.length}`
              });

              thumbWorker.terminate();
              resolve(msg);
            });

            thumbWorker.on('error', (err) => {
              thumbWorker.terminate();
              reject(err);
            });

            thumbWorker.postMessage({
              srcPath: path.join(photosRoot, imagePath),
              thumbPath: path.join(thumbDir, `${path.basename(imagePath)}.thumb.jpg`),
              size: 256
            });
          });
        } catch (err) {
          console.error(`Error processing ${imagePath}:`, err);
        }
      }));
    }

    mainWindow?.webContents.send('exportComplete');
    return { ok: true };

  } catch (error) {
    mainWindow?.webContents.send('exportError', error.message);
    return { ok: false, error: error.message };
  }
});

// IPC handler to start server
ipcMain.handle('server-start', async (_ev, { photosRoot, outFolder, preferredPort }: any) => {
  try {
    const info = await startServer(photosRoot, outFolder, preferredPort || 0);
    // return info.url
    return { ok: true, info };
  } catch (err: any) {
    console.error('startServer error', err);
    return { ok: false, error: String(err.message || err) };
  }
});

// IPC handler to stop server
ipcMain.handle('server-stop', async () => {
  try {
    await stopServer();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err.message || err) };
  }
});

// IPC handler to get current info
ipcMain.handle('server-info', async () => {
  try {
    const info = getServerInfo();
    return { ok: true, info };
  } catch (err: any) {
    return { ok: false, error: String(err.message || err) };
  }
});

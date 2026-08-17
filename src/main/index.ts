import { join } from 'path'
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { IPC, type RegionConfig } from '@shared/types'
import { Settings } from './settings'
import { GameState } from './gameState'

let mainWindow: BrowserWindow | null = null
let settings: Settings
let gameState: GameState

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'League Live Scout',
    backgroundColor: '#0e1015',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // electron-vite injects ELECTRON_RENDERER_URL in dev.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSnapshot, () => gameState.getSnapshot())
  ipcMain.handle(IPC.getSettings, () => settings.toAppSettings())

  ipcMain.handle(IPC.setApiKey, (_e, key: string) => {
    settings.setApiKey(key)
    return settings.toAppSettings()
  })
  ipcMain.handle(IPC.clearApiKey, () => {
    settings.clearApiKey()
    return settings.toAppSettings()
  })
  ipcMain.handle(IPC.setRegion, (_e, region: RegionConfig) => {
    settings.setRegion(region)
    gameState.onRegionChanged()
    return settings.toAppSettings()
  })
  ipcMain.handle(IPC.testApiKey, () => gameState.testApiKey())
  ipcMain.handle(IPC.rescout, async () => {
    await gameState.rescout()
    return gameState.getSnapshot()
  })
}

// Single-instance lock: a companion tool should never run twice.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    settings = new Settings()
    gameState = new GameState({
      settings,
      cacheFilePath: join(app.getPath('userData'), 'cache.json')
    })

    gameState.on('snapshot', (snap) => send(IPC.snapshot, snap))
    gameState.on('rateStatus', (status) => send(IPC.rateStatus, status))
    gameState.on('log', (line) => send(IPC.log, line))

    registerIpc()
    createWindow()
    await gameState.init()
    // Push an initial snapshot once the window is ready.
    send(IPC.snapshot, gameState.getSnapshot())

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    gameState?.shutdown()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => gameState?.shutdown())
}

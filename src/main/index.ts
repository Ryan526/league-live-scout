import { join } from 'path'
import { app, shell, BrowserWindow, ipcMain, screen } from 'electron'
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

  // Auto-fit: the renderer reports the natural size of its content and we grow
  // (or shrink) the window to show everything, clamped to the current display's
  // work area. Skipped while maximized/fullscreen so we don't fight the user.
  ipcMain.on(IPC.resizeWindow, (_e, size: { width: number; height: number }) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      mainWindow.isMaximized() ||
      mainWindow.isFullScreen()
    ) {
      return
    }
    const wa = screen.getDisplayMatching(mainWindow.getBounds()).workArea
    const w = Math.min(Math.max(Math.round(size.width), 820), wa.width)
    const h = Math.min(Math.max(Math.round(size.height), 400), wa.height)
    const [curW, curH] = mainWindow.getContentSize()
    if (Math.abs(curW - w) < 4 && Math.abs(curH - h) < 4) return

    mainWindow.setContentSize(w, h)

    // Keep the window fully on-screen after growing.
    const b = mainWindow.getBounds()
    let x = b.x
    let y = b.y
    if (x + b.width > wa.x + wa.width) x = wa.x + wa.width - b.width
    if (y + b.height > wa.y + wa.height) y = wa.y + wa.height - b.height
    x = Math.max(x, wa.x)
    y = Math.max(y, wa.y)
    if (x !== b.x || y !== b.y) mainWindow.setPosition(x, y)
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

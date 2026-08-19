import { join } from 'path'
import { app, shell, BrowserWindow, ipcMain, screen } from 'electron'
import { IPC, type RegionConfig } from '@shared/types'
import { Settings } from './settings'
import { GameState } from './gameState'

/** Window sizing. MIN_CONTENT_* are also the floor the auto-fit clamps to, so
 *  the renderer can never ask for a window smaller than the chrome allows. */
const DEFAULT_WIDTH = 1100
const DEFAULT_HEIGHT = 780
const MIN_CONTENT_WIDTH = 820
const MIN_CONTENT_HEIGHT = 400
const MIN_WINDOW_HEIGHT = 560
/** Ignore auto-fit requests smaller than this, to avoid a resize feedback loop. */
const RESIZE_EPSILON_PX = 4

let mainWindow: BrowserWindow | null = null
let settings: Settings
let gameState: GameState
let quitting = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_CONTENT_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    title: 'League Live Scout',
    backgroundColor: '#0e1015',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Nothing in the preload needs Node, so run it sandboxed.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    openExternal(details.url)
    return { action: 'deny' }
  })

  // The renderer only ever shows our own bundle; any attempt to navigate
  // elsewhere is either a stray link or something hostile.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    if (url !== current) {
      event.preventDefault()
      openExternal(url)
    }
  })

  // electron-vite injects ELECTRON_RENDERER_URL in dev.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Open a URL in the user's browser, but only if it's plainly a web link. */
function openExternal(rawUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
  void shell.openExternal(parsed.toString())
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
    gameState.onApiKeyChanged()
    return settings.toAppSettings()
  })
  ipcMain.handle(IPC.clearApiKey, () => {
    settings.clearApiKey()
    gameState.onApiKeyChanged()
    return settings.toAppSettings()
  })
  ipcMain.handle(IPC.setRegion, (_e, region: RegionConfig) => {
    settings.setRegion(region)
    gameState.onRegionChanged()
    return settings.toAppSettings()
  })
  ipcMain.handle(IPC.setLivePollMs, (_e, ms: number) => {
    settings.setLivePollMs(ms)
    gameState.onLivePollMsChanged()
    return settings.toAppSettings()
  })
  ipcMain.handle(IPC.testApiKey, () => gameState.testApiKey())
  ipcMain.handle(IPC.clearPeakRanks, () => {
    gameState.clearPeakRanks()
    return gameState.getSnapshot()
  })
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
    const w = Math.min(Math.max(Math.round(size.width), MIN_CONTENT_WIDTH), wa.width)
    const h = Math.min(Math.max(Math.round(size.height), MIN_CONTENT_HEIGHT), wa.height)
    const [curW, curH] = mainWindow.getContentSize()
    if (Math.abs(curW - w) < RESIZE_EPSILON_PX && Math.abs(curH - h) < RESIZE_EPSILON_PX) {
      return
    }

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

// A crash in a stray promise should be logged, not silently swallowed (or, on
// some Electron versions, fatal).
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason)
})

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

  app
    .whenReady()
    .then(async () => {
      settings = new Settings()
      gameState = new GameState({
        settings,
        cacheFilePath: join(app.getPath('userData'), 'cache.json')
      })

      gameState.on('snapshot', (snap) => send(IPC.snapshot, snap))
      gameState.on('rateStatus', (status) => send(IPC.rateStatus, status))
      gameState.on('log', (line) => send(IPC.log, line))

      // Initialize before exposing IPC or a window, so an early invoke can
      // never reach a half-constructed GameState. init() does not block on the
      // network — Data Dragon loads in the background.
      await gameState.init()
      registerIpc()
      createWindow()
      // Push an initial snapshot once the window is ready.
      send(IPC.snapshot, gameState.getSnapshot())

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((e) => {
      console.error('[main] startup failed:', e)
      app.quit()
    })

  app.on('window-all-closed', () => {
    // Shutdown belongs to before-quit only: on macOS the app stays alive with
    // no windows and `activate` recreates one, so tearing GameState down here
    // left a dead, empty app.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting || !gameState) return
    quitting = true
    // Give the cache flush a chance to actually finish; unawaited, the process
    // almost always exited mid-write.
    event.preventDefault()
    void gameState.shutdown().finally(() => app.quit())
  })
}

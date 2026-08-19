import { useEffect, useRef } from 'react'

/** Matches MIN_CONTENT_WIDTH in the main process; the clamp lives there. */
const RESIZE_EPSILON_PX = 4

/**
 * Measures the natural size of the app's content and asks the main process to
 * resize the window so everything is visible without scrolling. Re-measures
 * whenever `key` changes and whenever the content itself changes size (e.g. as
 * player stats fill in), via a ResizeObserver. The main process clamps the
 * request to the display's work area, so oversized content still scrolls
 * gracefully.
 *
 * `key` must be a stable primitive, not a snapshot object: the snapshot is a
 * new object on every emit (~8/sec while stats stream in), which rebuilt the
 * observer constantly and — because the dedupe state was re-initialized on each
 * run — fired a resize IPC on every single emit, fighting any user who happened
 * to be moving the window.
 */
export function useAutoFit(key: string): void {
  const last = useRef({ w: 0, h: 0 })

  useEffect(() => {
    const header = document.querySelector('.statusbar') as HTMLElement | null
    const content = document.querySelector('.content') as HTMLElement | null
    if (!content) return

    let raf = 0

    const measure = (): void => {
      const inner = content.firstElementChild as HTMLElement | null
      if (!inner) return
      const cs = getComputedStyle(content)
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      // inner.offsetHeight is the content's natural height (unlike the flex
      // container, which stretches to fill the viewport).
      const h = Math.ceil((header?.offsetHeight ?? 0) + inner.offsetHeight + padY)
      const w = Math.ceil(inner.scrollWidth + padX)
      if (
        Math.abs(h - last.current.h) < RESIZE_EPSILON_PX &&
        Math.abs(w - last.current.w) < RESIZE_EPSILON_PX
      ) {
        return
      }
      last.current = { w, h }
      window.scout.resizeToContent(w, h)
    }

    const schedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }

    schedule()

    // React to content growing/shrinking (stats loading in, team counts, etc.).
    const ro = new ResizeObserver(schedule)
    if (content.firstElementChild) ro.observe(content.firstElementChild)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [key])
}

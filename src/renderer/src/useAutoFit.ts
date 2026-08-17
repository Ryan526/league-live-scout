import { useEffect } from 'react'

/**
 * Measures the natural size of the app's content and asks the main process to
 * resize the window so everything is visible without scrolling. Re-measures on
 * the given deps and whenever the content itself changes size (e.g. as player
 * stats fill in), via a ResizeObserver. The main process clamps the request to
 * the display's work area, so oversized content still scrolls gracefully.
 */
export function useAutoFit(deps: unknown[]): void {
  useEffect(() => {
    const header = document.querySelector('.statusbar') as HTMLElement | null
    const content = document.querySelector('.content') as HTMLElement | null
    if (!content) return

    let raf = 0
    let last = { w: 0, h: 0 }

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
      if (Math.abs(h - last.h) < 4 && Math.abs(w - last.w) < 4) return
      last = { w, h }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

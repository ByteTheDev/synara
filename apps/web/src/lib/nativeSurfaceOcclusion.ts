// FILE: nativeSurfaceOcclusion.ts
// Purpose: Notify native Electron surfaces when a DOM overlay starts or stops obscuring them.
// Layer: Web cross-surface coordination

// Electron WebContentsViews render above the DOM regardless of CSS z-index.
export const NATIVE_SURFACE_OCCLUSION_SYNC_EVENT = "synara:native-surface-occlusion-sync";
export const NATIVE_SURFACE_MENU_OVERLAY_SELECTOR = "[data-slot='menu-positioner']";
export const NATIVE_SURFACE_OBSCURING_OVERLAY_SELECTOR = [
  NATIVE_SURFACE_MENU_OVERLAY_SELECTOR,
  "[data-slot='dialog-backdrop']", "[data-slot='dialog-popup']", "[data-slot='dialog-viewport']",
  "[data-slot='alert-dialog-backdrop']", "[data-slot='alert-dialog-popup']", "[data-slot='alert-dialog-viewport']",
  "[data-slot='command-dialog-backdrop']", "[data-slot='command-dialog-popup']", "[data-slot='command-dialog-viewport']",
  "[data-slot='toast-popup']", "[role='dialog'][aria-modal='true']",
].join(", ");

export function notifyNativeSurfaceOcclusionChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT));
}

/** React callback ref: track only the mounted popup, not mutations across the app. */
export function observeNativeSurfaceOverlay(element: HTMLElement | null): (() => void) | undefined {
  if (!element) return;
  const resizeObserver = new ResizeObserver(notifyNativeSurfaceOcclusionChange);
  const mutationObserver = new MutationObserver(notifyNativeSurfaceOcclusionChange);
  resizeObserver.observe(element);
  mutationObserver.observe(element, { attributes: true });
  notifyNativeSurfaceOcclusionChange();
  return () => {
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    notifyNativeSurfaceOcclusionChange();
  };
}

/** Run only on a surface/layout/overlay notification, not on transcript mutations. */
export function isNativeSurfaceOccluded(surface: HTMLElement, bounds: DOMRect): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>(NATIVE_SURFACE_OBSCURING_OVERLAY_SELECTOR)).some((overlay) => {
    if (surface.contains(overlay) || overlay.contains(surface) || overlay.getClientRects().length === 0) return false;
    const style = getComputedStyle(overlay);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = overlay.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.left < bounds.right && rect.right > bounds.left && rect.top < bounds.bottom && rect.bottom > bounds.top;
  });
}

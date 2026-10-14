import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { DesktopIdeBridge, DesktopIdeDocumentState, DesktopIdeRequest, DesktopIdeSurface } from "@synara/contracts";
import { readLocalCodeOssBridge, requireCodeOssDocument } from "~/lib/desktopIdeBridge";
import { isNativeSurfaceOccluded, NATIVE_SURFACE_OCCLUSION_SYNC_EVENT } from "~/lib/nativeSurfaceOcclusion";
import type { CodeEditHistoryControls, CodeEditHistoryState } from "./pierreEdit";

interface NativeCodeEditorPaneProps {
  nativeState: DesktopIdeDocumentState;
  fileName: string;
  onSave: () => void;
  original?: string;
  renderSideBySide?: boolean;
  historyControlsRef?: RefObject<CodeEditHistoryControls | null> | undefined;
  onHistoryChange?: ((history: CodeEditHistoryState) => void) | undefined;
}
interface SurfaceRegistration {
  readonly lease: string;
  readonly bridge: DesktopIdeBridge;
  readonly element: HTMLDivElement;
  readonly select: () => Promise<void>;
  readonly setActive: (active: boolean) => void;
  readonly fail: (error: unknown) => void;
  report: () => void;
}
const surfaces = new Map<string, SurfaceRegistration>();
let activeSurface: SurfaceRegistration | null = null;
let selectionQueue: Promise<void> = Promise.resolve();

/** One native workbench, many retained models. Focus, not a product mode, owns its viewport. */
function activateSurface(surface: SurfaceRegistration) {
  if (activeSurface === surface) { surface.report(); return; }
  const previous = activeSurface;
  activeSurface = surface;
  previous?.setActive(false);
  surface.setActive(true);
  selectionQueue = selectionQueue.catch(() => undefined).then(async () => {
    if (previous) await previous.bridge.releaseSurface(previous.lease);
    if (activeSurface !== surface || !surfaces.has(surface.lease)) return;
    await surface.select();
    if (activeSurface === surface) surface.report();
  }).catch(surface.fail);
}

export function NativeCodeEditorPane(props: NativeCodeEditorPaneProps) {
  const element = useRef<HTMLDivElement | null>(null);
  const registration = useRef<SurfaceRegistration | null>(null);
  const state = useRef(props.nativeState);
  state.current = props.nativeState;
  const save = useRef(props.onSave);
  save.current = props.onSave;
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback((error: unknown) => setError(error instanceof Error ? error.message : String(error)), []);
  const { root, path } = props.nativeState;
  const { original, renderSideBySide } = props;

  useLayoutEffect(() => {
    const node = element.current;
    const bridge = readLocalCodeOssBridge();
    if (!node || !bridge) return;
    const lease = crypto.randomUUID();
    let frame: number | null = null;
    let previous = "";
    let transitionFrames = 0;
    let disposed = false;
    const surface: SurfaceRegistration = {
      lease, bridge, element: node, setActive, fail,
      select: async () => {
        setError(null);
        const document = { root, path };
        if (original !== undefined) await bridge.request({ kind: "editor.diff", document, original, title: props.fileName, renderSideBySide });
        else await bridge.request({ kind: "editor.show", document });
      },
      report: () => undefined,
    };
    const report = () => {
      frame = null;
      if (disposed || activeSurface !== surface) return;
      const rect = node.getBoundingClientRect();
      const hidden = document.visibilityState === "hidden" || node.getClientRects().length === 0 || Boolean(node.closest("[inert],[hidden],[aria-hidden='true']"));
      const value: DesktopIdeSurface = {
        lease,
        visible: !hidden && rect.width > 0 && rect.height > 0,
        x: Math.max(0, rect.x), y: Math.max(0, rect.y),
        width: Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(0, rect.left)),
        height: Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(0, rect.top)),
        blocked: isNativeSurfaceOccluded(node, rect),
      };
      const key = JSON.stringify(value);
      if (key !== previous) {
        previous = key;
        void bridge.setSurface(value).catch(fail);
      }
      if (transitionFrames > 0) { transitionFrames -= 1; frame = requestAnimationFrame(report); }
    };
    const schedule = () => { if (frame === null && !disposed) frame = requestAnimationFrame(report); };
    const transition = () => { transitionFrames = 60; schedule(); };
    surface.report = schedule;
    registration.current = surface;
    surfaces.set(lease, surface);
    const resize = new ResizeObserver(schedule);
    resize.observe(node);
    // Observe only the surface's ancestors. Streaming chat text never triggers
    // a document-wide mutation observer or a geometry read for every token.
    const mutations = new MutationObserver(schedule);
    let ancestor: HTMLElement | null = node;
    while (ancestor) {
      mutations.observe(ancestor, { attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden", "inert"] });
      ancestor = ancestor.parentElement;
    }
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, schedule);
    document.addEventListener("visibilitychange", schedule);
    node.parentElement?.addEventListener("transitionrun", transition);
    activateSurface(surface);
    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, schedule);
      document.removeEventListener("visibilitychange", schedule);
      node.parentElement?.removeEventListener("transitionrun", transition);
      surfaces.delete(lease);
      registration.current = null;
      if (activeSurface === surface) {
        activeSurface = null;
        void bridge.releaseSurface(lease).catch(() => undefined);
        const remaining = [...surfaces.values()].findLast((item) => item.element.getClientRects().length > 0);
        if (remaining) activateSurface(remaining);
      }
    };
  }, [root, path, original, renderSideBySide, props.fileName, fail]);

  useEffect(() => {
    props.onHistoryChange?.({ canUndo: props.nativeState.canUndo, canRedo: props.nativeState.canRedo });
  }, [props.nativeState.canUndo, props.nativeState.canRedo, props.onHistoryChange]);

  useEffect(() => {
    const bridge = readLocalCodeOssBridge();
    const ref = props.historyControlsRef;
    if (!bridge || !ref) return;
    const execute = (request: DesktopIdeRequest) => { void bridge.request(request).catch(fail); };
    const controls: CodeEditHistoryControls = {
      undo: () => execute({ kind: "editor.undo", document: { root, path } }),
      redo: () => execute({ kind: "editor.redo", document: { root, path } }),
      // The existing Revert action is an undoable edit to its supplied baseline,
      // not an implicit disk reload or discard of the model's undo history.
      revertTo: (value) => {
        void bridge.request({ kind: "editor.open", document: { root, path } }).then((reply) => {
          const current = requireCodeOssDocument(reply);
          if (current.value === value) return null;
          return bridge.request({ kind: "editor.edit", document: { root, path }, revision: current.revision, value });
        }).catch(fail);
      },
    };
    ref.current = controls;
    return () => { if (ref.current === controls) ref.current = null; };
  }, [root, path, props.historyControlsRef, fail]);

  const activate = () => { if (registration.current) activateSurface(registration.current); };
  return (
    <div ref={element} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-native-code-editor="" role="region" aria-label={`Editor: ${props.fileName}`} tabIndex={0} onFocus={activate} onPointerDown={activate}>
      {/* Inactive surfaces show the same canonical buffer, with no second writer.
          Focusing one moves the retained native viewport into that exact pane. */}
      <pre className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre p-3 font-mono text-ui" aria-hidden={active || undefined}>{props.nativeState.value}</pre>
      {error ? <div role="alert" className="absolute inset-x-0 bottom-0 border-t border-border bg-background px-3 py-2 text-ui text-destructive">{error}</div> : null}
    </div>
  );
}

import { isDesktopIdeAppearance, type DesktopIdeAppearance } from "@synara/contracts";

const COLOR_VARIABLES = {
  surface: "--color-background-surface",
  shell: "--color-background-surface-under",
  raised: "--color-background-elevated-primary-opaque",
  input: "--color-background-control-opaque",
  foreground: "--color-text-foreground",
  muted: "--color-text-foreground-secondary",
  subtle: "--color-text-foreground-tertiary",
  border: "--color-border",
  focus: "--color-border-focus",
  accent: "--color-text-accent",
  button: "--color-background-button-primary",
  buttonHover: "--color-background-button-primary-hover",
  onAccent: "--color-text-button-primary",
  selection: "--color-background-accent",
  hover: "--color-background-button-secondary-hover",
  danger: "--destructive",
  warning: "--warning",
  success: "--success",
  diffAdded: "--color-editor-added",
  diffRemoved: "--color-editor-deleted",
} satisfies Record<keyof DesktopIdeAppearance["colors"], string>;

/** Read the rendered theme, including imported packs and the user's UI text size.
 * A single root-attribute observer is frame-batched; transcript DOM is never observed. */
export function observeDesktopIdeAppearance(
  publish: (appearance: DesktopIdeAppearance) => Promise<void>,
  onError: (error: unknown) => void,
): () => void {
  const root = document.documentElement;
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;contain:strict;width:0;height:0";
  root.append(probe);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let frame = 0;
  let disposed = false;
  let last = "";
  const read = () => {
    frame = 0;
    if (disposed || !context) return;
    try {
      const colors = {} as Record<keyof DesktopIdeAppearance["colors"], string>;
      for (const [key, variable] of Object.entries(COLOR_VARIABLES)) {
        probe.style.color = `var(${variable})`;
        const color = getComputedStyle(probe).color;
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        colors[key as keyof typeof colors] =
          "#" +
          Array.from(context.getImageData(0, 0, 1, 1).data, (channel) =>
            channel.toString(16).padStart(2, "0"),
          ).join("");
      }
      probe.style.fontFamily = "var(--font-ui-family)";
      probe.style.fontSize = "var(--app-font-size-ui)";
      probe.style.borderRadius = "var(--radius)";
      const computed = getComputedStyle(probe);
      const appearance: DesktopIdeAppearance = {
        variant: root.classList.contains("dark") ? "dark" : "light",
        colors,
        uiFontFamily: computed.fontFamily,
        uiFontSize: parseFloat(computed.fontSize),
        radius: parseFloat(computed.borderTopLeftRadius),
      };
      if (!isDesktopIdeAppearance(appearance))
        throw new Error("Could not resolve Synara appearance.");
      const signature = JSON.stringify(appearance);
      if (signature === last) return;
      last = signature;
      void publish(appearance).catch((error: unknown) => {
        if (disposed) return;
        if (last === signature) last = "";
        onError(error);
      });
    } catch (error) {
      onError(error);
    }
  };
  const schedule = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(read);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme-variant"],
  });
  schedule();
  return () => {
    disposed = true;
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    probe.remove();
  };
}

import { Color } from "../../base/common/color.js";
import { Disposable, MutableDisposable, toDisposable } from "../../base/common/lifecycle.js";
import { ConfigurationTarget } from "../../platform/configuration/common/configuration.js";
import { isDark, isHighContrast } from "../../platform/theme/common/theme.js";
import {
  IWorkbenchThemeService,
  ThemeSettingDefaults,
  type IColorMap,
  type IWorkbenchColorTheme,
} from "../../workbench/services/themes/common/workbenchThemeService.js";
import { isDesktopIdeAppearance, type DesktopIdeAppearance } from "../common/desktopIde.js";
import "./media/appearance.css";

/** Native color participants (including terminal, menus and extension webviews)
 * receive the same tokens as Synara. Never write user/workspace theme settings. */
function workbenchColors({ colors: c }: DesktopIdeAppearance): IColorMap {
  const entries: Record<string, string> = {};
  const set = (color: string, ...ids: string[]) => {
    for (const id of ids) entries[id] = color;
  };
  set(
    c.foreground,
    "foreground",
    "editor.foreground",
    "sideBar.foreground",
    "activityBar.foreground",
    "statusBar.foreground",
    "statusBar.noFolderForeground",
    "statusBar.debuggingForeground",
    "titleBar.activeForeground",
    "tab.activeForeground",
    "tab.unfocusedActiveForeground",
    "panelTitle.activeForeground",
    "input.foreground",
    "dropdown.foreground",
    "menu.foreground",
    "quickInput.foreground",
    "editorWidget.foreground",
    "editorHoverWidget.foreground",
    "list.activeSelectionForeground",
    "list.inactiveSelectionForeground",
    "list.hoverForeground",
    "list.focusForeground",
    "terminal.foreground",
    "sideBarTitle.foreground",
  );
  set(
    c.muted,
    "descriptionForeground",
    "icon.foreground",
    "sideBarSectionHeader.foreground",
    "activityBar.inactiveForeground",
    "titleBar.inactiveForeground",
    "tab.inactiveForeground",
    "tab.unfocusedInactiveForeground",
    "panelTitle.inactiveForeground",
    "input.placeholderForeground",
    "editorLineNumber.foreground",
    "breadcrumb.foreground",
  );
  set(c.subtle, "disabledForeground", "tab.inactiveModifiedBorder");
  set(
    c.surface,
    "editor.background",
    "sideBar.background",
    "sideBarSectionHeader.background",
    "panel.background",
    "terminal.background",
    "tab.activeBackground",
    "tab.unfocusedActiveBackground",
    "editorGroup.emptyBackground",
    "editorGutter.background",
    "breadcrumb.background",
    "settings.focusedRowBackground",
  );
  set(
    c.shell,
    "activityBar.background",
    "titleBar.activeBackground",
    "titleBar.inactiveBackground",
    "editorGroupHeader.tabsBackground",
    "editorGroupHeader.noTabsBackground",
    "tab.inactiveBackground",
    "tab.unfocusedInactiveBackground",
    "statusBar.background",
    "statusBar.noFolderBackground",
    "statusBar.debuggingBackground",
  );
  set(
    c.raised,
    "menu.background",
    "quickInput.background",
    "quickInputTitle.background",
    "editorWidget.background",
    "editorHoverWidget.background",
    "notifications.background",
    "notificationCenterHeader.background",
    "dropdown.listBackground",
  );
  set(
    c.input,
    "input.background",
    "dropdown.background",
    "button.secondaryBackground",
    "checkbox.background",
    "settings.textInputBackground",
    "settings.dropdownBackground",
  );
  set(
    c.border,
    "sideBar.border",
    "activityBar.border",
    "titleBar.border",
    "statusBar.border",
    "panel.border",
    "editorGroup.border",
    "editorGroupHeader.tabsBorder",
    "tab.border",
    "tab.lastPinnedBorder",
    "sideBarSectionHeader.border",
    "input.border",
    "dropdown.border",
    "menu.border",
    "widget.border",
    "editorWidget.border",
    "editorHoverWidget.border",
    "notificationCenter.border",
    "notifications.border",
    "checkbox.border",
    "commandCenter.border",
    "commandCenter.activeBorder",
    "pickerGroup.border",
  );
  set(c.focus, "focusBorder", "list.focusOutline", "sash.hoverBorder");
  set(
    c.accent,
    "activityBar.activeBorder",
    "activityBarTop.activeBorder",
    "panelTitle.activeBorder",
    "tab.activeBorderTop",
    "tab.unfocusedActiveBorderTop",
    "progressBar.background",
    "textLink.foreground",
    "textLink.activeForeground",
    "list.highlightForeground",
    "list.focusHighlightForeground",
    "editorCursor.foreground",
    "editorLineNumber.activeForeground",
    "badge.foreground",
    "pickerGroup.foreground",
  );
  set(
    c.selection,
    "list.activeSelectionBackground",
    "list.inactiveSelectionBackground",
    "list.focusBackground",
    "quickInputList.focusBackground",
    "selection.background",
    "editor.selectionBackground",
    "editor.inactiveSelectionBackground",
    "terminal.selectionBackground",
    "badge.background",
    "inputOption.activeBackground",
    "activityBar.activeBackground",
  );
  set(
    c.hover,
    "list.hoverBackground",
    "toolbar.hoverBackground",
    "toolbar.activeBackground",
    "tab.hoverBackground",
    "tab.unfocusedHoverBackground",
    "statusBarItem.hoverBackground",
    "button.secondaryHoverBackground",
    "commandCenter.background",
    "commandCenter.activeBackground",
    "menu.selectionBackground",
    "editor.lineHighlightBackground",
  );
  set(c.button, "button.background");
  set(c.buttonHover, "button.hoverBackground");
  set(c.onAccent, "button.foreground");
  set(
    c.foreground,
    "button.secondaryForeground",
    "menu.selectionForeground",
    "commandCenter.foreground",
    "commandCenter.activeForeground",
    "quickInputList.focusForeground",
  );
  set(
    c.danger,
    "errorForeground",
    "editorError.foreground",
    "gitDecoration.deletedResourceForeground",
    "terminal.ansiRed",
    "terminal.ansiBrightRed",
  );
  set(c.warning, "editorWarning.foreground", "terminal.ansiYellow", "terminal.ansiBrightYellow");
  set(
    c.success,
    "gitDecoration.addedResourceForeground",
    "gitDecoration.untrackedResourceForeground",
    "terminal.ansiGreen",
    "terminal.ansiBrightGreen",
  );
  set(c.diffAdded, "diffEditor.insertedTextBackground", "diffEditor.insertedLineBackground");
  set(c.diffRemoved, "diffEditor.removedTextBackground", "diffEditor.removedLineBackground");
  set("#00000000", "tab.activeBorder", "tab.unfocusedActiveBorder", "scrollbar.shadow");
  return Object.fromEntries(
    Object.entries(entries).map(([id, value]) => [id, Color.fromHex(value)]),
  );
}

export class SynaraWorkbenchAppearance extends Disposable {
  private readonly overlay = this._register(new MutableDisposable());
  private readonly rememberedThemes = new Map<string, IWorkbenchColorTheme>();
  private signature = "";
  private sequence = Promise.resolve();
  private root = document.querySelector<HTMLElement>(".monaco-workbench");
  private stopped = false;

  constructor(private readonly themes: IWorkbenchThemeService) {
    super();
    const syncAccessibility = () => {
      const theme = themes.getBaseColorTheme();
      // Never replace high-contrast colors or suppress their focus indicators.
      this.root?.classList.toggle(
        "synara-workbench",
        Boolean(this.signature) && !isHighContrast(theme.type),
      );
      if (!isHighContrast(theme.type))
        this.rememberedThemes.set(isDark(theme.type) ? "dark" : "light", theme);
    };
    syncAccessibility();
    this._register(themes.onDidColorThemeChange(syncAccessibility));
    this._register(
      toDisposable(() => {
        this.stopped = true;
        this.root?.classList.remove("synara-workbench");
        for (const name of ["--synara-ui-font", "--synara-ui-size", "--synara-radius"])
          this.root?.style.removeProperty(name);
        this.root?.removeAttribute("data-synara-appearance");
      }),
    );
  }

  apply(appearance: DesktopIdeAppearance): Promise<void> {
    if (!isDesktopIdeAppearance(appearance))
      return Promise.reject(new Error("Invalid native appearance."));
    const signature = JSON.stringify(appearance);
    if (this.signature === signature) return this.sequence;
    this.signature = signature;
    this.sequence = this.sequence
      .catch(() => {})
      .then(async () => {
        if (this.stopped || this.signature !== signature) return;
        const base = this.themes.getBaseColorTheme();
        if (!isHighContrast(base.type) && isDark(base.type) !== (appearance.variant === "dark")) {
          const remembered = this.rememberedThemes.get(appearance.variant);
          const id =
            appearance.variant === "dark"
              ? ThemeSettingDefaults.COLOR_THEME_DARK
              : ThemeSettingDefaults.COLOR_THEME_LIGHT;
          const selected =
            remembered ??
            (await this.themes.getColorThemes()).find((theme) => theme.settingsId === id);
          if (this.stopped || this.signature !== signature) return;
          if (selected) await this.themes.setColorTheme(selected, ConfigurationTarget.MEMORY);
        }
        if (this.stopped || this.signature !== signature) return;
        this.root ??= document.querySelector<HTMLElement>(".monaco-workbench");
        this.root?.style.setProperty("--synara-ui-font", appearance.uiFontFamily);
        this.root?.style.setProperty("--synara-ui-size", `${appearance.uiFontSize}px`);
        this.root?.style.setProperty("--synara-radius", `${appearance.radius}px`);
        this.overlay.value = this.themes.registerColorThemeOverlay((theme) =>
          isHighContrast(theme.type) ? {} : workbenchColors(appearance),
        );
        this.root?.setAttribute("data-synara-appearance", appearance.variant);
      });
    return this.sequence;
  }
}

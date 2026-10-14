// Synara's existing Agent UI owns onboarding and provider authentication.
// Keep the native service contract without importing Microsoft's branded flow.
import { Emitter } from "../../base/common/event.js";
import { Disposable } from "../../base/common/lifecycle.js";
import { ipcRenderer } from "../../base/parts/sandbox/electron-browser/globals.js";
import { InstantiationType, registerSingleton } from "../../platform/instantiation/common/extensions.js";
import { IOnboardingService } from "../../workbench/contrib/welcomeOnboarding/common/onboardingService.js";

class SynaraOnboarding extends Disposable implements IOnboardingService {
  declare readonly _serviceBrand: undefined;
  private readonly dismissed = this._register(new Emitter<void>());
  readonly onDidDismiss = this.dismissed.event;

  show(): void {
    void ipcRenderer.invoke("vscode:synara", { kind: "mode", value: "agent" }).finally(() => {
      this.dismissed.fire();
    });
  }
}

registerSingleton(IOnboardingService, SynaraOnboarding, InstantiationType.Delayed);

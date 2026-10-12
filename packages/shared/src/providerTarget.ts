import {
  DEFAULT_PROVIDER_PROFILE_ID,
  type ModelSelection,
  type ProviderKind,
  type ProviderInstanceId,
  type ProviderProfileId,
  type ProviderTarget,
} from "@synara/contracts";

interface ProviderTargetSource {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly profileId?: ProviderProfileId | undefined;
}

export function defaultProviderTarget(
  provider: ProviderKind,
  instanceId?: ProviderInstanceId | undefined,
): ProviderTarget {
  return {
    provider,
    ...(instanceId !== undefined ? { instanceId } : {}),
    profileId: DEFAULT_PROVIDER_PROFILE_ID,
  };
}

export function providerTargetFromModelSelection(
  modelSelection: ModelSelection,
): ProviderTarget {
  return providerTargetFromSource(modelSelection);
}

export function providerTargetFromSource(source: ProviderTargetSource): ProviderTarget {
  return {
    provider: source.provider,
    ...(source.instanceId !== undefined ? { instanceId: source.instanceId } : {}),
    profileId: source.profileId ?? DEFAULT_PROVIDER_PROFILE_ID,
  };
}

export function providerTargetsEqual(left: ProviderTarget, right: ProviderTarget): boolean {
  return (
    left.provider === right.provider &&
    (left.instanceId ?? left.provider) === (right.instanceId ?? right.provider) &&
    left.profileId === right.profileId
  );
}

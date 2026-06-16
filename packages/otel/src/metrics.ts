import {
  metrics,
  type Attributes,
} from "@opentelemetry/api";
import {
  type Resource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  MeterProvider,
  type MetricReader,
} from "@opentelemetry/sdk-metrics";

export interface RawTreeMeterProviderRegistrationOptions {
  forceRegisterProvider?: boolean;
  unregisterOnClose?: boolean;
  metricReaders?: MetricReader[];
  resource?: Resource;
  resourceAttributes?: Attributes;
}

export interface RawTreeMeterProviderRegistration {
  isEnabled: boolean;
  providerRegistered: boolean;
  created: boolean;
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

let meterProvider: MeterProvider | undefined;

export function registerRawTreeMeterProvider(
  options: RawTreeMeterProviderRegistrationOptions = {},
): RawTreeMeterProviderRegistration {
  const registration = ensureRawTreeMeterProvider(options, options.metricReaders ?? []);

  return {
    isEnabled: registration.providerRegistered,
    providerRegistered: registration.providerRegistered,
    created: registration.created,
    forceFlush: async () => {
      await meterProvider?.forceFlush();
    },
    shutdown: async () => {
      if (options.unregisterOnClose === false) {
        await meterProvider?.forceFlush();
        return;
      }

      await shutdownRawTreeMeterProvider();
    },
  };
}

export async function shutdownRawTreeMeterProvider(): Promise<void> {
  if (!meterProvider) {
    return;
  }

  const providerToShutdown = meterProvider;
  meterProvider = undefined;

  if (isActiveMeterProvider(providerToShutdown)) {
    metrics.disable();
  }

  await providerToShutdown.shutdown();
}

function ensureRawTreeMeterProvider(
  options: RawTreeMeterProviderRegistrationOptions,
  metricReaders: MetricReader[],
): { providerRegistered: boolean; created: boolean } {
  if (meterProvider) {
    return {
      providerRegistered: isActiveMeterProvider(meterProvider),
      created: false,
    };
  }

  if (hasExistingMeterProvider()) {
    if (!options.forceRegisterProvider) {
      return {
        providerRegistered: false,
        created: false,
      };
    }

    metrics.disable();
  }

  const nextProvider = new MeterProvider({
    resource: options.resource ?? (options.resourceAttributes
      ? resourceFromAttributes(options.resourceAttributes)
      : undefined),
    readers: metricReaders,
  });
  const registered = metrics.setGlobalMeterProvider(nextProvider);

  meterProvider = registered && isActiveMeterProvider(nextProvider)
    ? nextProvider
    : undefined;

  if (!meterProvider) {
    void nextProvider.shutdown().catch(() => undefined);
  }

  return {
    providerRegistered: meterProvider !== undefined,
    created: meterProvider !== undefined,
  };
}

function hasExistingMeterProvider(): boolean {
  return !isNoopMeterProvider(activeMeterProviderDelegate());
}

function isActiveMeterProvider(candidate: MeterProvider): boolean {
  return activeMeterProviderDelegate() === candidate;
}

function activeMeterProviderDelegate(): unknown {
  const meterProviderDelegate = metrics.getMeterProvider() as {
    getDelegate?: () => unknown;
  };

  return typeof meterProviderDelegate.getDelegate === "function"
    ? meterProviderDelegate.getDelegate()
    : meterProviderDelegate;
}

function isNoopMeterProvider(candidate: unknown): boolean {
  return typeof candidate === "object"
    && candidate !== null
    && candidate.constructor?.name === "NoopMeterProvider";
}

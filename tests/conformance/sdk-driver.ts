import { storeConfig } from './storage.ts';
import { createSdkDriver } from '../../src/conformance/sdk-driver.ts';
export const sdkDriver = createSdkDriver(storeConfig);

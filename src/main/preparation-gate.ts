// One app-owned gate, shared without importing the main-process entry point.
// Workers have separate module state: scope their lifetime in the parent before starting them.
import { createSingleFlight } from './single-flight.ts'

let releasePrewarm: () => void = () => {}
export function setPreparationReleaseHook(release: () => void): void { releasePrewarm = release }
export const preparePass = createSingleFlight({ beforeRequest: () => releasePrewarm() })
export const withPrewarmYield = preparePass.withPrewarmYield

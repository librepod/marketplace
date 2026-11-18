import type { OnboardingStore } from './onboarding-store';
import { formatSetupCode, isBcryptHash } from './setup-code';

/** `reset-onboarding` (spec §6): a new setup code and onboarding open again. Apps,
 * data, users and VPN peers stay. Returns the process exit code. */
export async function runReset(
  store: Pick<OnboardingStore, 'reset'>,
  out: Pick<Console, 'log' | 'error'>,
): Promise<number> {
  try {
    const code = await store.reset();
    const shown = isBcryptHash(code)
      ? "the one printed on this device's sticker"
      : formatSetupCode(code);
    out.log(
      `LibrePod setup code: ${shown} — onboarding is open again; open http://<this device's IP> to continue`,
    );
    return 0;
  } catch (err) {
    out.error(`reset-onboarding failed: ${(err as Error).message}`);
    return 1;
  }
}

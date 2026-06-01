import { runAllTests as runSharedSuite } from './shared.spec';
import { runProviderCompatibleTests } from './provider-compatible.spec';

export async function runAllTests() {
  await runSharedSuite();
  await runProviderCompatibleTests();
}

/**
 * `./tradingapp.sh forget-secrets`: for when SETTINGS_ENCRYPTION_KEY is lost.
 *
 * Clears every value sealed under the old key (broker connection secrets,
 * secret settings, the MFA secret and the session key) so the backend can
 * start with the key now in `.env`. Connections, settings and logins are
 * otherwise kept; the cleared secrets are entered again in the app. Output:
 *
 *   CLEARED <what> <count>
 *   ERROR <message>
 */
import { forgetSealedSecrets } from '../services/keyCheck.js';

async function main(): Promise<number> {
  const { dbService } = await import('../services/database.js');
  try {
    const cleared = await dbService.transaction((client) => forgetSealedSecrets(client));
    for (const [what, n] of Object.entries(cleared)) console.log(`CLEARED ${what} ${n}`);
    return 0;
  } catch (err) {
    console.log(`ERROR ${(err as Error)?.message ?? String(err)}`);
    return 1;
  } finally {
    await dbService.close().catch(() => undefined);
  }
}

if (require.main === module) {
  void main().then((code) => process.exit(code));
}

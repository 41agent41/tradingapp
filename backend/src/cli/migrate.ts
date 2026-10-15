/**
 * `./tradingapp.sh migrate`: brings the database schema up to date and checks
 * the encryption key, the same steps the backend runs at startup. Useful to
 * see what a database is missing without restarting anything. Output:
 *
 *   APPLIED <version>     applied by this run
 *   CURRENT <version>     already up to date
 *   KEY ok | KEY <reason>
 *   ERROR <message>
 */
import { checkEncryptionKey } from '../services/keyCheck.js';
import { runMigrations } from '../services/migrations.js';

async function main(): Promise<number> {
  const { dbService } = await import('../services/database.js');
  const client = await dbService.getClient().catch((err: Error) => {
    console.log(`ERROR cannot reach the database: ${err.message}`);
    return null;
  });
  if (!client) {
    await dbService.close().catch(() => undefined);
    return 1;
  }
  try {
    const result = await runMigrations(client);
    for (const v of result.current) {
      console.log(`${result.applied.includes(v) ? 'APPLIED' : 'CURRENT'} ${v}`);
    }
    const key = await checkEncryptionKey(dbService);
    console.log(key.ok ? 'KEY ok' : `KEY ${key.reason}`);
    return key.ok ? 0 : 2;
  } catch (err) {
    console.log(`ERROR ${(err as Error)?.message ?? String(err)}`);
    return 1;
  } finally {
    client.release();
    await dbService.close().catch(() => undefined);
  }
}

if (require.main === module) {
  void main().then((code) => process.exit(code));
}

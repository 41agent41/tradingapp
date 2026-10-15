/** An in-memory stand-in for `auth_credentials` and `settings_audit`. */
export function credentialsDb() {
  const rows = new Map<string, any>();
  const audit: any[] = [];
  const upsert = (id: string, fields: Record<string, unknown>, replace: boolean) => {
    if (rows.has(id) && !replace) return;
    rows.set(id, {
      id,
      label: null,
      prefix: null,
      hash: null,
      ciphertext: null,
      created_by: null,
      last_used_at: null,
      ...(rows.get(id) ?? {}),
      ...fields,
      created_at: new Date(),
    });
  };
  return {
    rows,
    audit,
    async query(text: string, params: any[] = []) {
      const sql = text.replace(/\s+/g, ' ');
      if (sql.startsWith('SELECT id, kind')) return { rows: [...rows.values()] };
      if (sql.startsWith("SELECT ciphertext FROM auth_credentials WHERE id = 'session_secret'")) {
        const r = rows.get('session_secret');
        return { rows: r ? [r] : [] };
      }
      if (sql.includes("VALUES ('session_secret'")) {
        upsert(
          'session_secret',
          { kind: 'session_secret', ciphertext: params[0] },
          sql.includes('DO UPDATE')
        );
        return { rows: [] };
      }
      if (sql.includes("VALUES ('password'")) {
        upsert('password', { kind: 'password', hash: params[0], created_by: params[1] }, true);
        return { rows: [] };
      }
      if (sql.includes("VALUES ('mfa'")) {
        upsert('mfa', { kind: 'mfa', ciphertext: params[0], created_by: params[1] }, true);
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO auth_credentials (id, kind, label, prefix, hash')) {
        const [id, kind, label, prefix, hash, by] = params;
        upsert(id, { kind, label, prefix, hash, created_by: by }, true);
        return { rows: [] };
      }
      if (sql.startsWith("DELETE FROM auth_credentials WHERE id = 'mfa'")) {
        rows.delete('mfa');
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM auth_credentials WHERE id = $1')) {
        rows.delete(params[0]);
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE auth_credentials SET last_used_at')) return { rows: [] };
      if (sql.startsWith('INSERT INTO settings_audit')) {
        audit.push({ key: params[0], action: params[1], new_value: params[2] });
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

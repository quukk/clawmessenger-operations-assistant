const { generateSecret, verifySecret } = require('../../service/modules/auth');

describe('Auth Module', () => {
  test('generateSecret returns consistent results for same inputs', () => {
    const secret1 = generateSecret('00:11:22:33:44:55', 'my-secret-key');
    const secret2 = generateSecret('00:11:22:33:44:55', 'my-secret-key');
    expect(secret1).toBe(secret2);
  });

  test('generateSecret returns 32-character hex string', () => {
    const secret = generateSecret('00:11:22:33:44:55', 'my-secret-key');
    expect(secret).toHaveLength(32);
    expect(secret).toMatch(/^[a-f0-9]{32}$/);
  });

  test('verifySecret returns true for correct secret', () => {
    const mac = '00:11:22:33:44:55';
    const secretKey = 'my-secret-key';
    const expectedSecret = generateSecret(mac, secretKey);
    expect(verifySecret(mac, secretKey, expectedSecret)).toBe(true);
  });

  test('verifySecret returns false for incorrect secret', () => {
    const mac = '00:11:22:33:44:55';
    const secretKey = 'my-secret-key';
    const wrongSecret = 'wrong-secret-hash';
    expect(verifySecret(mac, secretKey, wrongSecret)).toBe(false);
  });

  test('different inputs produce different secrets', () => {
    const secret1 = generateSecret('00:11:22:33:44:55', 'key1');
    const secret2 = generateSecret('00:11:22:33:44:66', 'key1');
    const secret3 = generateSecret('00:11:22:33:44:55', 'key2');
    expect(secret1).not.toBe(secret2);
    expect(secret1).not.toBe(secret3);
    expect(secret2).not.toBe(secret3);
  });
});

const { getMacAddress } = require('../../service/modules/mac-address');

describe('getMacAddress', () => {
  test('should return a string', () => {
    const mac = getMacAddress();
    expect(typeof mac).toBe('string');
  });

  test('should return valid MAC address format (12 hex chars) or unknown', () => {
    const mac = getMacAddress();
    const isValidMac = /^[0-9a-f]{12}$/.test(mac);
    const isUnknown = mac === 'unknown';
    expect(isValidMac || isUnknown).toBe(true);
  });

  test('should not contain colons', () => {
    const mac = getMacAddress();
    expect(mac).not.toContain(':');
  });

  test('should be lowercase', () => {
    const mac = getMacAddress();
    expect(mac).toBe(mac.toLowerCase());
  });
});

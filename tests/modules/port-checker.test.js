const net = require('net');
const { checkPortListening, getOpenClawStatus } = require('../../service/modules/port-checker');

describe('port-checker', () => {
  let server;
  const testPort = 33100;

  beforeAll((done) => {
    server = net.createServer();
    server.listen(testPort, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.close(done);
  });

  test('checkPortListening returns a boolean', async () => {
    const result = await checkPortListening(testPort);
    expect(typeof result).toBe('boolean');
  });

  test('checkPortListening returns true for listening port', async () => {
    const result = await checkPortListening(testPort);
    expect(result).toBe(true);
  });

  test('checkPortListening returns false for non-listening port', async () => {
    const result = await checkPortListening(33101);
    expect(result).toBe(false);
  });

  test('getOpenClawStatus returns 0 or 1', async () => {
    const result = await getOpenClawStatus(testPort);
    expect([0, 1]).toContain(result);
  });

  test('getOpenClawStatus returns 1 for listening port', async () => {
    const result = await getOpenClawStatus(testPort);
    expect(result).toBe(1);
  });

  test('getOpenClawStatus returns 0 for non-listening port', async () => {
    const result = await getOpenClawStatus(33101);
    expect(result).toBe(0);
  });
});

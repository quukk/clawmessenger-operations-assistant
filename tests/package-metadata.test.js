const assert = require('node:assert/strict');
const { test } = require('node:test');

const packageJson = require('../package.json');
const packageLock = require('../package-lock.json');

test('package and lock require the supported Node 18 runtime floor', () => {
  assert.equal(packageJson.engines?.node, '>=18.0.0');
  assert.equal(packageLock.packages?.['']?.engines?.node, '>=18.0.0');
});

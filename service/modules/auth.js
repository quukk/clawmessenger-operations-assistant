const crypto = require('crypto');

function generateSecret(mac, secretKey) {
  return crypto.createHash('md5')
    .update(mac + secretKey)
    .digest('hex');
}

function verifySecret(mac, secretKey, expectedSecret) {
  const calculated = generateSecret(mac, secretKey);
  return calculated === expectedSecret;
}

module.exports = {
  generateSecret,
  verifySecret
};

const assert = require('assert');
const {
  normalizarTelefonoWhatsApp,
  crearWhatsappUrl
} = require('../frontend/shared/whatsapp');

assert.strictEqual(normalizarTelefonoWhatsApp('+598 98 689 005'), '59898689005');
assert.strictEqual(normalizarTelefonoWhatsApp('598-98-689-005'), '59898689005');
assert.strictEqual(normalizarTelefonoWhatsApp('(598) 98 689 005'), '59898689005');
assert.strictEqual(normalizarTelefonoWhatsApp('098 689 005'), '');
assert.strictEqual(normalizarTelefonoWhatsApp(''), '');
assert.strictEqual(normalizarTelefonoWhatsApp(null), '');

assert.strictEqual(
  crearWhatsappUrl('+598 98 689 005'),
  'https://wa.me/59898689005'
);

assert.strictEqual(
  crearWhatsappUrl('+598 98 689 005', 'Hola, quiero reservar'),
  'https://wa.me/59898689005?text=Hola%2C%20quiero%20reservar'
);

assert.strictEqual(crearWhatsappUrl(undefined), '');

const clienteA = crearWhatsappUrl('+598 91 111 111');
const clienteB = crearWhatsappUrl('+598 92 222 222');

assert.strictEqual(clienteA, 'https://wa.me/59891111111');
assert.strictEqual(clienteB, 'https://wa.me/59892222222');
assert.notStrictEqual(clienteA, clienteB);

console.log('whatsapp-url.test ok');

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');

assert.ok(
  html.includes('<script src="/shared/whatsapp.js"></script>'),
  'El helper de WhatsApp debe cargarse antes del script principal.'
);

assert.ok(
  html.includes('const whatsappPublico = d.whatsapp || ubicacionPrincipal?.whatsapp ||'),
  'La pagina publica debe usar el WhatsApp del comercio o de la ubicacion principal.'
);

assert.ok(
  html.includes('window.AgendateWhatsApp?.crearWhatsappUrl(whatsappPublico'),
  'La pagina publica debe usar el helper para generar la URL de WhatsApp.'
);

assert.ok(
  /\.pc-tema-claro\s+\.btn-sig\s*\{[^}]*color:#FFFFFF/i.test(html),
  'El boton principal en tema claro debe declarar texto blanco explicitamente.'
);

assert.ok(
  /\.pc-tema-claro\s+\.btn-sig:disabled\s*\{[^}]*color:#6D6257/i.test(html),
  'El boton principal deshabilitado en tema claro debe seguir siendo legible.'
);

assert.ok(
  /\.btn-atras:focus-visible,\s*\n\.btn-sig:focus-visible\s*\{[^}]*outline:2px solid var\(--oro\)/i.test(html),
  'Los botones del flujo publico deben tener foco visible.'
);

console.log('public-booking-style.test ok');

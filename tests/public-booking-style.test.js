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
  /\.btn-atras:focus-visible,\s*\n\.btn-sig:focus-visible\s*\{[^}]*outline:2px solid var\(--pc-action-focus\)/i.test(html),
  'Los botones del flujo publico deben tener foco visible.'
);

assert.ok(
  html.includes('--pc-action-bg') && html.includes('--pc-action-text'),
  'El flujo publico debe declarar variables de accion para evitar contraste heredado.'
);

assert.ok(
  /\.btn-sig\s*\{[^}]*background:var\(--pc-action-bg\)[^}]*color:var\(--pc-action-text\)/s.test(html),
  'El boton principal debe usar variables explicitas de fondo y texto.'
);

assert.ok(
  /\.ag-about\s+\.legal-brand::before\s*\{[^}]*content:\s*none/s.test(html),
  'La pagina sobre no debe mostrar el cuadrado decorativo antes del logo.'
);

assert.ok(
  html.includes('class="com-sidebar-logo-img" id="cs-logo-img" data-logo-plataforma'),
  'El panel del comercio debe usar el logo global de Agendate.'
);

console.log('public-booking-style.test ok');

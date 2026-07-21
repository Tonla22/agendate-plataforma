const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');

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
  html.includes('class="com-sidebar-logo-img com-sidebar-logo-img--dark"') &&
    html.includes('class="com-sidebar-logo-img com-sidebar-logo-img--light"'),
  'El panel del comercio debe conservar los logos de Agendate para tema oscuro y claro.'
);

assert.ok(
  html.includes('class="logo-plataforma-admin logo-plataforma-admin--dark" src="/assets/agendate-logo-dark.png"') &&
    html.includes('class="logo-plataforma-admin logo-plataforma-admin--light" src="/assets/agendate-logo.png"') &&
    html.includes('class="logo-plataforma-login logo-plataforma-login--dark" src="/assets/agendate-logo-dark.png"') &&
    html.includes('class="logo-plataforma-login logo-plataforma-login--light" src="/assets/agendate-logo.png"'),
  'El administrador y el login deben usar los logos versionados en codigo para ambos temas.'
);

assert.ok(
  html.includes('<meta name="application-name" content="Agendate">') &&
    html.includes('<link rel="canonical" href="https://tuagendate.com/sobre">'),
  'La portada debe identificar a Agendate y declarar su URL canonica para la verificacion OAuth.'
);

assert.ok(
  html.includes('<link rel="icon" type="image/png" href="/assets/agendate-isotipo.png?v=1">') &&
    fs.existsSync(path.join(__dirname, '../frontend/assets/agendate-isotipo.png')),
  'Todas las rutas deben usar el isotipo de Agendate como favicon.'
);

assert.ok(
  html.includes("titulo: 'Agendate'") &&
    html.includes('Agendate es una aplicación web de gestión de reservas para comercios de servicios.'),
  'La portada debe mostrar el nombre OAuth exacto y explicar explicitamente el proposito de la app.'
);

assert.ok(
  server.includes("app.get('/', (req, res) => res.redirect(302, '/sobre'))") &&
    server.indexOf("app.get('/', (req, res) => res.redirect(302, '/sobre'))") <
    server.indexOf("app.use(express.static(path.join(__dirname, '../frontend')"),
  'La raiz debe redirigir a /sobre antes de servir la SPA para que los crawlers lleguen a la portada.'
);

assert.ok(
  html.includes('<main id="agendate-static-home" class="agendate-static-home">') &&
    html.includes('Por qué Agendate solicita acceso a Google Calendar') &&
    html.includes("document.getElementById('agendate-static-home')?.remove()"),
  'La portada debe explicar el producto y el uso de datos de Google aun para crawlers sin JavaScript.'
);

assert.ok(
  html.includes("<script>document.documentElement.classList.add('js')</script>") &&
    /\.js\s+\.agendate-static-home\s*\{[^}]*display:\s*none/s.test(html),
  'La portada estatica no debe producir un pantallazo antes de resolver la ruta con JavaScript.'
);

assert.ok(
  html.includes('function decodificarEntidadesHtml(valor)') &&
    html.includes("document.title = decodificarEntidadesHtml(data.nombre) + ' · Reservas'") &&
    html.includes('document.title = `${configuracion.titulo} · ${comercioNombrePlano}`'),
  'Los titulos publicos deben mostrar apostrofes y entidades HTML como texto normal.'
);

console.log('public-booking-style.test ok');

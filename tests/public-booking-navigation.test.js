const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');

assert.ok(html.includes('function pcLimpiarSeleccionesReservaDesde'), 'El flujo publico debe limpiar selecciones al volver.');
assert.ok(html.includes('function pcPrepararHistorialReserva'), 'El flujo publico debe escuchar el boton atras del navegador.');
assert.ok(html.includes("window.addEventListener('popstate'"), 'Debe existir manejo de popstate para mobile/browser back.');
assert.ok(html.includes('function pcIrPaso(n, opciones = {})'), 'pcIrPaso debe aceptar opciones para evitar loops de historial.');
assert.ok(html.includes('destino < pasoAnterior'), 'Volver pasos debe disparar limpieza de estado dependiente.');
assert.ok(html.includes('S.reserva.servicio = null'), 'Volver a servicio debe borrar el servicio viejo.');
assert.ok(html.includes('S.reserva.fecha = null'), 'Volver debe borrar fecha vieja cuando corresponda.');
assert.ok(html.includes('S.reserva.hora = null'), 'Volver debe borrar hora vieja cuando corresponda.');
assert.ok(html.includes("pcSetDisabled('pc-btn23', true)"), 'Volver debe deshabilitar avance sin seleccion nueva.');
assert.ok(html.includes('pcPushReservaHistory(destino)'), 'Cambiar de paso debe registrar historial estable.');

console.log('public-booking-navigation.test ok');

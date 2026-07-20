const { test, expect } = require('@playwright/test');

test('completa una reserva sin pago desde la página pública', async ({ page, request }) => {
  await page.goto('/e2e-reservas');
  await page.getByRole('button', { name: 'Reservar turno' }).click();

  await page.getByRole('button', { name: 'Elegir servicio →' }).click();
  await page.locator('.opc-serv', { hasText: 'Reserva E2E sin pago' }).click();
  await page.getByRole('button', { name: 'Elegir fecha →' }).click();

  const dias = page.locator('.cal-d.disp');
  const cantidadDias = await dias.count();
  expect(cantidadDias).toBeGreaterThan(0);
  await dias.nth(cantidadDias > 1 ? 1 : 0).click();
  await page.getByRole('button', { name: 'Elegir horario →' }).click();

  const horas = page.locator('.hora-b');
  await expect(horas.first()).toBeVisible();
  await horas.first().click();
  await page.getByRole('button', { name: 'Mis datos →' }).click();

  await page.getByPlaceholder('Tu nombre').fill('Prueba');
  await page.getByPlaceholder('Tu apellido').fill('Automática');
  await page.getByPlaceholder('+598 91 000 000').fill('59899000001');
  await page.locator('#pc-email').fill('e2e@tuagendate.com');
  await page.getByRole('button', { name: 'Revisar →', exact: true }).click();

  const respuestaReserva = page.waitForResponse(respuesta =>
    respuesta.url().includes('/api/p/e2e-reservas/reservar') &&
    respuesta.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Confirmar turno' }).click();

  const respuesta = await respuestaReserva;
  expect(respuesta.status()).toBe(201);
  const creada = await respuesta.json();
  expect(creada.requiere_pago).toBe(false);

  await expect(page.getByRole('heading', { name: '¡Turno confirmado!' })).toBeVisible();

  const detalle = await request.get(`/api/p/reservas/${creada.uuid}`);
  expect(detalle.ok()).toBeTruthy();
  const reserva = await detalle.json();
  expect(reserva.estado).toBe('confirmada');
  expect(reserva.forma_pago).toBe('local');
});

test('rechaza una confirmación simultánea para el mismo horario', async ({ request }) => {
  const comercioRespuesta = await request.get('/api/p/e2e-reservas');
  expect(comercioRespuesta.ok()).toBeTruthy();
  const comercio = await comercioRespuesta.json();
  const servicio = comercio.servicios.find(item => item.nombre === 'Reserva E2E sin pago');
  expect(servicio).toBeTruthy();

  const fecha = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const disponibilidad = await request.get(
    `/api/p/e2e-reservas/disponibilidad?fecha=${fecha}&servicio_id=${servicio.id}`
  );
  expect(disponibilidad.ok()).toBeTruthy();
  const { horas } = await disponibilidad.json();
  expect(horas.length).toBeGreaterThan(0);

  const base = {
    servicio_id: servicio.id,
    fecha,
    hora: horas[0],
    apellido: 'Simultánea',
    email: 'simultanea@tuagendate.com',
    comentarios: 'Prueba E2E de concurrencia',
    forma_pago: 'local'
  };

  const [primera, segunda] = await Promise.all([
    request.post('/api/p/e2e-reservas/reservar', {
      data: { ...base, nombre: 'Primera', whatsapp: '59899000002' }
    }),
    request.post('/api/p/e2e-reservas/reservar', {
      data: { ...base, nombre: 'Segunda', whatsapp: '59899000003' }
    })
  ]);

  expect([primera.status(), segunda.status()].sort()).toEqual([201, 409]);
  const conflicto = primera.status() === 409 ? primera : segunda;
  expect((await conflicto.json()).error).toContain('ya fue reservado');
});

# Operacion de Agendate

Esta guia describe los controles minimos de la beta comercial. No contiene secretos.

## Salud y monitoreo

- Liveness publico: `GET https://tuagendate.com/api/health/live`; comprueba solo el servidor y no consulta PostgreSQL.
- Health completo: `GET https://tuagendate.com/api/health`; comprueba servidor y base de datos.
- Respuesta correcta: HTTP `200`, `status: "healthy"` y los controles correspondientes en `ok`.
- Una falla de base de datos responde HTTP `503` para que el monitor externo genere una alerta.
- El superadmin puede abrir **Estado del sistema** para revisar actividad, pagos, sincronizacion de Google Calendar, WhatsApp y eventos recientes.
- Los errores operativos se conservan 90 dias y los repetidos se agrupan durante cinco minutos.

Monitor externo recomendado:

1. Crear un monitor HTTPS para `https://tuagendate.com/api/health/live`.
2. Usar una frecuencia de 3 a 5 minutos.
3. Considerar correcto solo HTTP `200` y buscar `"status":"healthy"` en el cuerpo.
4. Enviar alertas al correo operativo del proyecto.
5. Alertar despues de dos fallos consecutivos y volver a avisar cuando se recupere.

Ademas, `.github/workflows/production-monitor.yml` consulta el health completo una vez por hora. Si falla, abre un unico issue con la etiqueta `monitoreo`, deja el workflow en rojo y cierra el issue al recuperarse. Conviene mantener activadas las notificaciones de Actions e issues del repositorio.

Prueba mensual del monitor: pausar el servicio durante una ventana controlada o apuntar temporalmente un monitor de prueba a una URL inexistente, confirmar que llega la alerta y luego restaurarlo.

## Pruebas automatizadas

Desde la raiz del repositorio:

```powershell
cd C:\Users\tonto\OneDrive\Desktop\agendate-plataforma-v2\agendate
npm.cmd test
npm.cmd run test:e2e
```

`npm test` valida reglas y contratos de codigo. `npm run test:e2e` levanta la aplicacion con una base exclusiva de pruebas, completa una reserva sin pago y verifica que dos intentos simultaneos no puedan reservar el mismo turno.

Nunca ejecutar E2E contra produccion. El guard de la suite bloquea URLs remotas salvo habilitacion explicita y bloquea siempre `NODE_ENV=production`.

## Despliegue

1. Ejecutar `npm.cmd test`.
2. Subir los cambios a `main`.
3. Confirmar que GitHub Actions termina correctamente.
4. Esperar el despliegue de Render.
5. Ejecutar la migracion aditiva cuando haya cambios de esquema:

```powershell
cd C:\Users\tonto\OneDrive\Desktop\agendate-plataforma-v2\agendate\backend
npm.cmd run db:init
```

6. Verificar `/api/health`, login admin, una reserva de prueba y el panel **Estado del sistema**.

## Copias de seguridad

La base de produccion esta alojada en Neon. Su restauracion por punto en el tiempo depende del plan: Free ofrece hasta 6 horas, Launch hasta 7 dias y Scale hasta 30 dias. Para la beta comercial se recomienda como minimo Launch o snapshots programados equivalentes.

En Neon, abrir el proyecto y entrar a **Backup & Restore**. Crear un snapshot manual antes de cada migracion y, si el plan lo permite, programar snapshots diarios. Como defensa adicional puede mantenerse un `pg_dump` cifrado fuera del servidor de aplicacion. Retencion minima recomendada:

- diarios: 7 dias;
- semanales: 4 semanas;
- mensuales: 3 meses.

Un respaldo no esta comprobado hasta restaurarlo. Cada mes:

1. Crear una base PostgreSQL temporal y aislada.
2. Restaurar el respaldo mas reciente.
3. Comprobar los conteos de `comercios`, `reservas` y `usuarios_comercio`.
4. Abrir una reserva restaurada y verificar sus relaciones con comercio, servicio y profesional.
5. Registrar fecha, respaldo usado, resultado y responsable.
6. Eliminar la base temporal al finalizar.

No guardar dumps sin cifrar en Git, GitHub Actions ni el disco publico del servicio.

### Ultima prueba de recuperacion

El 20 de julio de 2026 se creo un snapshot manual de `production` en Neon y se restauro mediante **Multi-step restore** a una rama aislada. La operacion termino correctamente en 0,53 segundos. En la copia se verificaron las tablas operativas y sus conteos (`comercios`: 3, `reservas`: 44, `usuarios_comercio`: 3 y `eventos_sistema`: 0). La rama temporal se elimino despues de la prueba y el snapshot manual quedo conservado sin vencimiento.

El proyecto sigue en el plan Free: tiene una ventana de restauracion de 6 horas, admite un snapshot manual y no permite programar snapshots. Antes de depender comercialmente de esta base, evaluar Launch para contar con hasta 7 dias y programacion de copias.

## Respuesta a incidentes

1. Confirmar el alcance desde `/api/health` y **Estado del sistema**.
2. Revisar los logs de Render alrededor de la hora del primer fallo.
3. Si afecta reservas o pagos, evitar cambios manuales hasta identificar la reserva y el estado informado por Mercado Pago.
4. Corregir o revertir el despliegue y volver a ejecutar las pruebas.
5. Verificar recuperacion con una reserva controlada.
6. Documentar causa, duracion, clientes afectados y accion preventiva.

## Variables de entorno

La referencia completa esta en `backend/.env.example`. En produccion son obligatorias `DATABASE_URL`, `JWT_SECRET`, `JWT_TENANT_SECRET`, `BASE_URL`, `FRONTEND_URL`, `ADMIN_EMAIL` y `ADMIN_PASSWORD`. Las integraciones solo deben habilitarse cuando sus credenciales esten completas.

Reglas:

- nunca subir `.env` ni credenciales al repositorio;
- usar secretos diferentes para JWT general y tenant;
- rotar credenciales ante cualquier exposicion;
- mantener `BASE_URL=https://tuagendate.com` y el callback de Google exactamente igual al autorizado;
- dejar `WHATSAPP_AUTOMATIONS_ENABLED=false` mientras WhatsApp no este habilitado comercialmente.

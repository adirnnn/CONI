# Handoff: estado actual y próxima sesión

**Actualizado:** 2026-10-03

## Estado del repositorio

- Ramas locales: `main` (documentación) y `feat/foundation` (código). Ver `git log --oneline`.
- Remoto: `origin` → `github.com/adirnnn/CONI` (privado, confirmado por el desarrollador). **Push pendiente:** el entorno del asistente no tiene permiso para publicar; el desarrollador debe ejecutar el push.

## Estado contractual

No adjudicado ni firmado. No hay D1. Todo el trabajo es precontractual (DEC-004).

## Completado y verificado

- Documentación base: brief, matriz de trazabilidad, riesgos y decisiones, ADR-001 (stack), ADR-002 (mayor y bitácora), `05-permisos.md`, cronograma, integraciones, fuentes con hash.
- **Incremento 1, núcleo del mayor:** migración `001_ledger_core.sql` y servicio `src/ledger/ledger.ts`.
- **Incremento 2, seguridad (M07):**
  - migración `002_security.sql`: usuarios, roles PROPUESTA, permisos, asignación por proyecto, sesiones, RLS, funciones privilegiadas
  - API Fastify `src/app.ts`: login, logout, cambio de contraseña, MFA TOTP, administración de usuarios, partidas (crear, aprobar, contabilizar, revertir), balance de comprobación, verificación de bitácora
  - script `create-admin`
- Verificado el 2026-10-03:
  - `npm run typecheck`: sin errores
  - `npm test`: 4/4 (shared) + 54/54 (api: 26 del mayor, 28 de seguridad y aislamiento)
  - Arranque real: `npm run migrate` aplicó 001 y 002 en la base de desarrollo; `/health` 200, `/projects` sin sesión 401, login sin encabezado CSRF 403
- **Incremento 3, interfaz web (`apps/web`):** React, Vite y Tailwind en español.
  - pantallas: inicio de sesión, cambio de contraseña obligatorio, configuración y verificación MFA (QR), lista de partidas con filtros, captura de partida GTQ con cuadre en vivo, detalle con acciones según permiso (aprobar, contabilizar, revertir), balance de comprobación
  - API ampliada: `GET /accounts`, `/periods`, `/journal-entries`
  - fechas `DATE` devueltas como texto `YYYY-MM-DD`, sin desplazamiento por zona horaria
- Verificación manual en navegador (2026-10-03, datos sintéticos):
  - inicio de sesión de `demo.contador`, MFA con QR, captura de partida de Q1,250.50 cuadrada, aprobación por `demo.gerente`, contabilización, balance de comprobación cuadrado
  - `demo.consulta` (DEMO-B): 404 en la partida de DEMO-A, lista vacía, 403 en reporte de DEMO-A
- **Incremento 4, configuración contable y multimoneda:**
  - migración `003_accounting_config.sql`: reglas del catálogo, cierre y reapertura de periodos con motivo, permisos `accounting.config`, `period.close` y `rates.manual`, monedas GTQ/USD, tasas por RLS, `app_setting` (redondeo PROPUESTA), `rate_sync_run`
  - integración BANGUAT verificada con el servicio real; script `rates:sync`
  - el servidor fija el periodo y valora las líneas; ya no los toma del cliente
  - pantallas web: Catálogo, Periodos, Tipo de cambio; captura multimoneda
  - verificado en navegador: tasas reales visibles; partida de US$250.00 valorada a 7.641360 = Q1,910.34
- Pruebas automatizadas: 4 (shared) + 78 (api: 26 mayor, 29 seguridad, 23 configuración/multimoneda) + 1 (web). Build web correcto.
- CI (`.github/workflows/ci.yml`) aún no ha corrido (sin push).

## Pendiente inmediato

- Límite de intentos por IP, protección contra reutilización de TOTP, recuperación de MFA por el administrador.
- Exportación diaria del hash de bitácora fuera del servidor.
- Decisiones de CONI: DEC-ROL (matriz de roles), DEC-VIS (visibilidad de cuentas institucionales).

## Comandos

```bash
npm install
docker compose up -d db
# desarrollo local: crear apps/api/.env (ver .env.example), luego:
npm run migrate -w @coni/api            # usa DATABASE_URL
ALLOW_SYNTHETIC_SEED=1 DEV_SEED_PASSWORD=... DATABASE_URL=... npm run seed:dev -w @coni/api   # solo datos sintéticos
npm run dev -w @coni/api                # API en :3000
npm run dev -w @coni/web                # web en :5180 (proxy /api)
npm run typecheck
npm test
# servidor local (variables en .env.example)
DATABASE_URL=... APP_ENCRYPTION_KEY=... COOKIE_SECURE=false npm run migrate
DATABASE_URL=... APP_ENCRYPTION_KEY=... COOKIE_SECURE=false npm run dev -w @coni/api
DATABASE_URL=... ADMIN_PASSWORD=... npm run create-admin -w @coni/api -- <usuario> "<Nombre>"
```

Variables: ver `.env.example`. Las pruebas recrean la base `coni_test`; se niegan a borrar una base cuyo nombre no termine en `_test`.

## Preguntas abiertas prioritarias

1. Cénit: opción de capacidad A/B/C (R-08), R-01 a R-07, arreglo del desarrollador y propiedad intelectual.
2. CONI: decisor autorizado, fecha de contrato, volúmenes, sistema actual, catálogo de cuentas.
3. Contador: reglas de contabilización, redondeo, cierre, depreciación, diferencial cambiario, distribución entre proyectos.
4. Planilla: estructuras salariales, planillas de muestra con resultado esperado, especificación IGSS.
5. CONI: certificador FEL, bancos y muestras de estados de cuenta.
6. Desarrollador: confirmar que el repositorio es privado; autorizar commit y push; instalar `gh`.

## Defectos conocidos

Ninguno. `npm audit` reporta avisos en dependencias de desarrollo; están sin revisar.

## Siguiente acción

1. Commit de documentación en `main`; rama `feat/foundation` con incrementos 1 y 2; push; PR. **Pendiente de autorización.**
2. Presupuestos por proyecto/renglón con techos y alertas de sobregiro (M01-BUD-001..003), con prueba de concurrencia.
3. Estados financieros: Balance General, Estado de Resultados y Ejecución Presupuestaria por proyecto y consolidados (M01-ACC-002).
4. Pruebas E2E con Playwright de los flujos críticos.

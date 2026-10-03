# Handoff: estado actual y próxima sesión

**Actualizado:** 2026-10-03

## Estado del repositorio

- Rama: `main` (renombrada desde `master`). **Sin commits todavía**: el commit y el push quedaron pendientes de autorización del desarrollador. Primero hay que confirmar que `github.com/adirnnn/CONI` es privado.
- Remoto: `origin` → `github.com/adirnnn/CONI` (`git ls-remote` no devolvió referencias; parece vacío).

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
- CI (`.github/workflows/ci.yml`) aún no ha corrido (sin push).

## Pendiente inmediato

- `apps/web`: shell React/Vite en español con login, MFA y partidas.
- Límite de intentos por IP, protección contra reutilización de TOTP, recuperación de MFA por el administrador.
- Exportación diaria del hash de bitácora fuera del servidor.
- Decisiones de CONI: DEC-ROL (matriz de roles), DEC-VIS (visibilidad de cuentas institucionales).

## Comandos

```bash
npm install
docker compose up -d db
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
2. Shell web (login, MFA, lista y captura de partidas, balance de comprobación).
3. Catálogo de cuentas configurable, periodos y tipos de cambio BANGUAT (tarea programada).

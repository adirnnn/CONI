# ADR-002: Invariantes del mayor y bitácora en la base de datos

- **Estado:** Aceptado (2026-10-03)
- **Requisitos:** M01-ACC-003, M01-CUR-001, M07-AUD-001, SG-001, SG-002

## Decisión

Las reglas contables críticas se aplican con **triggers y restricciones de PostgreSQL** (`apps/api/src/db/migrations/001_ledger_core.sql`). Así ninguna ruta de código (API, importación, tarea, consola) puede saltárselas.

| Regla | Mecanismo |
| --- | --- |
| Partida cuadrada (GTQ; y en moneda de transacción si es de una sola moneda), mínimo 2 líneas | `journal_entry_guard` al pasar a APPROVED/POSTED |
| Estados `DRAFT → APPROVED → POSTED → REVERSED`; regresar de APPROVED a DRAFT permitido | `journal_entry_guard` |
| Partida contabilizada inmutable; corrección solo por reversión | `journal_entry_guard`, `journal_line_guard` |
| Periodo cerrado rechaza registros; periodos sin traslape | trigger + restricción `EXCLUDE` |
| Creador no aprueba su partida | `journal_entry_guard` |
| Cuenta de mayor (no imputable) o inactiva rechazada; cuenta que exige proyecto | `journal_line_guard` |
| Línea en GTQ: tasa 1 e importes iguales; moneda extranjera: tasa BANGUAT o MANUAL | `journal_line_guard` |
| Tasa manual exige justificación y aprobador | `CHECK` en `exchange_rate` |
| Un asiento por documento origen y propósito; una reversión por partida | `UNIQUE` |
| Carrera entre agregar línea y aprobar | `SELECT … FOR SHARE` sobre la partida |
| Dinero sin flotantes | `numeric(18,2)` / `numeric(18,6)`; `decimal.js` en la aplicación |

## Bitácora

- `audit_event` es de solo inserción. Los triggers rechazan UPDATE, DELETE y TRUNCATE para **todos** los usuarios. El rol `coni_app` solo tiene `SELECT, INSERT`.
- Cadena de hash SHA-256: cada fila incluye el hash anterior. `audit_verify_chain()` devuelve la primera fila alterada.
- Las tablas contables registran automáticamente INSERT/UPDATE/DELETE con el usuario de `app.user_id`.
- **Limitación documentada:** un superusuario de PostgreSQL puede desactivar triggers y alterar filas. La cadena de hash lo **detecta** (prueba incluida), pero no lo impide. Mitigación pendiente: exportar diariamente el último hash fuera del servidor, restringir el acceso de superusuario al custodio técnico y revisar los accesos privilegiados.

## Concurrencia

- **Presupuesto:** la verificación al aprobar bloquea la fila del presupuesto (`FOR UPDATE`). Dos aprobaciones contra el mismo saldo se ejecutan en serie y la segunda ve lo consumido por la primera. Hay una prueba determinista que falla si se quita el bloqueo (verificado por mutación el 2026-10-05).
- **Bitácora:** la cadena de hash toma un bloqueo consultivo global (`pg_advisory_xact_lock`) en cada transacción que escribe en la bitácora. Todas las escrituras quedan en serie en ese punto. Es suficiente para el volumen esperado de CONI, pero es un límite de rendimiento. Si se necesitara más capacidad: cadenas por partición o sellado por lotes.
- **Suplantación:** en sesiones de la aplicación (`coni_app`), un trigger exige que `created_by`, `approved_by` y `posted_by` sean el usuario actuante, con el permiso correspondiente. Ni siquiera con SQL directo se puede registrar una aprobación a nombre de otra persona.

## Pendiente

- Política de redondeo (SUP-008): el código exige el modo de redondeo explícito; no hay valor por defecto.
- Diferencia de redondeo en partidas multimoneda: se requiere una línea de ajuste según la política del contador.
- Reapertura de periodos: la aprobación y bitácora están por definir con CONI.

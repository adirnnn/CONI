# Modelo de seguridad y permisos

**Requisitos:** M07-SEC-001, M07-SEC-002, M07-AUD-001, SG-004. **Implementación:** `apps/api/src/db/migrations/002_security.sql`, `apps/api/src/app.ts`, `apps/api/src/auth/`.

## Capas

1. **API (servidor).** Cada ruta exige sesión válida y el permiso correspondiente. Ocultar botones en la interfaz **no** es autorización.
2. **Base de datos (RLS).** Cada solicitud se ejecuta como el rol `coni_app` con `app.user_id` = usuario. Las políticas de PostgreSQL filtran proyectos, partidas y bitácora aunque la API tuviera un error. Hay pruebas que consultan la base directamente como usuario limitado.
3. **Funciones privilegiadas** (`SECURITY DEFINER`). Credenciales, alta y baja de usuarios y cambio de contraseña pasan por funciones que verifican el permiso. El rol de la aplicación **no puede leer** `password_hash` ni `totp_secret_enc`.

## Visibilidad por proyecto

- Una línea con proyecto es visible si el usuario está asignado a ese proyecto o tiene `all_projects`.
- Una línea **institucional** (sin proyecto) es visible con el permiso `ledger.institutional`.
- Una **partida** es visible solo si **todas** sus líneas son visibles. Un usuario del proyecto B no ve el encabezado (descripción, fechas, personas) de una partida del proyecto A.
- Aprobar, contabilizar o revertir exige ver la partida completa.
- Un proyecto no asignado devuelve 404 en solicitudes directas y 403 en reportes filtrados por ese proyecto.

**Decisión pendiente (DEC-VIS, CONI):** las líneas institucionales (por ejemplo, la cuenta bancaria compartida) revelan montos agregados de todos los proyectos a quien tenga `ledger.institutional`. Opciones: limitar ese permiso a contabilidad y dirección, o dividir las cuentas bancarias por proyecto o fondo.

## Permisos

| Código | Descripción | Privilegiado (exige MFA) |
| --- | --- | --- |
| `admin.users` | Usuarios, roles, asignaciones | Sí |
| `admin.projects` | Proyectos | Sí |
| `audit.read` | Consultar y verificar bitácora | No |
| `ledger.read` | Consultar partidas y reportes | No |
| `ledger.write` | Crear partidas en borrador | No |
| `ledger.approve` | Aprobar partidas | Sí |
| `ledger.post` | Contabilizar y revertir | Sí |
| `ledger.institutional` | Líneas sin proyecto | No |

## Roles propuestos (estado: PROPUESTA, pendientes de la matriz de roles de CONI)

| Rol | Permisos |
| --- | --- |
| ADMIN_SISTEMA | `admin.users`, `admin.projects`, `audit.read`. **No registra ni aprueba contabilidad** (segregación de funciones). |
| CONTADOR | `ledger.read`, `ledger.write`, `ledger.post`, `ledger.institutional` |
| GERENTE_FINANCIERO | `ledger.read`, `ledger.approve`, `ledger.institutional` |
| AUDITOR | `ledger.read`, `audit.read`, `ledger.institutional` |
| CONSULTA | `ledger.read` |

**Segregación de funciones** (aplicada en la base de datos): quien crea una partida no puede aprobarla.

## Autenticación (salvaguardas; valores ajustables por variables de entorno)

| Control | Valor por defecto |
| --- | --- |
| Hash de contraseña | argon2id |
| Longitud mínima de contraseña | 12 |
| Bloqueo | 5 fallos consecutivos → 15 min |
| Sesión | Cookie `httpOnly`, `SameSite=Strict`, `Secure` en producción. Token aleatorio de 256 bits; en la base solo se guarda su SHA-256 |
| Inactividad / duración máxima | 30 min / 12 h |
| MFA | TOTP obligatorio para roles con permisos privilegiados. El secreto se cifra con AES-256-GCM (`APP_ENCRYPTION_KEY`) |
| CSRF | Encabezado `x-coni-csrf: 1` obligatorio en solicitudes que modifican datos |
| Respuesta de error de inicio de sesión | Idéntica para usuario inexistente, contraseña incorrecta, bloqueo o usuario deshabilitado |

## Ciclo de vida de cuentas

- **Primer administrador:** script `create-admin` ejecutado por el custodio técnico con la contraseña en `ADMIN_PASSWORD` (variable de entorno, nunca en archivos). Debe cambiar la contraseña y configurar MFA al primer ingreso.
- **Alta:** el administrador crea el usuario con contraseña temporal. El cambio es obligatorio al primer ingreso.
- **Recuperación de acceso:** el administrador restablece la contraseña. Eso revoca todas las sesiones del usuario y obliga a cambiarla.
- **Recuperación de MFA:** por definir. Propuesta: el administrador elimina el segundo factor con justificación registrada en bitácora. Pendiente de implementar.
- **Baja:** se deshabilita, nunca se borra. Las sesiones se revocan de inmediato. Un usuario no puede renombrarse.
- **Revisión de accesos privilegiados:** la bitácora registra inicios de sesión, fallos, MFA y cambios de roles y asignaciones. Se propone una revisión mensual por el auditor.

## Limitaciones conocidas

- Un superusuario de PostgreSQL puede desactivar triggers y RLS. La cadena de hash de la bitácora detecta alteraciones, pero no las impide. El acceso de superusuario debe limitarse al custodio técnico.
- No hay protección contra la reutilización de un código TOTP dentro de su ventana de 30–90 s.
- No hay límite de intentos por dirección IP; solo el bloqueo por cuenta. Se agregará en el proxy (Caddy) o en la aplicación antes de producción.

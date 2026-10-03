# ADR-001: Plataforma y stack tecnológico

- **Estado:** Aceptado (2026-10-03)
- **Contexto:** La oferta de Cénit lista un stack "sugerido": React/TypeScript/Tailwind, Node.js REST/GraphQL, PostgreSQL/Supabase, OAuth 2.0/SSL/RLS. El repositorio está vacío. Se evaluó configurar una plataforma madura (ERPNext). Se decidió un desarrollo a la medida.

## Decisión

| Capa | Elección | Motivo |
| --- | --- | --- |
| Monorepo | npm workspaces: `apps/api`, `apps/web`, `packages/shared` | Un desarrollador; tipos compartidos; sin herramientas extra |
| API | Node 24 + Fastify + TypeScript, REST + OpenAPI | Simple y rápido; validación con esquemas |
| GraphQL | **No se usa** | No aporta a los requisitos; añade superficie y costo de mantenimiento |
| Base de datos | PostgreSQL 16 autoalojado | Transacciones, restricciones, triggers y RLS |
| Supabase | **No se usa** | Se autoaloja en el VPS comprometido; evita dependencia de un tercero |
| Acceso a datos | Kysely (SQL tipado) + migraciones SQL versionadas | Control explícito de SQL financiero |
| Tareas | pg-boss (sobre Postgres) | Sin Redis; idempotencia por clave |
| Dinero | `numeric(18,2)` montos / `numeric(18,6)` tasas; decimal.js en la aplicación | Sin punto flotante |
| Web | React + Vite + TypeScript + Tailwind | Coincide con la oferta |
| Autenticación | Sesiones en servidor con cookie httpOnly, argon2id, TOTP para privilegiados | Más simple y seguro que un proveedor OAuth para usuarios internos. OAuth 2.0 queda disponible si CONI exige SSO |
| Autorización | Servicio + RLS de Postgres por proyecto | Defensa en profundidad |
| Pruebas | Vitest; Postgres real en Docker para integración; Playwright E2E | Probar invariantes en la BD real |
| Despliegue | Docker Compose + Caddy (TLS) en VPS | Reproducible, bajo costo |

## Consecuencias

- Todo el dominio contable se construye a la medida. Esfuerzo estimado: ~101 días-desarrollador (ver R-08).
- Las invariantes financieras se aplican en la base de datos (triggers y restricciones) además de en la aplicación.
- Se debe informar a CONI que GraphQL y Supabase no se usan. Ambos estaban "sugeridos", no comprometidos.

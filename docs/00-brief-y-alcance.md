# Brief del proyecto y línea base de alcance

**Cliente:** Asociación CONI, Cobán, Alta Verapaz.
**Proveedor:** Cénit Capital, S.A. (oferta del 2026-09-29).
**Estado contractual (2026-10-03):** no adjudicado ni firmado.

## Objetivo

Software integrado de contabilidad, presupuestos y compras multiproyecto, adaptado a Guatemala, para gestionar los fondos recibidos y ejecutados por proyecto (TDR §2).

## Alcance base: 8 módulos (TDR §3; matriz de evaluación §7)

1. Contabilidad general, presupuestos y multimoneda
2. Cuentas por pagar, compras y flujos de aprobación
3. Activos fijos
4. Inventarios y suministros (Kardex)
5. Cuentas por cobrar y donaciones (+ CRM de donantes, compromiso de Cénit)
6. Bancos y tesorería
7. Seguridad, usuarios y auditoría
8. RR. HH., nómina y planillas

## Entregables contractuales (TDR §8)

a) Plan de trabajo e implementación · b) Sistema en producción parametrizado con saldos iniciales · c) Manuales de usuario y técnico · d) Talleres de capacitación · e) Contrato de soporte y garantía (mínimo 12 meses).

## Compromisos adicionales de Cénit

CRM de donantes; 59 días desde la firma; hosting, mantenimiento, respaldos y soporte/monitoreo 24/7 por 3 años sin costo; plan de 12 etapas con ambientes DEV/QA/producción y acta UAT. Detalle: `01-matriz-trazabilidad.csv` (tipo CENIT).

## Fuera de alcance salvo aprobación

- Iniciar transferencias bancarias reales: los pagos se registran, no se ejecutan.
- Emitir documentos con efecto legal (recibos de donación) sin el certificador FEL contratado por CONI.
- Multitenencia o SaaS comercial.
- Cualquier mejora clasificada como MEJORA en la matriz.

## Clasificación de requisitos

`CLIENTE` (TDR) · `CENIT` (oferta de Cénit) · `SALVAGUARDA` (ingeniería necesaria) · `MEJORA` (requiere aprobación) · `SUPUESTO` (sin resolver).

## Definición de terminado (proyecto)

Ver el prompt de proyecto, §13. Resumen: 8 módulos integrados, cuadre de saldos y reportes, aislamiento por proyecto probado, integraciones verificadas, reglas de nómina y contables aprobadas, migración aceptada, producción reproducible, restauración demostrada, capacitación y manuales entregados, UAT y acta de recepción firmadas, traspaso de código y accesos.

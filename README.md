# spy-ohlc
Spy hourly OHLC dashboard

## Pruebas locales

Requisitos: Node.js 24 y npm. Desde la raíz del repositorio:

```sh
npm ci
npm test
```

Las pruebas unitarias usan `node:test` y SQLite en memoria (`node:sqlite`).
Las de integración añaden Miniflare como dependencia de desarrollo e invocan
el Worker en workerd con D1 local desechable. El esquema de preview incluido
en las pruebas es un fixture. El proveedor Twelve Data y el reloj de la
captura programada se simulan para que las pruebas puedan ejecutarse sin
credenciales ni acceso a servicios remotos después de instalar las dependencias.

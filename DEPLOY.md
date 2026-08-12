# Deploy Online Privado

Objetivo: tener una URL fija para usar el CRM desde Mac, iPhone o cualquier navegador sin depender del servidor local.

## Opción recomendada: Render

El proyecto incluye `render.yaml` para crear:

- servicio web Node.js
- disco persistente de 1 GB en `/var/data`
- healthcheck en `/api/ping`
- variables privadas para usuario, contraseña y WhatsApp API

## Variables obligatorias

Configurá estas variables en el hosting:

```text
CRM_ADMIN_USER=tu_usuario
CRM_ADMIN_PASSWORD=tu_clave_segura
CRM_PUBLIC_URL=https://tu-crm.onrender.com
CRM_DATA_DIR=/var/data
NODE_ENV=production
ALLOW_RECOVERY_LOGIN=false
```

Opcionales para WhatsApp API:

```text
WHATSAPP_ACCESS_TOKEN=token_de_meta
WHATSAPP_PHONE_NUMBER_ID=id_del_numero
WHATSAPP_GRAPH_VERSION=v20.0
```

## Primer uso

1. Entrá a la URL online.
2. Iniciá sesión con `CRM_ADMIN_USER` y `CRM_ADMIN_PASSWORD`.
3. Si tenés datos en la Mac, entrá desde la Mac y usá `Taller > Exportar backup`.
4. En la URL online, usá `Taller > Importar backup`.
5. Desde ese momento, Mac y celular usan la misma base central.

## Uso desde iPhone sin la Mac

Para que funcione con la Mac apagada, el iPhone tiene que abrir la URL online de Render, por ejemplo:

```text
https://tu-crm.onrender.com
```

No uses estas direcciones para el iPhone si querés independencia de la Mac:

```text
http://127.0.0.1:5173
http://192.168.x.x:5173
http://MacBook.local:5173
```

Esas direcciones dependen de la Mac o apuntan al propio iPhone.

Cuando la URL online abra bien en Safari, podés tocar Compartir > Agregar a pantalla de inicio para que se vea como app.

## Importante

- No subas `.env`, `data/` ni `logs/`.
- El hosting tiene que mantener un disco persistente para no perder datos.
- En producción no dejes activa la recuperación `admin / 1234`.
- Si más adelante querés varios usuarios o reportes avanzados, conviene migrar de JSON persistente a Postgres.

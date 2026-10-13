# Antena

Plugin de [Kino](https://github.com/kinotvapp/kino-plugins): tu TV en vivo desde cualquier servidor
**Xtream Codes** (el que te da tu proveedor de IPTV: dirección, usuario y contraseña).

- Canales por categoría en la pestaña **En vivo**, con búsqueda y marca +18 en las categorías de adultos.
- Filas de canales en **Inicio**.
- Guía de programación (EPG) cuando el servidor la ofrece.
- Formato HLS (m3u8) o MPEG-TS a elección, por si un canal no abre.
- Texto en español e inglés.

## Instalar

En Kino: **Ajustes ▸ Plugins ▸ Instalar** y escribe `xuper-plugin/kino-plugin-antena`.

Después abre los ajustes del plugin y escribe:

| Campo | Ejemplo |
|---|---|
| URL del servidor | `http://miservidor.com:8880` |
| Usuario | tu usuario |
| Contraseña | tu contraseña (se guarda cifrada en el aparato) |

Pulsa **Verificar conexión**: muestra cuándo vence la cuenta y cuántas conexiones usas.

## Qué aprueba la persona al instalar

- Usa tu usuario y contraseña.
- Se conecta solo al servidor que escribas.
- Puede reproducir canales desde los servidores que indique la lista del proveedor (en rojo): muchos
  paneles Xtream reparten el video desde nodos distintos al de la API.

Antena no incluye ningún servidor ni cuenta: solo habla con el que tú configures.

## Desarrollo

```
node sdk/validate.mjs .
```

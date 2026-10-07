# Servidor del mapa (tu laptop + ZeroTier)

Un servidor pequeño, en Python 3 sin dependencias, que hace dos cosas:

1. **Sirve la web** (la misma carpeta `prague-rent-map/`).
2. **Guarda los anuncios** como archivos JSON en el disco de la laptop, para que el móvil, el PC y cualquier dispositivo de tu red ZeroTier vean la misma lista.

La web sigue guardando una copia en cada navegador. Si el servidor no está (o se cae la conexión), todo funciona igual y se sincroniza al volver. Si abres la web desde otro sitio, por ejemplo GitHub Pages, no hay servidor: la app se queda local, como siempre.

> **No tiene contraseña, a propósito.** Los anuncios llevan teléfonos y capturas de terceros. Lo que lo protege es que **solo escucha en la IP de ZeroTier** y solo la alcanzan los dispositivos autorizados en tu red. No lo expongas a internet ni a tu Wi-Fi sin añadirle login y HTTPS.

## Requisitos
Python 3.10 o superior y `git` (Ubuntu 22.04 los trae). No hace falta Node ni Docker.

## Instalar (una vez)

```sh
cd ~
git clone --depth 1 --filter=blob:none --sparse https://github.com/Gruzver/Portfolio rent-map-app
cd rent-map-app
git sparse-checkout set prague-rent-map      # solo baja esta carpeta (~15 MB), no los 199 MB del portafolio
chmod +x prague-rent-map/server/run.sh
mkdir -p ~/rent-map-data
```

## Probarlo a mano

```sh
~/rent-map-app/prague-rent-map/server/run.sh
```

Debe imprimir `serving ... on http://<IP-ZeroTier>:8789/`. Desde un dispositivo conectado a tu red ZeroTier abre esa dirección. Para parar: `Ctrl+C`.

Para comprobar que **no** escucha en todas las interfaces:

```sh
ss -ltnp | grep 8789        # debe salir la IP de ZeroTier, nunca 0.0.0.0 ni *
curl http://<IP-ZeroTier>:8789/api/ping
```

## Que arranque solo al encender (cron `@reboot`)

`crontab -e` y añade:

```
@reboot $HOME/rent-map-app/prague-rent-map/server/run.sh >> $HOME/rent-map-data/server.log 2>&1
```

`run.sh` espera hasta ~5 minutos a que ZeroTier tenga interfaz (cron arranca antes), resuelve la IP en cada arranque, y **se niega a arrancar** si no la encuentra: nunca cae a `0.0.0.0`.

Variables opcionales: `RENTMAP_PORT` (por defecto 8789), `RENTMAP_DATA` (por defecto `~/rent-map-data`), `RENTMAP_BIND` (IP fija, solo para pruebas).

## Actualizar a una versión nueva

```sh
cd ~/rent-map-app && git pull
pkill -f 'prague-rent-map/server/server.py'
nohup ./prague-rent-map/server/run.sh >> ~/rent-map-data/server.log 2>&1 &
```

(o simplemente reinicia la laptop). Los navegadores recogen la web nueva al recargar.

## Dónde están tus datos

```
~/rent-map-data/
  listings/<id>.json     un archivo por anuncio (con sus fotos)
  deleted/<id>.json      marcas de borrado, para que un borrado llegue a todos los dispositivos
  backups/AAAA-MM-DD/    copia diaria automática; guarda los últimos 14 días
  server.log             solo escrituras y errores
```

Para restaurar una copia, para el servidor, copia el contenido de `backups/<fecha>/listings` y `deleted` sobre `listings/` y `deleted/`, y vuelve a arrancarlo. Las copias diarias están en el mismo disco: si te importa de verdad, copia `~/rent-map-data` de vez en cuando a otro sitio. El botón **«Exportar copia»** de la web sigue ahí.

## Pasar lo que ya tienes al servidor

Cada dirección web es un "sitio" distinto para el navegador, así que lo guardado en la versión de GitHub Pages no se mueve solo:

1. En la versión de GitHub Pages: **Exportar copia**.
2. En la versión del servidor: **Importar copia**. Se sube al servidor.
3. Los demás dispositivos lo reciben solos al abrir la web del servidor.

## Cómo se sincroniza

- Cada anuncio se reconcilia por separado: **gana el cambio más reciente** (por la fecha de edición). Un borrado más reciente que una edición gana; una edición posterior a un borrado lo revive.
- Se sincroniza al abrir, tras cada cambio, cada 30 segundos con la pestaña visible, al volver a la pestaña y al recuperar la conexión.
- Usa la hora de cada dispositivo. Si dos dispositivos tuvieran el reloj muy desfasado y editaras el mismo anuncio en ambos casi a la vez, podría ganar el equivocado. Para una sola persona es un riesgo pequeño.
- Si importas un anuncio que habías borrado antes en ese dispositivo, se entiende como "tráelo de vuelta".

## Seguridad: qué hace y qué no

- Solo escucha en la IP que le das; con `0.0.0.0` se niega salvo `--allow-any-interface`.
- Solo responde a peticiones cuyo `Host` sea el esperado (la IP, `localhost`): protege contra el ataque de "DNS rebinding". Si algún día entras por un nombre DNS, añade `--allow-host nombre:8789` a la línea de `run.sh`.
- Los identificadores de anuncio se validan (`A-Z a-z 0-9 _ -`): no hay recorrido de directorios. El directorio de datos no puede estar dentro de la carpeta web.
- Límite de 40 MB por anuncio (`--max-body-mb`).
- **No tiene** autenticación, cifrado (HTTP, el navegador mostrará "No seguro") ni registro de quién accede. Cualquier miembro autorizado de tu red ZeroTier puede leer, editar y borrar.

## Problemas típicos

| Síntoma | Qué mirar |
| --- | --- |
| La web dice «Sin conexión con el servidor» | ¿ZeroTier conectado en ese dispositivo? ¿La laptop encendida? `curl http://<IP>:8789/api/ping` desde otra máquina de la red. Los cambios se guardan en el dispositivo y se envían al volver. |
| No arranca tras reiniciar | Mira `~/rent-map-data/server.log`. Si dice que no encontró interfaz ZeroTier, comprueba `systemctl status zerotier-one` y `ip -4 -brief addr`. |
| Cambió la IP de ZeroTier | Nada: se resuelve en cada arranque. Solo hay que usar la IP nueva en el navegador. |
| El puerto está ocupado | Cambia `RENTMAP_PORT` (8787 y 8788 los usan otros servicios tuyos). |

## Pruebas

```sh
python3 -m unittest discover -s server -v
```

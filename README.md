# ElderGuard

App Android nativa para control de seguridad de personas mayores.

## Qué incluye esta primera versión

- Servicio en primer plano con notificación persistente.
- Detección heurística de caídas con acelerómetro y giroscopio:
  - caída libre,
  - impacto,
  - reposo posterior.
- Monitor de inactividad prolongada con confirmación de bienestar.
- Zona segura por ubicación GPS con radio configurable en código.
- Botón SOS en la app.
- Acción SOS desde la notificación persistente.
- Tile rápido de Android para lanzar SOS desde Ajustes rápidos.
- Activación por voz mientras la app está abierta usando reconocimiento del sistema.
- Menús sencillos: Inicio, Contactos y Seguridad.
- Contactos múltiples con nombre, email y teléfono.
- Envío automático de alerta por email a todos los contactos mediante backend propio.

## Abrir y compilar

1. Abre esta carpeta con Android Studio.
2. Deja que Android Studio sincronice Gradle y descargue el Android Gradle Plugin.
3. Conecta un móvil físico. Los emuladores no sirven bien para validar caídas, pasos, SMS o ubicación real.
4. Ejecuta `app`.

Para esta entrega he descargado herramientas portátiles en `tools/` y he compilado el APK localmente.

APK generado:

- `ElderGuard-debug.apk`

Es un APK debug firmado automáticamente para pruebas. Android puede mostrar un aviso de instalación desde origen desconocido.

## Permisos importantes

La app declara:

- `ACCESS_FINE_LOCATION`
- `ACCESS_BACKGROUND_LOCATION`
- `ACTIVITY_RECOGNITION`
- `POST_NOTIFICATIONS`
- `RECORD_AUDIO`
- `FOREGROUND_SERVICE`
- `FOREGROUND_SERVICE_LOCATION`
- `INTERNET`

Google Play revisa con dureza ubicación en segundo plano, llamadas y micrófono. Para publicarla habrá que preparar textos de consentimiento, política de privacidad, pantalla de explicación previa y justificación de seguridad personal.

## Limitaciones reales de Android

- Una app normal no puede capturar de forma fiable cinco pulsaciones del botón de encendido. Android reserva gestos de encendido para funciones del sistema y emergencias del fabricante.
- La alternativa implementada es un tile rápido SOS, un botón en notificación persistente y detección de pulsación prolongada/repetida de volumen mientras la app está abierta.
- La detección de voz continua en segundo plano consume mucha batería y puede chocar con políticas de privacidad. Esta versión usa reconocimiento de voz solo bajo demanda.
- Las marcas con ahorro agresivo de batería pueden pausar servicios. En producción conviene mostrar una guía específica para Samsung, Xiaomi, Oppo y Huawei.
- Para que los emails salgan automaticamente hay que configurar el backend de alertas. El usuario final no debe configurar SMTP ni contrasenas de Gmail.

## Backend de alertas

He añadido un backend en `backend/` para que la app envie alertas a un servidor y el servidor mande emails con Resend.

Ventajas frente a SMTP en la app:

- Los usuarios solo anaden contactos.
- No se guardan contrasenas de Gmail en el movil.
- El envio es auditable desde servidor.
- Permite ampliar despues a SMS, llamadas automaticas, WhatsApp o panel familiar.

Para pruebas locales:

1. Configura `backend/.env` a partir de `backend/.env.example`.
2. Ejecuta `npm start` dentro de `backend/`.
3. En emulador Android usa `http://10.0.2.2:8787`.
4. En movil fisico usa la IP local del ordenador, por ejemplo `http://192.168.1.50:8787`.

En produccion usa HTTPS y deja URL/clave preconfiguradas en el APK.

## Modelo premium sugerido

- Gratis:
  - botón SOS,
  - zona segura básica,
  - contacto de emergencia.
- Premium:
  - detección automática de caídas,
  - historial de ubicaciones 30 días,
  - alertas por email y push ilimitadas,
  - llamada automática mediante backend,
  - panel familiar web,
  - soporte multiusuario.

## Siguiente paso técnico

Para convertir esto en producto comercial haría falta añadir:

- TensorFlow Lite con modelo entrenado para reducir falsos positivos.
- Backend para cuentas, familiares, historial y llamadas automáticas.
- Google Play Billing para suscripciones.
- Firebase Cloud Messaging para alertas push.
- Pruebas de campo con usuarios reales y calibración por dispositivo.

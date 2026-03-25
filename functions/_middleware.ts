/**
 * Waiting Room Middleware for Cloudflare Pages (KV-based)
 *
 * Controla el acceso a la aplicación limitando usuarios concurrentes.
 * Los usuarios que exceden el límite ven una página de espera.
 *
 * MEJORA: El contador se recalcula basándose en sesiones reales,
 * evitando desincronización cuando las sesiones expiran por TTL.
 */

interface Env {
  WAITING_ROOM: KVNamespace;
}

interface WaitingRoomConfig {
  maxActiveUsers: number;
  sessionDurationSeconds: number;
  cookieName: string;
}

// Valores por defecto (se sobreescriben con KV)
const DEFAULT_CONFIG: WaitingRoomConfig = {
  maxActiveUsers: 100,
  sessionDurationSeconds: 180,
  cookieName: 'wr_session',
};

/**
 * Cache de configuración en memoria.
 * Reduce llamadas a KV cacheando por 30 segundos.
 */
let configCache: { config: WaitingRoomConfig; timestamp: number } | null = null;
const CONFIG_CACHE_TTL_MS = 30000; // 30 segundos

/**
 * Obtiene configuración desde KV con cache en memoria.
 * Keys en KV:
 *   - config:maxActiveUsers (número)
 *   - config:sessionDurationSeconds (número)
 */
async function getConfig(kv: KVNamespace): Promise<WaitingRoomConfig> {
  const now = Date.now();

  // Usar cache si es válido
  if (configCache && now - configCache.timestamp < CONFIG_CACHE_TTL_MS) {
    return configCache.config;
  }

  // Cargar desde KV
  const [maxUsers, sessionDuration] = await Promise.all([
    kv.get('config:maxActiveUsers'),
    kv.get('config:sessionDurationSeconds'),
  ]);

  const config: WaitingRoomConfig = {
    maxActiveUsers: maxUsers ? parseInt(maxUsers, 10) : DEFAULT_CONFIG.maxActiveUsers,
    sessionDurationSeconds: sessionDuration
      ? parseInt(sessionDuration, 10)
      : DEFAULT_CONFIG.sessionDurationSeconds,
    cookieName: DEFAULT_CONFIG.cookieName,
  };

  // Guardar en cache
  configCache = { config, timestamp: now };

  return config;
}

const BYPASS_PATTERNS = [
  /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|webp)$/i,
  /^\/assets\//,
  /^\/favicon/,
  /^\/_/,
];

function shouldBypass(pathname: string): boolean {
  return BYPASS_PATTERNS.some((pattern) => pattern.test(pathname));
}

function generateSessionId(): string {
  return crypto.randomUUID();
}

function getSessionFromCookie(request: Request, config: WaitingRoomConfig): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${config.cookieName}=([^;]+)`));
  return match ? match[1] : null;
}

function createSessionCookie(sessionId: string, config: WaitingRoomConfig): string {
  return `${config.cookieName}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${config.sessionDurationSeconds}`;
}

/**
 * Cuenta sesiones activas reales usando KV list.
 * Esto evita desincronización del contador.
 */
async function getRealActiveCount(kv: KVNamespace): Promise<number> {
  const sessions = await kv.list({ prefix: 'session:' });
  return sessions.keys.length;
}

async function isSessionActive(kv: KVNamespace, sessionId: string): Promise<boolean> {
  const session = await kv.get(`session:${sessionId}`);
  return session !== null;
}


async function refreshSession(
  kv: KVNamespace,
  sessionId: string,
  config: WaitingRoomConfig
): Promise<void> {
  await kv.put(`session:${sessionId}`, Date.now().toString(), {
    expirationTtl: config.sessionDurationSeconds,
  });
}

async function createNewSession(
  kv: KVNamespace,
  sessionId: string,
  config: WaitingRoomConfig
): Promise<boolean> {
  const currentCount = await getRealActiveCount(kv);

  if (currentCount >= config.maxActiveUsers) {
    return false;
  }

  await kv.put(`session:${sessionId}`, Date.now().toString(), {
    expirationTtl: config.sessionDurationSeconds,
  });

  return true;
}

function getWaitingRoomHTML(
  position: number,
  activeUsers: number,
  config: WaitingRoomConfig
): string {
  const estimatedWait = Math.max(1, Math.ceil(position * 0.5));
  return `

  <!DOCTYPE html>
  <html lang="es">
  <head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="5">
  <title>Sala de Espera - Turnos Procesionales</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: url('./bg-hermandad.jpg') no-repeat center center fixed;
      background-size: cover;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      position: relative;
    }
    body::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 0;
    }
    .container {
      position: relative;
      z-index: 1;
    }
    .container { text-align: center; padding: 2rem; max-width: 500px; }
    .icon { font-size: 4rem; margin-bottom: 1.5rem; animation: pulse 2s infinite; }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.7; transform: scale(1.05); }
    }
    h1 { font-size: 1.8rem; margin-bottom: 1rem; color: #b35690; }
    p { font-size: 1.1rem; line-height: 1.6; margin-bottom: 1.5rem; color: #e3c8dd; }
    .status-box {
      background: rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 1.5rem;
      margin: 1.5rem 0;
    }
    .status-item {
      display: flex;
      justify-content: space-between;
      padding: 0.5rem 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .status-item:last-child { border-bottom: none; }
    .status-label { color: #d296e2; }
    .status-value { color: #fff; font-weight: bold; }
    .loader {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 1s linear infinite;
      margin-left: 0.5rem;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .refresh-note { font-size: 0.9rem; color: #d319e3; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">⏳</div>
    <h1>Sala de Espera</h1>
    <p>
      Hay muchas personas accediendo al sistema en este momento.
      Por favor espera, serás redirigido automáticamente cuando haya disponibilidad.
    </p>
    <div class="status-box">
      <div class="status-item">
        <span class="status-label">Posición en cola</span>
        <span class="status-value">~${position}</span>
      </div>

      <div class="status-item">
        <span class="status-label">Tiempo estimado</span>
        <span class="status-value">~${estimatedWait} min</span>
      </div>
      <div class="status-item">
        <span class="status-label">En Cola</span>
        <span class="status-value">Validando el acceso… <span class="loader"></span></span>
      </div>
    </div>
    <p class="refresh-note">
       Si cierras la pestaña, podrías perder tu turno.
    </p>
  </div>
</body>
</html>
`;
}

function getSoldOutHTML(): string {
  return `

  <!DOCTYPE html>
  <html lang="es">
  <head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="5">
  <title>Ya no disponible - Turnos Procesionales</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: url('./bg-hermandad.jpg') no-repeat center center fixed;
      background-size: cover;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      position: relative;
    }
    body::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 0;
    }
    .container {
      position: relative;
      z-index: 1;
    }
    .container { text-align: center; padding: 2rem; max-width: 500px; }
    .icon { font-size: 4rem; margin-bottom: 1.5rem; animation: pulse 2s infinite; }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.7; transform: scale(1.05); }
    }
    h1 { font-size: 1.8rem; margin-bottom: 1rem; color: #b35690; }
    p { font-size: 1.1rem; line-height: 1.6; margin-bottom: 1.5rem; color: #e3c8dd; }
    .status-box {
      background: rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 1.5rem;
      margin: 1.5rem 0;
    }
    .status-item {
      display: flex;
      justify-content: space-between;
      padding: 0.5rem 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .status-item:last-child { border-bottom: none; }
    .status-label { color: #d296e2; }
    .status-value { color: #fff; font-weight: bold; }
    .loader {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 1s linear infinite;
      margin-left: 0.5rem;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .refresh-note { font-size: 0.9rem; color: #d319e3; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Ya no disponible</h1>
    <p>
      Nos complace informarle que se ha agotado el número de turnos disponibles.
      Gracias por su paciencia.
    </p>

    </div>
  </body>
</html>
`;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Bypass para assets estáticos
  if (shouldBypass(url.pathname)) {
    return next();
  }

  // DEBUG: Verificar que la function se ejecuta
  const addDebugHeader = (response: Response, status: string) => {
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('X-Waiting-Room', status);
    return newResponse;
  };

  // Si KV no está configurado, dejar pasar con header de debug
  if (!env.WAITING_ROOM) {
    const response = await next();
    return addDebugHeader(response, 'no-kv-binding');
  }

  // validar si es sold oout
  const isSoldOut = await env.WAITING_ROOM.get('soldOut');
  if (isSoldOut === 'true') {
    return new Response(getSoldOutHTML(), {
      status: 200,
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Retry-After': '5',
        'Cache-Control': 'no-store',
      },
    });
  }

  try {
    // Verificar si el waiting room está habilitado
    const isEnabled = await env.WAITING_ROOM.get('enabled');
    if (isEnabled !== 'true') {
      const response = await next();
      return addDebugHeader(response, 'disabled');
    }
  } catch (error) {
    // Si hay error leyendo KV, dejar pasar
    const response = await next();
    return addDebugHeader(response, 'kv-error');
  }

  // Cargar configuración dinámica desde KV
  const config = await getConfig(env.WAITING_ROOM);

  const existingSession = getSessionFromCookie(request, config);

  // Si ya tiene sesión activa, renovar y dejar pasar
  if (existingSession) {
    const isActive = await isSessionActive(env.WAITING_ROOM, existingSession);
    if (isActive) {
      await refreshSession(env.WAITING_ROOM, existingSession, config);
      return next();
    }
  }

  // Intentar crear nueva sesión
  const newSessionId = generateSessionId();
  const sessionCreated = await createNewSession(env.WAITING_ROOM, newSessionId, config);

  if (sessionCreated) {
    const response = await next();
    const newResponse = new Response(response.body, response);
    newResponse.headers.append('Set-Cookie', createSessionCookie(newSessionId, config));
    return newResponse;
  }

  // No hay cupo, mostrar waiting room
  const activeCount = await getRealActiveCount(env.WAITING_ROOM);
  const queuePosition = Math.max(1, activeCount - config.maxActiveUsers + 1);

  return new Response(getWaitingRoomHTML(queuePosition, activeCount, config), {
    status: 503,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Retry-After': '5',
      'Cache-Control': 'no-store',
    },
  });
};

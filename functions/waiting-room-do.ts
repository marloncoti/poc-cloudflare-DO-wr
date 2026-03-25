/**
 * WaitingRoomDO — Durable Object para control atómico de sesiones
 *
 * Resuelve el race condition del enfoque KV: al ser una única instancia
 * global, los requests se procesan de forma serializada. La operación
 * "leer contador → comparar → escribir sesión" es atómica por diseño.
 *
 * Responsabilidades:
 *   - Mantener sesiones activas en memoria (Map<sessionId, expiryMs>)
 *   - Admitir o rechazar nuevos usuarios sin race condition
 *   - Refrescar TTL de sesiones existentes
 *   - Limpiar sesiones expiradas (lazy cleanup en cada operación)
 *   - Persistir sesiones en DO Storage para sobrevivir cold starts
 *
 * Endpoints internos (llamados solo desde el middleware):
 *   POST /try-enter  → intenta admitir un usuario nuevo
 *   POST /refresh    → renueva TTL de una sesión existente
 *   GET  /count      → retorna el conteo actual de activos
 */

export interface TryEnterBody {
  sessionId: string;
  maxActiveUsers: number;
  sessionDurationSeconds: number;
}

export interface RefreshBody {
  sessionId: string;
  sessionDurationSeconds: number;
}

export interface TryEnterResponse {
  allowed: boolean;
  activeCount: number;
  position: number; // 0 si fue admitido, >0 si está en cola
}

export interface RefreshResponse {
  ok: boolean; // false si la sesión ya no existe en el DO (expiró)
}

export interface CountResponse {
  activeCount: number;
}

export class WaitingRoomDO implements DurableObject {
  /**
   * Estado en memoria: sessionId → timestamp de expiración (ms epoch).
   * Este Map es la fuente de verdad para el conteo activo.
   */
  private sessions: Map<string, number> = new Map();

  /**
   * Flag para cargar el estado desde DO Storage solo una vez
   * por ciclo de vida de la instancia (cold start recovery).
   */
  private initialized = false;

  constructor(private readonly state: DurableObjectState) {}

  // ---------------------------------------------------------------------------
  // Entry point — Cloudflare enruta aquí todos los fetch() al DO
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    // Cold start: reconstruir estado desde DO Storage
    if (!this.initialized) {
      await this.loadFromStorage();
      this.initialized = true;
    }

    // Limpiar sesiones expiradas antes de cada operación (lazy cleanup)
    await this.cleanExpired();

    const url = new URL(request.url);

    switch (url.pathname) {
      case '/try-enter':
        return this.handleTryEnter(request);
      case '/refresh':
        return this.handleRefresh(request);
      case '/count':
        return this.handleCount();
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  /**
   * Intenta admitir un usuario nuevo de forma atómica.
   * Si hay cupo: registra la sesión y retorna allowed=true.
   * Si no hay cupo: retorna allowed=false con la posición estimada en cola.
   */
  private async handleTryEnter(request: Request): Promise<Response> {
    const body = await request.json<TryEnterBody>();
    const { sessionId, maxActiveUsers, sessionDurationSeconds } = body;

    const activeCount = this.sessions.size;

    if (activeCount >= maxActiveUsers) {
      return Response.json({
        allowed: false,
        activeCount,
        position: activeCount - maxActiveUsers + 1,
      } satisfies TryEnterResponse);
    }

    // Hay cupo: registrar sesión en memoria y en storage
    const expiry = Date.now() + sessionDurationSeconds * 1000;
    this.sessions.set(sessionId, expiry);
    await this.state.storage.put(`session:${sessionId}`, expiry);

    return Response.json({
      allowed: true,
      activeCount: this.sessions.size,
      position: 0,
    } satisfies TryEnterResponse);
  }

  /**
   * Renueva el TTL de una sesión existente.
   * Retorna ok=false si la sesión no existe (puede haber expirado
   * entre requests). El middleware debe tratar este caso como un
   * usuario nuevo que necesita re-entrar a la cola.
   */
  private async handleRefresh(request: Request): Promise<Response> {
    const body = await request.json<RefreshBody>();
    const { sessionId, sessionDurationSeconds } = body;

    if (!this.sessions.has(sessionId)) {
      return Response.json({ ok: false } satisfies RefreshResponse);
    }

    const expiry = Date.now() + sessionDurationSeconds * 1000;
    this.sessions.set(sessionId, expiry);
    await this.state.storage.put(`session:${sessionId}`, expiry);

    return Response.json({ ok: true } satisfies RefreshResponse);
  }

  /**
   * Retorna el conteo de sesiones activas en este momento.
   * Útil para mostrar estadísticas en la página de espera.
   */
  private handleCount(): Response {
    return Response.json({ activeCount: this.sessions.size } satisfies CountResponse);
  }

  // ---------------------------------------------------------------------------
  // Gestión del ciclo de vida de sesiones
  // ---------------------------------------------------------------------------

  /**
   * Carga sesiones desde DO Storage al iniciar (cold start).
   * Filtra inmediatamente las que ya expiraron durante el downtime.
   */
  private async loadFromStorage(): Promise<void> {
    const now = Date.now();
    const stored = await this.state.storage.list<number>({ prefix: 'session:' });
    const expiredKeys: string[] = [];

    for (const [key, expiry] of stored) {
      const sessionId = key.slice('session:'.length);
      if (now < expiry) {
        this.sessions.set(sessionId, expiry);
      } else {
        expiredKeys.push(key);
      }
    }

    // Limpiar del storage las sesiones que vencieron durante el downtime
    if (expiredKeys.length > 0) {
      await this.state.storage.delete(expiredKeys);
    }
  }

  /**
   * Elimina sesiones expiradas del Map en memoria y del DO Storage.
   * Se ejecuta antes de cada operación para que el conteo siempre
   * refleje usuarios genuinamente activos.
   */
  private async cleanExpired(): Promise<void> {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [sessionId, expiry] of this.sessions) {
      if (now >= expiry) {
        this.sessions.delete(sessionId);
        expiredKeys.push(`session:${sessionId}`);
      }
    }

    if (expiredKeys.length > 0) {
      await this.state.storage.delete(expiredKeys);
    }
  }
}

import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { CompanyKnowledge, EmployeePersona } from "./company-domain.js";

const SALT = "sme-orgforge-salt";
export const SESSION_COOKIE_NAME = "sme_session";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface SessionPayload {
  employeeId: string;
  exp: number;
}

export interface SessionConfig {
  secret: string;
  cookieName?: string;
  maxAgeSeconds?: number;
}

let activeSecret: string | null = null;

export function configureAuth(config: SessionConfig): void {
  activeSecret = config.secret;
}

export function validateAuthConfig(env: Record<string, string | undefined>): SessionConfig {
  const secret = env.SESSION_SECRET || env.AUTH_SECRET;
  if (!secret || secret.trim().length < 32) {
    throw new Error("Invalid session secret: SESSION_SECRET must be configured and at least 32 characters long.");
  }
  const config: SessionConfig = {
    secret: secret.trim(),
    cookieName: env.SESSION_COOKIE_NAME || SESSION_COOKIE_NAME,
    maxAgeSeconds: Number(env.SESSION_MAX_AGE_SECONDS) || SESSION_MAX_AGE_SECONDS,
  };
  activeSecret = config.secret;
  return config;
}

export function getActiveSecret(): string {
  if (activeSecret) return activeSecret;
  const envSecret = process.env.SESSION_SECRET || process.env.AUTH_SECRET;
  if (envSecret && envSecret.trim().length >= 32) {
    activeSecret = envSecret.trim();
    return activeSecret;
  }
  throw new Error("Session secret is not configured. Provide SESSION_SECRET (at least 32 characters).");
}

export class UnauthorizedError extends Error {
  readonly statusCode = 401;
  readonly code = "unauthorized";

  constructor(message = "Authentication required.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export function hashPassword(password: string): string {
  return scryptSync(password, SALT, 64).toString("hex");
}

export function verifyPassword(password: string, expectedHash: string | null | undefined): boolean {
  if (!password || typeof password !== "string" || !expectedHash) {
    return false;
  }
  const computed = hashPassword(password);
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createSessionToken(employeeId: string, secret?: string): string {
  const signingKey = secret ?? getActiveSecret();
  const payload: SessionPayload = {
    employeeId,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", signingKey).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifySessionToken(token: string, secret?: string): SessionPayload | null {
  const signingKey = secret ?? getActiveSecret();
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;

  const expectedSignature = createHmac("sha256", signingKey).update(body).digest("base64url");
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof payload.employeeId !== "string" || typeof payload.exp !== "number") {
      return null;
    }
    if (Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

export function extractSessionEmployeeId(request: FastifyRequest, secret?: string): string | null {
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    const session = verifySessionToken(token, secret);
    if (session) return session.employeeId;
  }

  const cookieHeader = request.headers.cookie;
  const cookieToken = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
  if (cookieToken) {
    const session = verifySessionToken(cookieToken, secret);
    if (session) return session.employeeId;
  }

  return null;
}

export class EmployeeIdentity {
  constructor(
    readonly config: SessionConfig,
    private readonly companyKnowledge?: CompanyKnowledge,
  ) {
    configureAuth(config);
  }

  createSessionCookie(employeeId: string): string {
    const token = createSessionToken(employeeId, this.config.secret);
    const cookieName = this.config.cookieName ?? SESSION_COOKIE_NAME;
    const maxAge = this.config.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS;
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  }

  clearSessionCookie(): string {
    const cookieName = this.config.cookieName ?? SESSION_COOKIE_NAME;
    return `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  extractEmployeeId(request: FastifyRequest): string | null {
    return extractSessionEmployeeId(request, this.config.secret);
  }

  async requireEmployee(request: FastifyRequest): Promise<EmployeePersona> {
    const employeeId = this.extractEmployeeId(request);
    if (!employeeId) {
      throw new UnauthorizedError("Authentication required.");
    }
    if (this.companyKnowledge?.employee) {
      const persona = await this.companyKnowledge.employee(employeeId);
      if (!persona) {
        throw new UnauthorizedError("Authenticated employee not found in company directory.");
      }
      return persona;
    }
    return {
      employeeId,
      displayName: employeeId.charAt(0).toUpperCase() + employeeId.slice(1),
    };
  }

  async login(employeeId: string, password: string): Promise<{ employee: EmployeePersona; cookie: string }> {
    if (!employeeId || !password || typeof password !== "string") {
      throw new Error("Invalid credentials.");
    }
    if (!this.companyKnowledge?.verifyEmployeePassword) {
      throw new Error("Authentication provider not configured.");
    }
    const employee = await this.companyKnowledge.verifyEmployeePassword(employeeId, password);
    if (!employee) {
      throw new Error("Invalid credentials.");
    }
    const cookie = this.createSessionCookie(employee.employeeId);
    return { employee, cookie };
  }

  logout(): { cookie: string } {
    return { cookie: this.clearSessionCookie() };
  }
}
